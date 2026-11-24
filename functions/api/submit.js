// POST /api/submit — visitors suggest a new activity for the site.
// Writes a row to the "Submissions" review table. Nothing appears publicly
// until the row is approved in Airtable; the "Publish approved submission"
// automation then copies it into the Activities table.
//
// Requires AIRTABLE_WRITE_PAT (scopes: data.records:write on this base) in
// the Cloudflare Pages environment, same as /api/report.

import { airtableFetch } from '../_shared/airtable.js'
import { APPROVED_FILTER_OPTIONS, loadActivityChoices, submissionActivityTypes, SUBMISSIONS_TABLE_ID } from '../_shared/activity-schema.js'
import { airtableBusy, claimFormAttempt, readFormObject } from '../_shared/form-requests.js'
import { isDateOnly, isEventsType } from '../../src/activitySchedule.js'
import { isBareEmail, normalizeWebUrl, parseRegistrationLink } from '../../src/registrationLinks.js'

// Field names in the Submissions table — keep in sync if renamed in Airtable.
const F = {
  summary: 'Submission',
  status: 'Status',
  submitted: 'Submitted',
  name: 'Activity Name',
  types: 'Activity Type',
  suggestedType: 'Suggested Activity Type',
  intensity: 'Intensity',
  days: 'Days of Week',
  schedule: 'Schedule',
  location: 'Location',
  address: 'Address',
  zip: 'Activity Zip Code',
  format: 'Virtual/In-Person/Hybrid',
  costCategory: 'Cost Category',
  cost: 'Cost',
  description: 'Description',
  details: 'Additional Details',
  website: 'Website',
  registration: 'Registration Link',
  contact: 'Program Contact',
  email: 'Program Email Address',
  phone: 'Site Phone #',
  startDate: 'Start Date',
  endDate: 'End Date',
  submitterName: 'Submitter Name',
  submitterEmail: 'Submitter Email',
}

const ZIP_RE = /^\d{5}$/
// Control characters except tab (\t), newline (\n), carriage return (\r)
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g
const MAX_BODY_BYTES = 25000

const { format: FORMATS, intensity: INTENSITIES, daysOfWeek: DAYS, cost: COST_CATEGORIES } = APPROVED_FILTER_OPTIONS
const RATE_LIMIT_MAX = 50

const NO_STORE = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
const reply = (body, status = 200, headers) => Response.json(body, { status, headers: { ...NO_STORE, ...headers } })
const busy = retryAfter => reply(
  { error: 'The submission service is busy. Please try again shortly.' },
  503,
  { 'Retry-After': retryAfter || '30' },
)

function clean(value) {
  return typeof value === 'string' ? value.replace(CONTROL_CHARS_RE, '').trim() : ''
}

function cleanList(value) {
  return Array.isArray(value) ? [...new Set(value.map(clean).filter(Boolean))] : []
}

// Anything other than POST (Pages routes method-specific handlers first).
export function onRequest() {
  return reply({ error: 'Method not allowed' }, 405)
}

