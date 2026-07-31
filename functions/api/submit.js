// POST /api/submit — visitors suggest a new activity for the site.
// Writes a row to the "Submissions" review table. Nothing appears publicly
// until the row is approved in Airtable; the "Publish approved submission"
// automation then copies it into the Activities table.
//
// Requires AIRTABLE_WRITE_PAT (scopes: data.records:write on this base) in
// the Cloudflare Pages environment, same as /api/report.

const SUBMISSIONS_TABLE_ID = 'tbl1LU8FPRhVC7q5P' // "Submissions" table (not secret)

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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const ZIP_RE = /^\d{5}$/
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/
// Control characters except tab (\t), newline (\n), carriage return (\r)
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g
const MAX_BODY_BYTES = 25000

// Fixed option lists that essentially never change. Activity Type is NOT
// validated against a list — new types get added in Airtable over time, so
// the write below uses typecast and the review step vets anything unusual.
const FORMATS = ['In-Person', 'Virtual']
const INTENSITIES = ['Light', 'Moderate', 'High']
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const COST_CATEGORIES = ['Free', 'Paid', 'Free Trial', 'Fee']

// Best-effort per-IP throttle: max submissions per IP per rolling window.
// Uses the edge cache, so counts are per Cloudflare location and can evict
// early — a speed bump for abusive scripts, not a hard guarantee.
const RATE_LIMIT_MAX = 10
const RATE_LIMIT_WINDOW_S = 3600

const NO_STORE = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
const reply = (body, status = 200) => Response.json(body, { status, headers: NO_STORE })

// Strip control chars, collapse to a trimmed string.
function clean(value) {
  return String(value ?? '').replace(CONTROL_CHARS_RE, '').trim()
}

// Coerce to an array of cleaned, de-duplicated, non-empty strings.
function cleanList(value, maxItems, maxLen) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    const s = clean(item).slice(0, maxLen)
    if (s && !out.includes(s)) out.push(s)
    if (out.length >= maxItems) break
  }
  return out
}

