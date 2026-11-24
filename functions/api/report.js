// POST /api/report — visitors flag an activity whose details are wrong.
// Writes a row to the "Reports" table linked to the activity record.
//
// Requires AIRTABLE_WRITE_PAT (scopes: data.records:write on this base) in
// the Cloudflare Pages environment. The main AIRTABLE_PAT stays read-only;
// only this endpoint and /api/submit ever write to Airtable.

import { airtableFetch } from '../_shared/airtable.js'
import { ACTIVITY_FIELDS, activityPage, isActivityId } from '../_shared/activity-records.js'
import { airtableBusy, claimFormAttempt, readFormObject } from '../_shared/form-requests.js'
import { isBareEmail } from '../../src/registrationLinks.js'

const REPORTS_TABLE_ID = 'tbltRoB20Pk8PJcFy' // "Reports" table (not secret)

// Field names in the Reports table — keep in sync if renamed in Airtable.
const F = {
  summary: 'Report',
  activity: 'Activity',
  message: "What's wrong",
  email: 'Reporter email',
  status: 'Status',
  pageUrl: 'Page URL',
  submitted: 'Submitted',
}

// Control characters except tab (\t), newline (\n), carriage return (\r)
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g
const MAX_BODY_BYTES = 10000
const MESSAGE_MIN = 5
const MESSAGE_MAX = 2000
const RATE_LIMIT_MAX = 10

const NO_STORE = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
const reply = (body, status = 200, headers) => Response.json(body, { status, headers: { ...NO_STORE, ...headers } })
const busy = retryAfter => reply(
  { error: 'The reporting service is busy. Please try again shortly.' },
  503,
  { 'Retry-After': retryAfter || '30' },
)

// Anything other than POST (Pages routes method-specific handlers first).
export function onRequest() {
  return reply({ error: 'Method not allowed' }, 405)
}

export async function onRequestPost(context) {
  const { request, env } = context
  const readPat = env.AIRTABLE_PAT
  const writePat = env.AIRTABLE_WRITE_PAT
  const baseId = env.AIRTABLE_BASE_ID
  const activitiesTableId = env.AIRTABLE_TABLE_ID

  if (!readPat || !baseId || !activitiesTableId) {
    return reply({ error: 'Server configuration error' }, 500)
  }

  const { data: body, tooLong } = await readFormObject(request, MAX_BODY_BYTES)
  if (tooLong) return reply({ error: 'Report is too long.' }, 413)
  if (!body) return reply({ error: 'Invalid request.' }, 400)

  // Honeypot: humans never see the "website" field. If it's filled in, this
  // is a bot — pretend everything worked so it doesn't try harder.
  if (typeof body.website === 'string' && body.website.trim() !== '') {
    return reply({ ok: true }, 201)
  }

  const activityId = body.activityId
  if (typeof activityId !== 'string' || !isActivityId(activityId)) return reply({ error: 'Invalid activity.' }, 400)

  // Strip control characters but keep tabs/newlines (multi-line notes are fine).
  const message = typeof body.message === 'string' ? body.message.replace(CONTROL_CHARS_RE, '').trim() : ''
  if (message.length < MESSAGE_MIN) {
    return reply({ error: 'Please tell us a little about what is wrong.' }, 400)
  }
  if (message.length > MESSAGE_MAX) {
    return reply({ error: `Please keep your note under ${MESSAGE_MAX} characters.` }, 400)
  }

  const email = typeof body.email === 'string' ? body.email.trim() : ''
  if ((body.email != null && typeof body.email !== 'string') || (email && !isBareEmail(email))) {
    return reply({ error: 'That email address does not look right — please check it (or leave it blank).' }, 400)
  }

  if (!writePat) {
    // The site works without the write token; reporting just isn't live yet.
    return reply({ error: 'Reporting is not set up yet. Please try again later.' }, 503)
  }
  const permitted = await claimFormAttempt(context, 'report', RATE_LIMIT_MAX)
  if (permitted === undefined) return busy('5')
  if (!permitted) {
    return reply(
      { error: "You've sent several reports recently. Please wait an hour and try again." },
      429,
      { 'Retry-After': '3600' },
    )
  }

  // Use a table-scoped search. Airtable's direct record lookup can also
  // find records in other tables in the same base.
  let activityName
  try {
    const { records } = await activityPage(env, {
      id: activityId,
      fields: [ACTIVITY_FIELDS.name, ACTIVITY_FIELDS.status],
    })
    if (!records.length) return reply({ error: 'Activity not found.' }, 404)
    activityName = String(records[0].fields[ACTIVITY_FIELDS.name] || 'Unknown activity')
  } catch (error) {
    if (airtableBusy(error.status)) return busy(error.retryAfter)
    return reply({ error: 'Could not reach the activity database. Please try again shortly.' }, 502)
  }

  const now = new Date()
  const dateLabel = now.toLocaleDateString('en-US', { timeZone: 'America/Chicago' })
  const pageUrl = `${new URL(request.url).origin}/#/activity/${activityId}`

  const fields = {
    [F.summary]: `${activityName.slice(0, 80)} — ${dateLabel}`,
    [F.activity]: [activityId],
    [F.message]: message,
    [F.status]: 'New',
    [F.pageUrl]: pageUrl,
    [F.submitted]: now.toISOString(),
  }
  if (email) fields[F.email] = email

  try {
    const res = await airtableFetch(env, `https://api.airtable.com/v0/${baseId}/${REPORTS_TABLE_ID}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${writePat}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ records: [{ fields }] }),
    })
    if (airtableBusy(res.status)) return busy(res.headers.get('Retry-After'))
    if (!res.ok) {
      return reply({ error: 'Could not save your report. Please try again shortly.' }, 502)
    }
  } catch {
    return reply({ error: 'Could not save your report. Please try again shortly.' }, 502)
  }

  return reply({ ok: true }, 201)
}