export async function onRequestPost(context) {
  const { request, env } = context
  const writePat = env.AIRTABLE_WRITE_PAT
  const baseId = env.AIRTABLE_BASE_ID

  if (!baseId) {
    return reply({ error: 'Server configuration error' }, 500)
  }

  const { data: body, tooLong } = await readFormObject(request, MAX_BODY_BYTES)
  if (tooLong) return reply({ error: 'Your submission is too long — please shorten the longer answers.' }, 413)
  if (!body) return reply({ error: 'Invalid request.' }, 400)

  // Honeypot: humans never see the "fax" field. If it's filled in, this is
  // a bot — pretend everything worked so it doesn't try harder.
  if (typeof body.fax === 'string' && body.fax.trim() !== '') {
    return reply({ ok: true }, 201)
  }

  // ── Required fields ──────────────────────────
  const name = clean(body.name).slice(0, 200)
  if (name.length < 2) {
    return reply({ error: 'Please give the activity a name.' }, 400)
  }

  const selectedTypes = cleanList(body.activityTypes)
  const suggestedType = clean(body.suggestedType).slice(0, 120)
  if (selectedTypes.length === 0 && !suggestedType) {
    return reply({ error: 'Please pick at least one activity type (or check "Other" and describe it).' }, 400)
  }

  const description = clean(body.description)
  if (description.length < 10) {
    return reply({ error: 'Please describe the activity in a sentence or two.' }, 400)
  }
  if (description.length > 5000) {
    return reply({ error: 'Please keep the description under 5000 characters.' }, 400)
  }

  const format = clean(body.format)
  if (!FORMATS.includes(format)) {
    return reply({ error: 'Please choose whether the activity is in-person or virtual.' }, 400)
  }

  const virtual = format === 'Virtual'
  const address = virtual ? '' : clean(body.address).slice(0, 500)
  const zip = virtual ? 'Virtual' : clean(body.zip)
  if (!virtual && zip && !ZIP_RE.test(zip)) {
    return reply({ error: 'That zip code does not look right — please use 5 digits (or leave it blank).' }, 400)
  }
  if (!virtual && !address && !zip) {
    return reply({ error: 'Please add an address or zip code so people can find the activity.' }, 400)
  }
  // ── Optional fields ──────────────────────────
  const intensity = cleanList(body.intensity).filter(v => INTENSITIES.includes(v))
  const days = cleanList(body.daysOfWeek).filter(v => DAYS.includes(v))

  const costCategory = clean(body.costCategory)
  if (costCategory && !COST_CATEGORIES.includes(costCategory)) {
    return reply({ error: 'Please choose a cost category from the list (or leave it blank).' }, 400)
  }

  const location = clean(body.location).slice(0, 200)
  const schedule = clean(body.schedule).slice(0, 1000)
  const details = clean(body.additionalDetails)
  if (details.length > 5000) {
    return reply({ error: 'Please keep the additional details under 5000 characters.' }, 400)
  }
  const cost = clean(body.cost).slice(0, 500)
  const contact = clean(body.contact).slice(0, 200)
  const phone = clean(body.phone).slice(0, 100)
  const submitterName = clean(body.submitterName).slice(0, 100)

  const websiteRaw = clean(body.website)
  const website = normalizeWebUrl(websiteRaw)
  if (websiteRaw && (!website || websiteRaw.length > 500)) {
    return reply({ error: 'That website link does not look right — please check it (or leave it blank).' }, 400)
  }
  const registrationRaw = clean(body.registrationLink)
  const registrationLink = parseRegistrationLink(registrationRaw)
  const registration = registrationLink.url || registrationLink.email
  if (registrationRaw && (!registration || registrationRaw.length > 500)) {
    return reply({ error: 'That registration link does not look right — please check it (or leave it blank).' }, 400)
  }

  const programEmail = clean(body.programEmail)
  if (programEmail && !isBareEmail(programEmail)) {
    return reply({ error: 'The program email address does not look right — please check it (or leave it blank).' }, 400)
  }
  const submitterEmail = clean(body.submitterEmail)
  if (submitterEmail && !isBareEmail(submitterEmail)) {
    return reply({ error: 'Your email address does not look right — please check it (or leave it blank).' }, 400)
  }

  const startDate = clean(body.startDate)
  const endDate = clean(body.endDate)
  if ((startDate && !isDateOnly(startDate)) || (endDate && !isDateOnly(endDate))) {
    return reply({ error: 'Those dates do not look right — please re-enter them (or leave them blank).' }, 400)
  }
  if (startDate && endDate && endDate < startDate) {
    return reply({ error: 'The end date is before the start date — please double-check them.' }, 400)
  }
  if (isEventsType(selectedTypes) && !startDate) {
    return reply({ error: 'Please add a start date for the event.' }, 400)
  }

  if (!writePat) {
    // The site works without the write token; submissions just aren't live yet.
    return reply({ error: 'Submissions are not set up yet. Please try again later.' }, 503)
  }

  const types = []
  if (selectedTypes.length) {
    const choices = submissionActivityTypes(await loadActivityChoices(context))
    for (const selected of selectedTypes) {
      const approved = choices.find(type => type.toLowerCase() === selected.toLowerCase())
      if (!approved) {
        return reply({ error: 'Please choose a listed activity type or use "Other" to suggest one.' }, 400)
      }
      if (!types.includes(approved)) types.push(approved)
    }
  }
  const permitted = await claimFormAttempt(context, 'submit', RATE_LIMIT_MAX)
  if (permitted === undefined) return busy('5')
  if (!permitted) {
    return reply(
      { error: "You've sent quite a few submissions recently. Please wait an hour and try again." },
      429,
      { 'Retry-After': '3600' },
    )
  }

  const now = new Date()
  const dateLabel = now.toLocaleDateString('en-US', { timeZone: 'America/Chicago' })

  const fields = {
    [F.summary]: `${name.slice(0, 80)} — ${dateLabel}`,
    [F.status]: 'New',
    [F.submitted]: now.toISOString(),
    [F.name]: name,
    [F.description]: description,
    [F.format]: format,
  }
  if (zip) fields[F.zip] = zip
  if (types.length) fields[F.types] = types
  if (suggestedType) fields[F.suggestedType] = suggestedType
  if (intensity.length) fields[F.intensity] = intensity
  if (days.length) fields[F.days] = days
  if (schedule) fields[F.schedule] = schedule
  if (location) fields[F.location] = location
  if (address) fields[F.address] = address
  if (costCategory) fields[F.costCategory] = costCategory
  if (cost) fields[F.cost] = cost
  if (details) fields[F.details] = details
  if (website) fields[F.website] = website
  if (registration) fields[F.registration] = registration
  if (contact) fields[F.contact] = contact
  if (programEmail) fields[F.email] = programEmail
  if (phone) fields[F.phone] = phone
  if (startDate) fields[F.startDate] = startDate
  if (endDate) fields[F.endDate] = endDate
  if (submitterName) fields[F.submitterName] = submitterName
  if (submitterEmail) fields[F.submitterEmail] = submitterEmail

  try {
    const res = await airtableFetch(env, `https://api.airtable.com/v0/${baseId}/${SUBMISSIONS_TABLE_ID}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${writePat}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ records: [{ fields }] }),
    })
    if (airtableBusy(res.status)) return busy(res.headers.get('Retry-After'))
    if (!res.ok) {
      return reply({ error: 'Could not save your submission. Please try again shortly.' }, 502)
    }
  } catch {
    return reply({ error: 'Could not save your submission. Please try again shortly.' }, 502)
  }

  return reply({ ok: true }, 201)
}
