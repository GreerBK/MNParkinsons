const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const DAY = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday|tues|thurs|thur|mon|tue|wed|thu|fri|sat|sun'
const DAY_WORD = `\\b(?:${DAY})s?\\b`
const DAY_LIST = `${DAY_WORD}(?:\\s*(?:,|&|\\band\\b)\\s*${DAY_WORD})*`
const SESSION_SEPARATOR = String.raw`(?:\s*[:,]\s*|\s+)(?:at\s+)?`
const TIME = String.raw`(?:noon|midnight|(?:[01]?\d|2[0-3])(?::[0-5]\d)?\s*(?:[ap]\.?m\.?)?)`
const SESSION = new RegExp(`^${TIME}(?:\\s*(?:to|[-–—])\\s*${TIME})?$`, 'i')
const DAY_GROUP = new RegExp(`^(${DAY_LIST})${SESSION_SEPARATOR}(.+)$`, 'i')
const BARE_DAYS = new RegExp(`^${DAY_LIST}$`, 'i')
const AVAILABILITY_PREFIX = String.raw`(?:(?:classes?|(?:training )?sessions?)\s+(?:are (?:available|offered|held)|meet|run)\s+)?`
const DAY_RANGE = new RegExp(`^${AVAILABILITY_PREFIX}(${DAY_WORD})\\.?\\s*(?:to|through|thru|[-–—])\\s*(${DAY_WORD})\\.?(?:${SESSION_SEPARATOR}(.+))?$`, 'i')
const RECURRING_QUALIFIER = /\b(?:[1-5](?:st|nd|rd|th)|first|second|third|fourth|fifth|last|bi-?weekly|months?|monthly|every other|except|excluding)\b/i
const DAY_MS = 86_400_000
const CENTRAL_DATE = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
})

function weekday(value) {
  return WEEKDAYS.find(day => day.toLowerCase().startsWith(value.toLowerCase().slice(0, 3)))
}

function namedWeekdays(text) {
  return text.match(new RegExp(DAY_WORD, 'gi')).map(weekday)
}

export function isEventsType(value) {
  return (Array.isArray(value) ? value : [value]).some(type => String(type ?? '').trim().toLowerCase() === 'events')
}

export function isDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export function centralCalendarDate(date = new Date()) {
  const parts = Object.fromEntries(CENTRAL_DATE.formatToParts(date).map(({ type, value }) => [type, value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

// Format only schedules with explicit groups of days and plain times. The
// caller shows the original text if a range, qualifier, or note needs context.
export function parseWeeklySchedule(value) {
  const text = String(value ?? '').trim()
  if (!text || RECURRING_QUALIFIER.test(text)) return null
  const groups = []
  for (const chunk of text.split(/[;\n]+/).map(part => part.trim()).filter(Boolean)) {
    const entry = chunk.match(DAY_GROUP)
    const parts = (entry ? entry[2] : chunk).split(',').map(part => part.trim())
    if (!parts.every(part => SESSION.test(part) && /:|[ap]\.?m\.?|noon|midnight/i.test(part))) return null
    if (entry) {
      const names = namedWeekdays(entry[1])
      groups.push({ names, times: parts })
    } else {
      if (groups.length === 0) return null
      groups.at(-1).times.push(...parts)
    }
  }
  if (!groups.length) return null
  return groups.flatMap(({ names, times }) => names.map(day => ({ day, times })))
}

function inferRecurringWeekdays(schedule) {
  const text = String(schedule ?? '').trim()
  if (BARE_DAYS.test(text)) return namedWeekdays(text)
  const range = text.match(DAY_RANGE)
  // A date range in the middle of a note could describe office hours,
  // registration, or an exception. Only infer from a standalone range.
  if (range && (!range[3] || SESSION.test(range[3]))) {
    const start = WEEKDAYS.indexOf(weekday(range[1]))
    const end = WEEKDAYS.indexOf(weekday(range[2]))
    return Array.from({ length: (end - start + 7) % 7 + 1 }, (_, index) => WEEKDAYS[(start + index) % 7])
  }
  return (parseWeeklySchedule(text) || []).map(entry => entry.day)
}

export function getActivityWeekdays(fields, todayYMD) {
  if (isEventsType(fields['Activity Type'])) {
    const startDate = fields['Start Date']
    const endDate = fields['End Date'] || startDate
    if (!isDateOnly(startDate) || !isDateOnly(endDate) || endDate < startDate) return []
    const start = Math.max(Date.parse(startDate), isDateOnly(todayYMD) ? Date.parse(todayYMD) : -Infinity)
    const end = Date.parse(endDate)
    const days = []
    for (let day = start; day <= end && days.length < 7; day += DAY_MS) {
      days.push(WEEKDAYS[new Date(day).getUTCDay()])
    }
    return days
  }

  const rawDays = fields['Days of Week']
  const days = new Set((Array.isArray(rawDays) ? rawDays : String(rawDays ?? '').split(/[,;]/))
    .map(day => WEEKDAYS.find(name => name.toLowerCase() === String(day).trim().toLowerCase()))
    .filter(Boolean))
  for (const day of inferRecurringWeekdays(fields.Schedule)) days.add(day)
  return [...days]
}