// Accept "example.com" or "https://example.com/path"; reject other schemes
// and URLs with embedded credentials. Returns '' for blank, null for invalid.
function normalizeHttpUrl(raw) {
  const s = clean(raw)
  if (!s) return ''
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`)
    if (u.username || u.password) return null
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}

async function isRateLimited(request, context) {
  try {
    const ip = request.headers.get('CF-Connecting-IP')
    if (!ip) return false
    const cache = caches.default
    // Synthetic cache key — never fetched, just a per-IP counter slot.
    const key = new Request(`https://rate-limit.invalid/api/submit?ip=${encodeURIComponent(ip)}`)
    let count = 0
    let resetAt = Date.now() + RATE_LIMIT_WINDOW_S * 1000
    const hit = await cache.match(key)
    if (hit) {
      const data = await hit.json().catch(() => null)
      if (data && typeof data.count === 'number' && typeof data.resetAt === 'number' && data.resetAt > Date.now()) {
        count = data.count
        resetAt = data.resetAt
      }
    }
    if (count >= RATE_LIMIT_MAX) return true
    const ttl = Math.max(60, Math.ceil((resetAt - Date.now()) / 1000))
    const put = cache.put(
      key,
      new Response(JSON.stringify({ count: count + 1, resetAt }), {
        headers: { 'Cache-Control': `public, max-age=${ttl}` },
      })
    )
    if (context.waitUntil) context.waitUntil(put)
    else await put
    return false
  } catch {
    return false // cache unavailable (e.g. local dev) — don't block real people
  }
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

  // Parse and bound the body before trusting anything in it.
  let body
  try {
    const raw = await request.text()
    if (raw.length > MAX_BODY_BYTES) return reply({ error: 'Your submission is too long — please shorten the longer answers.' }, 400)
    body = JSON.parse(raw)
  } catch {
    return reply({ error: 'Invalid request.' }, 400)
  }
  // JSON.parse happily returns null/numbers/arrays — only objects are requests.
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return reply({ error: 'Invalid request.' }, 400)
  }

  // Honeypot: humans never see the "fax" field. If it's filled in, this is
  // a bot — pretend everything worked so it doesn't try harder.
  if (typeof body.fax === 'string' && body.fax.trim() !== '') {
    return reply({ ok: true }, 201)
  }

  if (await isRateLimited(request, context)) {
    return reply({ error: "You've sent quite a few submissions recently. Please wait an hour and try again." }, 429)
  }

  // ── Required fields ──────────────────────────
  const name = clean(body.name).slice(0, 200)
  if (name.length < 2) {
    return reply({ error: 'Please give the activity a name.' }, 400)
  }

  const types = cleanList(body.activityTypes, 10, 120)
  const suggestedType = clean(body.suggestedType).slice(0, 120)
  if (types.length === 0 && !suggestedType) {
    return reply({ error: 'Please pick at least one activity type, or describe it in the "something else" box.' }, 400)
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

  const address = clean(body.address).slice(0, 500)
  let zip = clean(body.zip)
  if (zip && !ZIP_RE.test(zip)) {
    return reply({ error: 'That zip code does not look right — please use 5 digits (or leave it blank).' }, 400)
  }
  if (format !== 'Virtual' && !address && !zip) {
    return reply({ error: 'Please add an address or zip code so people can find the activity.' }, 400)
  }
  // Site convention: online-only activities carry "Virtual" in the zip field.
  if (format === 'Virtual' && !zip) zip = 'Virtual'

  // ── Optional fields ──────────────────────────
  const intensity = cleanList(body.intensity, 3, 20).filter(v => INTENSITIES.includes(v))
  const days = cleanList(body.daysOfWeek, 7, 20).filter(v => DAYS.includes(v))

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

  const website = normalizeHttpUrl(body.website)
  if (website === null) {
    return reply({ error: 'That website link does not look right — please check it (or leave it blank).' }, 400)
  }
  // Registration is sometimes "email me to sign up" — allow an email address here too.
  const registrationRaw = clean(body.registrationLink).slice(0, 500)
  let registration = ''
  if (registrationRaw) {
    if (EMAIL_RE.test(registrationRaw.replace(/^mailto:/i, ''))) {
      registration = registrationRaw.replace(/^mailto:/i, '')
    } else {
      registration = normalizeHttpUrl(registrationRaw)
      if (registration === null) {
        return reply({ error: 'That registration link does not look right — please check it (or leave it blank).' }, 400)
      }
    }
  }

  const programEmail = clean(body.programEmail)
  if (programEmail && (programEmail.length > 254 || !EMAIL_RE.test(programEmail))) {
    return reply({ error: 'The program email address does not look right — please check it (or leave it blank).' }, 400)
  }
  const submitterEmail = clean(body.submitterEmail)
  if (submitterEmail && (submitterEmail.length > 254 || !EMAIL_RE.test(submitterEmail))) {
    return reply({ error: 'Your email address does not look right — please check it (or leave it blank).' }, 400)
  }

  const startDate = clean(body.startDate)
  const endDate = clean(body.endDate)
  if ((startDate && !YMD_RE.test(startDate)) || (endDate && !YMD_RE.test(endDate))) {
    return reply({ error: 'Those dates do not look right — please re-enter them (or leave them blank).' }, 400)
  }
  if (startDate && endDate && endDate < startDate) {
    return reply({ error: 'The end date is before the start date — please double-check them.' }, 400)
  }

  if (!writePat) {
    // The site works without the write token; submissions just aren't live yet.
    return reply({ error: 'Submissions are not set up yet. Please try again later.' }, 503)
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
    [F.zip]: zip,
  }
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
    const res = await fetch(`https://api.airtable.com/v0/${baseId}/${SUBMISSIONS_TABLE_ID}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${writePat}`,
        'Content-Type': 'application/json',
      },
      // typecast lets a new Activity Type choice through into the review
      // table (it only ever creates options there, never in Activities).
      body: JSON.stringify({ records: [{ fields }], typecast: true }),
    })
    if (!res.ok) {
      return reply({ error: 'Could not save your submission. Please try again shortly.' }, 502)
    }
  } catch {
    return reply({ error: 'Could not save your submission. Please try again shortly.' }, 502)
  }

  return reply({ ok: true }, 201)
}
