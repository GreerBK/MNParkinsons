import { airtableFetch } from './airtable.js'

export const ACTIVITY_FIELDS = {
  name: 'Activity Name',
  location: 'Location',
  address: 'Address',
  activityType: 'Activity Type',
  intensity: 'Intensity',
  costCategory: 'Cost Category',
  format: 'Virtual/In-Person/Hybrid',
  daysOfWeek: 'Days of Week',
  status: 'Status',
}

const PUBLIC_FIELDS = [
  ...Object.values(ACTIVITY_FIELDS),
  'Activity Zip Code',
  'Schedule',
  'Cost',
  'Program Contact',
  'Program Email Address',
  'Site Phone #',
  'Registration Link',
  'Website',
  'Caregiver Friendly',
  'Description',
  'Additional Details',
  'Latitude',
  'Longitude',
  'Start Date',
  'End Date',
]

const ID_RE = /^rec[a-zA-Z0-9]{14,17}$/
const ACTIVE_FORMULA = "{Status} = 'Active'"

export function isActivityId(id) {
  return ID_RE.test(id)
}

export async function activityPage(env, { id, offset, fields = PUBLIC_FIELDS } = {}) {
  const url = new URL(`https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${env.AIRTABLE_TABLE_ID}`)
  // The only variable used in an Airtable formula is a fully validated ID.
  if (id && !isActivityId(id)) throw new Error('Invalid activity ID')
  url.searchParams.set('filterByFormula', id ? `AND(${ACTIVE_FORMULA}, RECORD_ID() = '${id}')` : ACTIVE_FORMULA)
  if (id) url.searchParams.set('maxRecords', '1')
  else url.searchParams.set('pageSize', '100')
  if (offset) url.searchParams.set('offset', offset)
  for (const field of fields) url.searchParams.append('fields[]', field)

  const init = { headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}` } }
  let response = await airtableFetch(env, url, init)
  if (response.status === 422) {
    const problem = await response.clone().json().catch(() => null)
    if (problem?.error?.type === 'UNKNOWN_FIELD_NAME') {
      // Optional display fields may differ on older bases. Project the
      // response locally even when a base cannot honor the full projection.
      url.searchParams.delete('fields[]')
      response = await airtableFetch(env, url, init)
    }
  }
  if (!response.ok) {
    const error = new Error('Could not read the activity database.')
    error.status = response.status
    error.retryAfter = response.headers.get('Retry-After')
    throw error
  }

  const data = await response.json()
  if (!Array.isArray(data?.records)) throw new Error('Invalid activity database response.')
  const records = data.records
    .filter(record => isActivityId(record?.id) && (!id || record.id === id) && record?.fields?.Status === 'Active')
    .map(record => {
      const projected = {}
      for (const name of fields) {
        if (Object.hasOwn(record.fields, name)) projected[name] = record.fields[name]
      }
      return { id: record.id, fields: projected }
    })
  return { records, offset: data.offset }
}
