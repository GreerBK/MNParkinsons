import { ACTIVITY_FIELDS as FIELDS } from './activity-records.js'
import { airtableFetch } from './airtable.js'

export const SUBMISSIONS_TABLE_ID = 'tbl1LU8FPRhVC7q5P'

// Fallback for deployment tokens without schema.bases:read. Airtable still
// enforces the destination field's actual choices on write.
export const APPROVED_FILTER_OPTIONS = {
  activityType: [
    'Aerobic', 'Ballroom Dance', 'Boxing', 'Cardio', 'Chair yoga', 'Cycling',
    'Dance', 'Drumming', 'Flexibility', 'General Movement', 'Indoor Rock Climbing',
    "Instructor's choice: coordination/balance/strength/cognitive activities/multitasking/elements of dance/rhythm",
    'Mind Body', 'Movement Boosters', 'Music', 'Nordic Walking', 'Personal Trainer',
    'Pickleball', 'Ping Pong', 'Singing', 'Tai Chi', 'Yoga', 'Support Group', 'Golf', 'Events',
  ],
  intensity: ['Light', 'Moderate', 'High'],
  cost: ['Free', 'Paid', 'Free Trial', 'Fee'],
  format: ['In-Person', 'Virtual'],
  daysOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
}

const SCHEMA_FIELDS = {
  activityType: FIELDS.activityType,
  intensity: FIELDS.intensity,
  cost: FIELDS.costCategory,
  format: FIELDS.format,
  daysOfWeek: FIELDS.daysOfWeek,
}
const CACHE_SECONDS = 600
let remembered

export function submissionActivityTypes(choices) {
  const activity = choices?.activityOptions?.activityType ?? APPROVED_FILTER_OPTIONS.activityType
  if (!choices?.submissionTypes) return activity
  const publicChoices = new Set(activity.map(choice => choice.toLowerCase()))
  return choices.submissionTypes.filter(choice => publicChoices.has(choice.toLowerCase()))
}

function getChoices(table, name) {
  const field = table?.fields?.find(f =>
    f.name === name && (f.type === 'singleSelect' || f.type === 'multipleSelects')
  )
  return field?.options?.choices?.map(choice => typeof choice === 'string' ? choice : choice?.name)
    .filter(choice => typeof choice === 'string' && choice)
    ?? null
}

export async function loadActivityChoices(context) {
  const { AIRTABLE_BASE_ID: base, AIRTABLE_PAT: pat, AIRTABLE_TABLE_ID: activityTable } = context.env
  if (!base || !pat || !activityTable) return null

  const key = `https://edge-cache.internal/activity-choices/v1/${base}/${activityTable}`
  if (remembered?.key === key && remembered.expires > Date.now()) return remembered.value

  let cache
  try {
    cache = caches.default
    const hit = await cache.match(new Request(key))
    if (hit) return await hit.json()
  } catch {
    cache = null
  }

  let value = null
  let seconds = 30
  try {
    const url = `https://api.airtable.com/v0/meta/bases/${base}/tables`
    const response = await airtableFetch(context.env, url, { headers: { Authorization: `Bearer ${pat}` } })
    if (response.ok) {
      const { tables } = await response.json()
      const activities = tables?.find(table => table.id === activityTable)
      const submissions = tables?.find(table => table.id === SUBMISSIONS_TABLE_ID)
      if (activities) {
        const activityOptions = Object.fromEntries(Object.entries(SCHEMA_FIELDS).map(([key, name]) => {
          const options = getChoices(activities, name)
          if (key === 'daysOfWeek' && options) {
            const days = APPROVED_FILTER_OPTIONS.daysOfWeek
            return [key, [...days.filter(day => options.includes(day)), ...options.filter(day => !days.includes(day)).sort()]]
          }
          return [key, options ?? APPROVED_FILTER_OPTIONS[key]]
        }))
        value = { activityOptions, submissionTypes: getChoices(submissions, FIELDS.activityType) }
        seconds = CACHE_SECONDS
      }
    }
  } catch {
    // The caller can provide fallback options when metadata is unavailable.
  }

  remembered = { key, value, expires: Date.now() + seconds * 1000 }
  if (value && cache) {
    const entry = Response.json(value, { headers: { 'Cache-Control': `public, max-age=${seconds}` } })
    const put = cache.put(new Request(key), entry).catch(() => {})
    if (context.waitUntil) context.waitUntil(put)
    else await put
  }
  return value
}
