// POST /api/report — visitors flag an activity whose details are wrong.
// Writes a row to the "Reports" table linked to the activity record.
//
// Requires AIRTABLE_WRITE_PAT (scopes: data.records:write on this base) in
// the Cloudflare Pages environment. The main AIRTABLE_PAT stays read-only;
// only this endpoint and /api/submit ever write to Airtable.

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

const RECORD_ID_RE = /^rec[a-zA-Z0-9]{14,17}$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// Control characters except tab (\t), newline (\n), carriage return (\r)
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g
const MAX_BODY_BYTES = 10000
const MESSAGE_MIN = 5
const MESSAGE_MAX = 2000

const NO_STORE = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
const reply = (body, status = 200) => Response.json(body, { status, headers: NO_STORE })

// Anything other than POST (Pages routes method-specific handlers first).
export function onRequest() {
  return reply({ error: 'Method not allowed' }, 405)
}

export async function onRequestPost({ request, env }) {
  const readPat = env.AIRTABLE_PAT
  const writePat = env.AIRTABLE_WRITE_PAT
  const baseId = env.AIRTABLE_BASE_ID
  const activitiesTableId = env.AIRTABLE_TABLE_ID

  if (!readPat || !baseId || !activitiesTableId) {
    return reply({ error: 'Server configuration error' }, 500)
  }

  // Parse and bound the body before trusting anything in it.
  let body
  try {
    const raw = await request.text()
    if (raw.length > MAX_BODY_BYTES) return reply({ error: 'Report is too long.' }, 400)
    body = JSON.parse(raw)
  } catch {
    return reply({ error: 'Invalid request.' }, 400)
  }

  // Honeypot: humans never see the "website" field. If it's filled in, this
  // is a bot — pretend everything worked so it doesn't try harder.
  if (typeof body.website === 'string' && body.website.trim() !== '') {
    return reply({ ok: true }, 201)
  }

  const activityId = String(body.activityId || '')
  if (!RECORD_ID_RE.test(activityId)) return reply({ error: 'Invalid activity.' }, 400)

  // Strip control characters but keep tabs/newlines (multi-line notes are fine).
  const message = String(body.message || '').replace(CONTROL_CHARS_RE, '').trim()
  if (message.length < MESSAGE_MIN) {
    return reply({ error: 'Please tell us a little about what is wrong.' }, 400)
  }
  if (message.length > MESSAGE_MAX) {
    return reply({ error: `Please keep your note under ${MESSAGE_MAX} characters.` }, 400)
  }

  const email = String(body.email || '').trim()
  if (email && (email.length > 254 || !EMAIL_RE.test(email))) {
    return reply({ error: 'That email address does not look right — please check it (or leave it blank).' }, 400)
  }

  if (!writePat) {
    // The site works without the write token; reporting just isn't live yet.
    return reply({ error: 'Reporting is not set up yet. Please try again later.' }, 503)
  }

  // Confirm the activity really exists and is publicly listed before
  // accepting a report about it (also blocks spamming with made-up IDs).
  let activityName = ''
  try {
    const res = await fetch(
      `https://api.airtable.com/v0/${baseId}/${activitiesTableId}/${activityId}`,
      { headers: { Authorization: `Bearer ${readPat}` } }
    )
    if (!res.ok) return reply({ error: 'Activity not found.' }, 404)
    const record = await res.json()
    if (record?.fields?.['Status'] !== 'Active') return reply({ error: 'Activity not found.' }, 404)
    activityName = String(record?.fields?.['Activity Name'] || 'Unknown activity')
  } catch {
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
    const res = await fetch(`https://api.airtable.com/v0/${baseId}/${REPORTS_TABLE_ID}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${writePat}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ records: [{ fields }] }),
    })
    if (!res.ok) {
      return reply({ error: 'Could not save your report. Please try again shortly.' }, 502)
    }
  } catch {
    return reply({ error: 'Could not save your report. Please try again shortly.' }, 502)
  }

  return reply({ ok: true }, 201)
}
