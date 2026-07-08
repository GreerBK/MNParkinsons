import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import MN_ZIP_COORDS from './mnZipCoords'

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const LOCATIONIQ_KEY   = import.meta.env.VITE_LOCATIONIQ_KEY || '' // optional: free at locationiq.com, for zip→coords when Zippopotam is blocked

// ─────────────────────────────────────────────
// AIRTABLE — maps your exact field names
// ─────────────────────────────────────────────
const DATE_EPOCH_YMD = '1970-01-01'
const DATE_INFINITY_YMD = '9999-12-31'

function pad2(n) {
  return String(n).padStart(2, '0')
}

// Use local-date (not UTC) so "today between X and Y" behaves as humans expect.
function toLocalYMD(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function parseAirtableDateToYMD(raw) {
  if (raw == null || raw === '') return null
  const d = raw instanceof Date ? raw : new Date(raw)
  if (Number.isNaN(d.getTime())) return null
  return toLocalYMD(d)
}

function findDateFieldKey(fields, kind /* 'start' | 'end' */) {
  const entries = Object.keys(fields || {})
  const preferred = entries.find(k => {
    const kl = k.toLowerCase()
    if (!kl.includes(kind)) return false
    return /\bdate\b/i.test(k)
  })
  if (preferred) return preferred
  return entries.find(k => new RegExp(`\\b${kind}\\b`, 'i').test(k))
}

function extractStartEndYMD(fields) {
  const startKey = findDateFieldKey(fields, 'start')
  const endKey = findDateFieldKey(fields, 'end')
  const startDateYMD = parseAirtableDateToYMD(startKey ? fields[startKey] : null) || DATE_EPOCH_YMD
  const endDateYMD = parseAirtableDateToYMD(endKey ? fields[endKey] : null) || DATE_INFINITY_YMD
  return { startDateYMD, endDateYMD }
}

function getFieldValue(fields, candidateNames) {
  if (!fields) return ''
  for (const name of (candidateNames || [])) {
    if (name in fields) return fields[name]
  }
  const entries = Object.keys(fields)
  const norm = (s) => String(s || '').trim().toLowerCase()
  const wanted = new Set((candidateNames || []).map(norm).filter(Boolean))
  if (!wanted.size) return ''
  const key = entries.find(k => wanted.has(norm(k)))
  return key ? fields[key] : ''
}

function isActiveOnToday(activity, todayYMD) {
  const start = activity.startDateYMD || DATE_EPOCH_YMD
  const end = activity.endDateYMD || DATE_INFINITY_YMD
  if (start > end) return false
  return todayYMD >= start && todayYMD <= end
}

function normalizeDisplayName(name) {
  let s = String(name || '')
  if (!s) return ''
  // Fix common misspelling seen in source data.
  s = s.replace(/Excerise\s*\(\s*Exercise\s*\)/gi, 'Exercise')
  s = s.replace(/Excerise/gi, 'Exercise')
  // Remove redundant "(Exercise)" and stray trailing parens.
  s = s.replace(/\(\s*Exercise\s*\)/gi, '')
  s = s.replace(/\s*\)+\s*$/, '')
  s = s.replace(/\s{2,}/g, ' ').trim()
  return s
}

function mapRecord(record) {
  const f = record.fields || {}
  const { startDateYMD, endDateYMD } = extractStartEndYMD(f)
  const typeRaw = f['Activity Type']
  const daysRaw = f['Days of Week']
  const intensityRaw = f['Intensity']
  return {
    id:               record.id,
    name:             normalizeDisplayName(f['Activity Name'] || ''),
    type:             Array.isArray(typeRaw) ? typeRaw : (typeRaw ? [typeRaw] : []),
    location:         f['Location']               || '',
    address:          f['Address']                || '',
    zip:              String(f['Activity Zip Code'] || ''),
    format:           f['Virtual/In-Person/Hybrid'] || 'In-Person',
    schedule:         String(f['Schedule'] || '').trim(),
    daysOfWeek:       Array.isArray(daysRaw) ? daysRaw.join(', ') : (daysRaw ? String(daysRaw).trim() : ''),
    timeOfDay:        f['Time of Day']            || '',
    intensity:        Array.isArray(intensityRaw) ? intensityRaw.join(', ') : (intensityRaw ? String(intensityRaw).trim() : ''),
    costDisplay:      f['Cost']                   || '',
    costCategory:     f['Cost Category']          || '',
    contact:          f['Program Contact']        || '',
    email:            f['Program Email Address']  || '',
    phone:            [f['Site Phone #'], f['Phone Info']].filter(Boolean).join('; '),
    registrationLink: f['Registration Link']      || '',
    howToAttend:      f['How to Attend']          || '',
    website:          f['Website']                || '',
    caregiverFriendly:f['Caregiver Friendly']     || '',
    description:      f['Description']            || '',
    additionalDetails: String(f['Additional Details'] || '').trim(),
    status:           f['Status']                 || 'Active',
    lat:              (() => { const v = f['Latitude']; const n = parseFloat(v); return v != null && !isNaN(n) ? n : null })(),
    lng:              (() => { const v = f['Longitude']; const n = parseFloat(v); return v != null && !isNaN(n) ? n : null })(),
    emoji:            f['Emoji']                   || '',
    startDateYMD,
    endDateYMD,
  }
}

async function fetchActivities(filters = {}) {
  const arr = (v) => (Array.isArray(v) ? v : v ? [v] : [])
  const params = new URLSearchParams()
  if (filters.q) params.set('q', String(filters.q).trim())
  arr(filters.type).forEach(t => params.append('type', t))
  arr(filters.intensity).forEach(i => params.append('intensity', i))
  arr(filters.cost).forEach(c => params.append('cost', c))
  arr(filters.format).forEach(f => params.append('format', f))
  arr(filters.daysOfWeek).forEach(d => params.append('daysOfWeek', d))

  const res = await fetch(`/api/activities?${params}`)
  if (!res.ok) throw new Error(`Airtable error: ${res.status}`)
  const { records } = await res.json()

  let activities = records.map(mapRecord)
  // Only show records whose date-range includes "today".
  const todayYMD = toLocalYMD(new Date())
  activities = activities.filter(a => isActiveOnToday(a, todayYMD))

  // For activities missing lat/lng, try to derive coordinates from their zip code
  activities = activities.map(a => {
    if (a.lat && a.lng) return a
    const actZip = normalizeZip(a.zip)
    if (actZip && MN_ZIP_COORDS[actZip]) {
      return { ...a, lat: MN_ZIP_COORDS[actZip][0], lng: MN_ZIP_COORDS[actZip][1] }
    }
    return a
  })

  const zipRaw = filters.zip ? String(filters.zip).trim() : ''
  const zipValid = /^\d{5}$/.test(zipRaw)
  let center = filters.coords || null
  if (!center && zipValid) center = await getZipCoords(zipRaw)

  if (center) {
    activities = activities
      .map(a => ({
        ...a,
        dist: a.lat && a.lng ? haversine(center[0], center[1], a.lat, a.lng) : null
      }))
      .sort((a, b) => {
        // Activities with distance sort first, then those without
        if (a.dist == null && b.dist == null) return 0
        if (a.dist == null) return 1
        if (b.dist == null) return -1
        return a.dist - b.dist
      })
  }

  const maxMiles = filters.maxDistance != null && Number(filters.maxDistance) > 0 ? Number(filters.maxDistance) : null
  if (maxMiles != null && center) {
    activities = activities.filter(a => {
      // Keep activities without coordinates (virtual, or missing data) — don't silently drop them
      if (!a.lat || !a.lng) return a.format === 'Virtual'
      const d = a.dist ?? haversine(center[0], center[1], a.lat, a.lng)
      return d <= maxMiles
    })
  }

  // Without a location to sort by distance, fall back to a stable A→Z order
  // instead of whatever order Airtable returns.
  if (!center) {
    activities.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  }

  return activities
}

// The unfiltered catalog backs several screens (home categories, filter
// options, the activity count). Share one settled promise per session so
// navigating around doesn't refetch the same payload.
let catalogPromise = null
function fetchCatalog() {
  if (!catalogPromise) {
    catalogPromise = fetchActivities({}).catch(err => {
      catalogPromise = null // allow a retry after a failure
      throw err
    })
  }
  return catalogPromise
}

async function fetchActivityById(id) {
  const res = await fetch(`/api/activity/${encodeURIComponent(id)}`)
  if (!res.ok) throw new Error('Activity not found')
  const activity = mapRecord(await res.json())
  const todayYMD = toLocalYMD(new Date())
  return isActiveOnToday(activity, todayYMD) ? activity : null
}


async function fetchFilterOptionsFromSchema() {
  try {
    const res = await fetch('/api/filter-options')
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

// Derive filter options from activity records (fallback when schema API not available)
function deriveFilterOptionsFromActivities(activities) {
  const DAY_ORDER = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']
  const out = { activityType: [], intensity: [], cost: [], format: [], daysOfWeek: [] }
  const typeSet = new Set(), intensitySet = new Set(), costSet = new Set(), formatSet = new Set(), daysSet = new Set()
  activities.forEach(a => {
    if (a.type) (Array.isArray(a.type) ? a.type : [a.type]).forEach(t => t && typeSet.add(String(t).trim()))
    // Split multi-select values so we only show atomic options (Light, Moderate, Heavy), not "Light, Moderate, Heavy"
    if (a.intensity) String(a.intensity).split(/[,;]/).map(s => s.trim()).filter(Boolean).forEach(v => intensitySet.add(v))
    if (a.costCategory) costSet.add(String(a.costCategory).trim())
    if (a.format) formatSet.add(String(a.format).trim())
    if (a.daysOfWeek) String(a.daysOfWeek).split(/[,;]/).map(s => s.trim()).filter(Boolean).forEach(d => daysSet.add(d))
  })
  out.activityType = [...typeSet].sort()
  out.intensity = [...intensitySet].sort()
  out.cost = [...costSet].sort()
  out.daysOfWeek = [...daysSet].sort((a, b) => {
    const i = DAY_ORDER.indexOf(a); const j = DAY_ORDER.indexOf(b)
    if (i === -1 && j === -1) return a.localeCompare(b)
    if (i === -1) return 1; if (j === -1) return -1
    return i - j
  })
  out.format = [...formatSet].sort()
  return out
}

// Distance in miles between two lat/lng points
function haversine(lat1, lon1, lat2, lon2) {
  const R = 3958.8
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
}

// Normalize zip: trim and ensure 5 digits
function normalizeZip(zip) {
  const s = String(zip || '').trim()
  return /^\d{5}$/.test(s) ? s : ''
}

// One geocode call: user's zip → lat/lng. Uses local lookup table first, then
// external APIs as fallback for zips not in the table.
const zipCoordsCache = {}
async function getZipCoords(zip) {
  const z = normalizeZip(zip)
  if (!z) return null
  if (zipCoordsCache[z]) return zipCoordsCache[z]

  // Check local MN lookup table first (instant, no network call)
  if (MN_ZIP_COORDS[z]) {
    zipCoordsCache[z] = MN_ZIP_COORDS[z]
    return MN_ZIP_COORDS[z]
  }

  // Fallback: try Zippopotam.us
  try {
    const res = await fetch(`https://api.zippopotam.us/us/${z}`)
    if (res.ok) {
      const data = await res.json()
      const place = data.places?.[0]
      if (place) {
        const coords = [parseFloat(place.latitude), parseFloat(place.longitude)]
        zipCoordsCache[z] = coords
        return coords
      }
    }
  } catch (_) {}

  // Fallback: LocationIQ if key is set
  if (LOCATIONIQ_KEY) {
    try {
      const res = await fetch(
        `https://us1.locationiq.com/v1/search?key=${encodeURIComponent(LOCATIONIQ_KEY)}&q=${encodeURIComponent(z + ', USA')}&format=json&limit=1`
      )
      if (res.ok) {
        const data = await res.json()
        if (data?.[0]) {
          const coords = [parseFloat(data[0].lat), parseFloat(data[0].lon)]
          zipCoordsCache[z] = coords
          return coords
        }
      }
    } catch (_) {}
  }

  return null
}

function useUserLocation() {
  const [coords, setCoords] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const requestLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setError('Geolocation not supported')
      return
    }
    setLoading(true)
    setError(null)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoords([pos.coords.latitude, pos.coords.longitude])
        setLoading(false)
      },
      (err) => {
        setError(err.code === 1 ? 'Location permission denied' : 'Could not get location')
        setLoading(false)
      },
      { timeout: 10000 }
    )
  }, [])
  return { coords, loading, error, requestLocation }
}

// ─────────────────────────────────────────────
// HASH ROUTER
// ─────────────────────────────────────────────
function useRoute() {
  const [hash, setHash] = useState(window.location.hash || '#/')
  useEffect(() => {
    const handler = () => setHash(window.location.hash || '#/')
    window.addEventListener('hashchange', handler)
    return () => window.removeEventListener('hashchange', handler)
  }, [])
  return hash
}

function navigate(path) {
  window.location.hash = path
}

function parseHash(hash) {
  const [path, qs] = hash.replace('#', '').split('?')
  const params = new URLSearchParams(qs || '')
  return { path: path || '/', params }
}

// ─────────────────────────────────────────────
// ICONS (inline SVG — no dependency)
// ─────────────────────────────────────────────
// WCAG: screen reader indicator for links that open in a new tab
const ExtLink = () => <span className="sr-only"> (opens in new tab)</span>

function ensureHttpUrl(raw) {
  const value = String(raw || '').trim()
  if (!value) return ''
  if (/^(https?:\/\/|mailto:|tel:)/i.test(value)) return value
  return `https://${value}`
}

function isLikelyUrl(value) {
  const s = String(value || '').trim()
  if (!s) return false
  return /^https?:\/\//i.test(s) || /^www\./i.test(s) || /\.[a-z]{2,}(?:\/|$)/i.test(s)
}

function renderInstructionTextWithLinks(text) {
  const raw = String(text || '').trim()
  if (!raw) return null

  const markdownLinkRe = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi
  const plainUrlRe = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi
  const lines = raw.split(/\r?\n/)

  const renderLine = (line, keyPrefix) => {
    const nodes = []
    let idx = 0
    let m
    markdownLinkRe.lastIndex = 0
    while ((m = markdownLinkRe.exec(line)) !== null) {
      if (m.index > idx) nodes.push(line.slice(idx, m.index))
      const href = ensureHttpUrl(m[2])
      nodes.push(
        <a key={`${keyPrefix}-md-${m.index}`} href={href} target="_blank" rel="noopener noreferrer">
          {m[1]}<ExtLink />
        </a>
      )
      idx = m.index + m[0].length
    }
    const afterMarkdown = line.slice(idx)
    if (!afterMarkdown) return nodes

    let urlIdx = 0
    let um
    plainUrlRe.lastIndex = 0
    while ((um = plainUrlRe.exec(afterMarkdown)) !== null) {
      if (um.index > urlIdx) nodes.push(afterMarkdown.slice(urlIdx, um.index))
      const href = ensureHttpUrl(um[0])
      nodes.push(
        <a key={`${keyPrefix}-url-${um.index}`} href={href} target="_blank" rel="noopener noreferrer">
          {um[0]}<ExtLink />
        </a>
      )
      urlIdx = um.index + um[0].length
    }
    if (urlIdx < afterMarkdown.length) nodes.push(afterMarkdown.slice(urlIdx))
    return nodes
  }

  return lines.map((line, i) => (
    <p key={`attend-line-${i}`} className="attend-line">
      {renderLine(line, `attend-${i}`)}
    </p>
  ))
}

// ─────────────────────────────────────────────
// Detail-page helpers
// ─────────────────────────────────────────────

// Split possibly-multi-number phone text ("651-698-0751; 651-448-2545")
// into a deduped list of {display, href} entries. Strings without at least
// 7 digits are discarded as non-phones.
function splitPhones(raw) {
  const parts = String(raw || '')
    .split(/[;,|/]+|(?:\s{2,})/)
    .map(s => s.trim())
    .filter(Boolean)
  const seen = new Set()
  const out = []
  for (const part of parts) {
    const digits = part.replace(/\D+/g, '')
    if (digits.length < 7) continue
    const key = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
    if (seen.has(key)) continue
    seen.add(key)
    const tel = digits.length === 10 ? `+1${digits}` : (digits.startsWith('1') ? `+${digits}` : digits)
    out.push({ display: part, href: `tel:${tel}` })
  }
  return out
}

// Parse messy schedule text like "Tuesdays: 10-11 AM;6-7 PM ;Thursdays: 10-11"
// into [{day:'Tuesday', times:['10-11 AM','6-7 PM']}, ...]. Returns null if
// no day names found — caller should fall back to displaying raw text.
const DAY_NAME_MAP = {
  mon: 'Monday', monday: 'Monday',
  tue: 'Tuesday', tues: 'Tuesday', tuesday: 'Tuesday',
  wed: 'Wednesday', wednesday: 'Wednesday',
  thu: 'Thursday', thur: 'Thursday', thurs: 'Thursday', thursday: 'Thursday',
  fri: 'Friday', friday: 'Friday',
  sat: 'Saturday', saturday: 'Saturday',
  sun: 'Sunday', sunday: 'Sunday',
}
function parseSchedule(raw) {
  const text = String(raw || '').trim()
  if (!text) return null
  // Bail on non-weekly patterns ("1st and 3rd Tuesdays every month",
  // "2nd Friday of the month", "every other Wednesday", "biweekly").
  // The day-grid view assumes a weekly recurrence — for monthly or
  // alternating schedules we let the caller fall back to showing the
  // raw text intact, which preserves the full intent.
  if (
    /\b(1st|2nd|3rd|4th|5th)\b/i.test(text) ||
    /\b(biweekly|bi-weekly|monthly)\b/i.test(text) ||
    /\bevery other\b/i.test(text) ||
    /\bof the month\b/i.test(text)
  ) return null
  const dayRe = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tues|thurs|thur|mon|tue|wed|thu|fri|sat|sun)s?\b/gi
  const matches = []
  let m
  while ((m = dayRe.exec(text)) !== null) {
    matches.push({ stem: m[1].toLowerCase(), index: m.index, len: m[0].length })
  }
  if (matches.length === 0) return null
  const groups = []
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index + matches[i].len
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length
    const chunk = text.slice(start, end).replace(/^[\s:,&\-–—]+|[\s:,&\-–—]+$/g, '')
    const times = chunk
      .split(/[;,]+/)
      .map(s => s.trim())
      .filter(s => s && /\d/.test(s))
    groups.push({ day: DAY_NAME_MAP[matches[i].stem] || matches[i].stem, times })
  }
  // Merge consecutive entries for the same day
  const merged = []
  for (const g of groups) {
    const last = merged[merged.length - 1]
    if (last && last.day === g.day) last.times.push(...g.times)
    else merged.push({ day: g.day, times: [...g.times] })
  }
  // Backfill empty time slots from the next group (handles "Mon, Wed, Fri: 9AM")
  for (let i = merged.length - 2; i >= 0; i--) {
    if (merged[i].times.length === 0) {
      for (let j = i + 1; j < merged.length; j++) {
        if (merged[j].times.length > 0) {
          merged[i].times = [...merged[j].times]
          break
        }
      }
    }
  }
  return merged
}

// "https://www.example.com/some/path?x=1" → "example.com"
function getDisplayDomain(url) {
  try {
    const u = new URL(String(url || '').startsWith('http') ? url : `https://${url}`)
    return u.hostname.replace(/^www\./, '')
  } catch {
    return String(url || '')
  }
}

// Returns a safe https URL or null. Prevents javascript: and other unsafe schemes.
function safeHttpUrl(raw) {
  const s = String(raw || '').trim()
  if (!s) return null
  try {
    const u = new URL(s.startsWith('http') ? s : `https://${s}`)
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null
  } catch {
    return null
  }
}

const Icon = {
  search: () => (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  ),
  pin: () => (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  ),
  clock: () => (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  ),
  dollar: () => (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <line x1="12" y1="2" x2="12" y2="22" />
      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </svg>
  ),
  bolt: () => (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  ),
  back: () => (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m12 19-7-7 7-7" />
      <path d="M19 12H5" />
    </svg>
  ),
  phone: () => (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.87 12.26 19.79 19.79 0 0 1 1.81 3.67 2 2 0 0 1 3.78 1.5h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.77-1.77a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  ),
  mail: () => (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect width="20" height="16" x="2" y="4" rx="2" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </svg>
  ),
  link: () => (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  ),
  location: () => (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  ),
  pause: () => (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="6" y="4" width="4" height="16" rx="1" />
      <rect x="14" y="4" width="4" height="16" rx="1" />
    </svg>
  ),
  play: () => (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      aria-hidden="true"
      focusable="false"
    >
      <polygon points="6 3 20 12 6 21 6 3" />
    </svg>
  ),
  share: () => (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
    </svg>
  ),
  printer: () => (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <polyline points="6 9 6 2 18 2 18 9" />
      <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
      <rect x="6" y="14" width="12" height="8" />
    </svg>
  ),
  flag: () => (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
      <line x1="4" y1="22" x2="4" y2="15" />
    </svg>
  ),
}

// Auto-match category names to emojis via keyword matching
// Works with any category from Airtable — no hardcoding needed
const EMOJI_KEYWORDS = [
  [/box/i, '🥊'], [/yoga/i, '🧘'], [/exercis|workout|fitness|gym/i, '🏋️'],
  [/support|group|community/i, '🤝'], [/danc/i, '💃'], [/cycl|bik/i, '🚴'],
  [/swim|aqua|pool|water/i, '🏊'], [/walk|hik/i, '🚶'], [/tai.?chi|qigong/i, '🧎'],
  [/pilates|stretch/i, '🤸'], [/music|sing|choir/i, '🎵'], [/art|paint|craft/i, '🎨'],
  [/speech|voice|talk/i, '🗣️'], [/meditat|mindful/i, '🧠'], [/garden/i, '🌱'],
  [/row/i, '🚣'], [/climb/i, '🧗'], [/run|jog/i, '🏃'], [/martial|karate|judo/i, '🥋'],
  [/tennis|racquet|pickleball/i, '🎾'], [/golf/i, '⛳'], [/horse|equine|equestrian/i, '🐴'],
  [/cook|nutrition|food/i, '🍳'], [/read|book/i, '📚'], [/tech|computer/i, '💻'],
  [/game|play/i, '🎲'], [/photo/i, '📷'], [/volunt/i, '❤️'], [/social|meet/i, '👋'],
]
function getCategoryEmoji(name) {
  for (const [pattern, emoji] of EMOJI_KEYWORDS) {
    if (pattern.test(name)) return emoji
  }
  return '✨' // friendly fallback for unmatched categories
}

function ScrollToTop() {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > 400)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])
  return (
    <button
      className={`scroll-top ${visible ? 'visible' : ''}`}
      onClick={() => window.scrollTo({
        top: 0,
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      })}
      aria-label="Scroll to top"
      tabIndex={visible ? 0 : -1}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6"/></svg>
    </button>
  )
}

// ─────────────────────────────────────────────
// NAV
// ─────────────────────────────────────────────
function Nav() {
  // Use anchor tags (semantically correct for navigation) and mark the active
  // page with aria-current="page" so screen readers announce "you are here".
  const hash = useRoute()
  const { path } = parseHash(hash)
  const onHome = path === '/' || path === ''
  const onSearch = path === '/search'
  return (
    <nav aria-label="Main site navigation">
      <div className="nav-inner">
        <a
          href="#/"
          className="nav-logo"
          aria-label="MN Parkinson's Connect home"
          aria-current={onHome ? 'page' : undefined}
        >
          MN <span>Parkinson's Connect</span>
        </a>
        <a
          href="#/search"
          className="btn btn-outline nav-cta"
          aria-current={onSearch ? 'page' : undefined}
        >
          Find activities near you
        </a>
      </div>
    </nav>
  )
}

// ─────────────────────────────────────────────
// HOME PAGE
// ─────────────────────────────────────────────

// Ambient hero video. Mounting waits for the window 'load' event so the
// ~8 MB file never competes with fonts, scripts, or activity data — the
// gradient backdrop shows until then. Skipped entirely for visitors with
// data-saver enabled (the caller already skips it for reduced motion).
function HeroVideo() {
  const [ready, setReady] = useState(() => document.readyState === 'complete')
  const [paused, setPaused] = useState(false)
  const videoRef = useRef(null)

  useEffect(() => {
    if (ready) return
    const onLoad = () => setReady(true)
    window.addEventListener('load', onLoad)
    if (document.readyState === 'complete') setReady(true)
    return () => window.removeEventListener('load', onLoad)
  }, [ready])

  if (!ready || navigator.connection?.saveData) return null

  const toggle = () => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) {
      v.play().catch(() => {})
      setPaused(false)
    } else {
      v.pause()
      setPaused(true)
    }
  }

  return (
    <>
      <div className="hero-video" aria-hidden="true">
        <video
          ref={videoRef}
          src="/serene.mp4"
          autoPlay
          muted
          loop
          playsInline
          disablePictureInPicture
          onCanPlay={e => e.currentTarget.classList.add('can-play')}
        />
      </div>
      <div className="hero-overlay" aria-hidden="true" />
      {/* WCAG 2.2.2 — auto-playing motion needs a visible way to stop it */}
      <button
        type="button"
        className="hero-video-toggle"
        onClick={toggle}
        aria-label={paused ? 'Play background video' : 'Pause background video'}
      >
        {paused ? <Icon.play /> : <Icon.pause />}
      </button>
    </>
  )
}

function Home() {
  const [zip, setZip] = useState('')
  const [types, setTypes] = useState([])
  const [typeEmojis, setTypeEmojis] = useState({})
  const [activityCount, setActivityCount] = useState(null)
  const { coords: userCoords, loading: locLoading, error: locError, requestLocation } = useUserLocation()
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false
  )

  // When user allows location on home, go straight to search with "near you"
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const handleChange = () => setPrefersReducedMotion(media.matches)
    handleChange()
    media.addEventListener('change', handleChange)
    return () => media.removeEventListener('change', handleChange)
  }, [])

  useEffect(() => {
    if (!userCoords) return
    const p = new URLSearchParams()
    p.set('lat', String(userCoords[0]))
    p.set('lng', String(userCoords[1]))
    p.set('distance', '50')
    navigate(`#/search?${p.toString()}`)
  }, [userCoords])

  useEffect(() => {
    fetchCatalog().then(acts => {
      const seen = new Set()
      const emojis = {}
      acts.forEach(a => {
        if (!a.type) return
        const list = Array.isArray(a.type) ? a.type : [a.type]
        list.forEach(t => {
          if (!t) return
          const name = String(t).trim()
          seen.add(name)
          // First non-empty Airtable emoji wins for each type
          if (a.emoji && !emojis[name]) emojis[name] = a.emoji
        })
      })
      setTypes([...seen].sort())
      setTypeEmojis(emojis)
      setActivityCount(acts.length)
    }).catch(() => {})
  }, [])

  const handleSearch = (e) => {
    e.preventDefault()
    const p = new URLSearchParams()
    if (userCoords) {
      p.set('lat', String(userCoords[0]))
      p.set('lng', String(userCoords[1]))
      p.set('distance', '50')
    } else {
      const zipValid = normalizeZip(zip)
      if (zipValid) p.set('zip', zipValid)
    }
    navigate(`#/search?${p.toString()}`)
  }

  return (
    <div>
      <section className="hero">
        {!prefersReducedMotion && <HeroVideo />}
        <div className="hero-content">
          <div className="hero-eyebrow">Helping you connect with community</div>
          <h1>Find Your <em>Community</em> in Minnesota</h1>
          <p>Connecting people with Parkinson's and their caregivers to local activities, support groups, and resources across the state.</p>

          <form className="search-box" onSubmit={handleSearch}>
          <label className="sr-only" htmlFor="home-zip">
            Zip code
          </label>
          <input
            id="home-zip"
            className="zip-input"
            type="text"
            inputMode="numeric"
            pattern="\d*"
            placeholder="Zip Code"
            autoComplete="postal-code"
            value={zip}
            onChange={e => setZip(e.target.value)}
            maxLength={5}
          />
          <button
            type="button"
            onClick={requestLocation}
            disabled={locLoading}
            className="btn-loc"
            aria-describedby={locError ? 'home-loc-error' : undefined}
          >
            <span className="btn-loc-icon" aria-hidden="true">{locLoading ? <span className="btn-loc-spinner" /> : <Icon.location />}</span>
            <span className="btn-loc-label">{locLoading ? 'Locating…' : 'Use my location'}</span>
          </button>
          {locError && (
            <span id="home-loc-error" className="loc-error" role="alert">
              {locError}
            </span>
          )}
          <button type="submit" className="btn btn-primary">Search</button>
        </form>
        </div>
      </section>

      <section className="categories container">
        <h2>Browse by Category</h2>
        {activityCount > 0 && (
          <p className="categories-sub">{activityCount} {activityCount === 1 ? 'activity' : 'activities'} across Minnesota</p>
        )}
        {types.length > 0 ? (
          <div className="cat-grid">
            {types.map(type => (
              <button
                type="button"
                key={type}
                className="cat-card"
                aria-label={`Find ${type} activities`}
                onClick={() => navigate(`#/search?type=${encodeURIComponent(type)}`)}
              >
                <span className="cat-card-icon" aria-hidden="true">{typeEmojis[type] || getCategoryEmoji(type)}</span>
                {type}
              </button>
            ))}
          </div>
        ) : (
          <div className="state-msg" role="status"><div className="spinner" aria-hidden="true" /><p>Loading categories…</p></div>
        )}
      </section>

      <footer>
        <strong>MN Parkinson's Connect</strong> — Helping you connect with community.<br />
        {/* TODO: add a real contact email here when one is set up */}
        <span style={{marginTop:'0.5rem',display:'inline-block',opacity:0.9}}>Powered by <a href="https://technextdoormn.com" target="_blank" rel="noopener noreferrer" style={{color:'#b8ccab'}}>Tech Next Door MN<ExtLink /></a></span>
      </footer>
    </div>
  )
}

// ─────────────────────────────────────────────
// SEARCH RESULTS PAGE
// ─────────────────────────────────────────────
const DISTANCE_MIN = 5
const DISTANCE_MAX = 100
const DISTANCE_DEFAULT = 50
const DISTANCE_QUICK = [5, 10, 25, 50, 100] // quick-select buttons

function paramToArray(val) {
  if (!val || typeof val !== 'string') return []
  return val.split(',').map(s => s.trim()).filter(Boolean)
}

const EMPTY_FILTER_OPTIONS = { activityType: [], intensity: [], cost: [], format: [], daysOfWeek: [] }

// Default options so sidebar always shows full lists even when initial results are filtered (e.g. from home page by activity type)
const DEFAULT_FILTER_OPTIONS = {
  activityType: ['Boxing', 'Yoga', 'Support Group', 'Exercise'],
  intensity: ['Light', 'Moderate', 'Heavy'],
  cost: ['Free', 'Fee', 'Free Trial'],
  format: ['In-Person', 'Virtual'],
  daysOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
}
const WEEKDAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

function unionSortedStrings(...lists) {
  const merged = [...new Set(lists.flat().filter(Boolean).map(s => String(s).trim()).filter(Boolean))]
  return merged.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
}

function unionDaysOfWeek(...lists) {
  const merged = [...new Set(lists.flat().filter(Boolean).map(s => String(s).trim()).filter(Boolean))]
  return merged.sort((a, b) => {
    const i = WEEKDAY_ORDER.indexOf(a)
    const j = WEEKDAY_ORDER.indexOf(b)
    if (i === -1 && j === -1) return a.localeCompare(b)
    if (i === -1) return 1
    if (j === -1) return -1
    return i - j
  })
}

function toggleMulti(arr, item) {
  if (arr.includes(item)) return arr.filter(x => x !== item)
  return [...arr, item]
}

/** Checkbox filter group; shows `initialVisible` options then "View more" for the rest (selected values outside the first chunk stay visible). */
function FilterGroupMulti({ title, options, value, onChange, initialVisible = 6 }) {
  const [expanded, setExpanded] = useState(false)

  const displayedOptions = useMemo(() => {
    if (!options?.length) return []
    if (expanded || options.length <= initialVisible) return options
    const head = new Set(options.slice(0, initialVisible))
    const extraSelected = value.filter(v => options.includes(v) && !head.has(v))
    const show = new Set([...head, ...extraSelected])
    return options.filter(o => show.has(o))
  }, [options, value, expanded, initialVisible])

  const hiddenCount = useMemo(() => {
    if (expanded || !options?.length) return 0
    return options.filter(o => !displayedOptions.includes(o)).length
  }, [options, displayedOptions, expanded])

  return (
    <fieldset className="filter-group">
      <legend className="filter-title">{title}</legend>
      {displayedOptions.map(opt => (
        <label key={opt} className="filter-option">
          <input
            type="checkbox"
            checked={value.includes(opt)}
            onChange={() => onChange(toggleMulti(value, opt))}
          />
          {opt}
        </label>
      ))}
      {!expanded && hiddenCount > 0 && (
        <button
          type="button"
          className="filter-view-more"
          onClick={() => setExpanded(true)}
        >
          View more ({hiddenCount})
        </button>
      )}
      {expanded && options.length > initialVisible && (
        <button
          type="button"
          className="filter-view-more"
          onClick={() => setExpanded(false)}
        >
          Show less
        </button>
      )}
    </fieldset>
  )
}

function SearchResults({ params }) {
  const [activities, setActivities] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [filterOptions, setFilterOptions] = useState(EMPTY_FILTER_OPTIONS)
  const [showFilters, setShowFilters] = useState(false)
  const { coords: userCoords, loading: locLoading, error: locError, requestLocation } = useUserLocation()

  // filter state (multi-select as arrays)
  const [q, setQ] = useState(params.get('q') || '')
  const [zip, setZip] = useState((params.get('zip') || '').trim())
  const [selType, setSelType] = useState(paramToArray(params.get('type')))
  const [selIntensity, setSelIntensity] = useState(paramToArray(params.get('intensity')))
  const [selCost, setSelCost] = useState(paramToArray(params.get('cost')))
  const [selFormat, setSelFormat] = useState(paramToArray(params.get('format')))
  const [selDays, setSelDays] = useState(paramToArray(params.get('days')))
  const [maxDistance, setMaxDistance] = useState(() => {
    const d = params.get('distance')
    const n = Number(d)
    if (d != null && !isNaN(n) && n >= DISTANCE_MIN && n <= DISTANCE_MAX) return n
    return (params.get('zip') || params.get('lat')) ? DISTANCE_DEFAULT : null
  })

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const typeParam = params.get('type')
      const intensityParam = params.get('intensity')
      const costParam = params.get('cost')
      const formatParam = params.get('format')
      const daysParam = params.get('days')
      const zipParam = normalizeZip(params.get('zip')) || undefined
      const latP = params.get('lat')
      const lngP = params.get('lng')
      const coordsFromUrl = (latP != null && lngP != null) ? (() => {
        const a = parseFloat(latP)
        const b = parseFloat(lngP)
        return (!isNaN(a) && !isNaN(b)) ? [a, b] : null
      })() : null
      const coords = userCoords || coordsFromUrl
      const hasLocation = zipParam || coords
      const data = await fetchActivities({
        q: params.get('q') || undefined,
        zip: zipParam,
        coords: coords || undefined,
        type: typeParam ? paramToArray(typeParam) : undefined,
        intensity: intensityParam ? paramToArray(intensityParam) : undefined,
        cost: costParam ? paramToArray(costParam) : undefined,
        format: formatParam ? paramToArray(formatParam) : undefined,
        daysOfWeek: daysParam ? paramToArray(daysParam) : undefined,
        maxDistance: params.get('distance') ? Number(params.get('distance')) : (hasLocation ? DISTANCE_DEFAULT : undefined),
      })
      setActivities(data)
    } catch(e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [params.toString(), userCoords?.join(',')])

  useEffect(() => { load() }, [load])

  // Full catalog (ignores URL filters) so filter checklists always list every activity type / option,
  // not only values present in the current filtered result set.
  useEffect(() => {
    let cancelled = false
    fetchCatalog()
      .then(acts => {
        if (cancelled) return
        const derived = deriveFilterOptionsFromActivities(acts)
        setFilterOptions(prev => ({
          activityType: unionSortedStrings(derived.activityType, prev.activityType, DEFAULT_FILTER_OPTIONS.activityType),
          intensity: unionSortedStrings(derived.intensity, prev.intensity, DEFAULT_FILTER_OPTIONS.intensity),
          cost: unionSortedStrings(derived.cost, prev.cost, DEFAULT_FILTER_OPTIONS.cost),
          format: unionSortedStrings(derived.format, prev.format, DEFAULT_FILTER_OPTIONS.format),
          daysOfWeek: unionDaysOfWeek(derived.daysOfWeek, prev.daysOfWeek, DEFAULT_FILTER_OPTIONS.daysOfWeek),
        }))
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  // Fetch filter options from Airtable schema once on mount (PAT may need schema.bases:read scope).
  // Union with record-derived lists so select fields stay complete.
  useEffect(() => {
    fetchFilterOptionsFromSchema().then(opts => {
      if (!opts) return
      setFilterOptions(prev => ({
        activityType: unionSortedStrings(opts.activityType, prev.activityType),
        intensity: unionSortedStrings(opts.intensity, prev.intensity),
        cost: unionSortedStrings(opts.cost, prev.cost),
        format: unionSortedStrings(opts.format, prev.format),
        daysOfWeek: unionDaysOfWeek(opts.daysOfWeek, prev.daysOfWeek),
      }))
    })
  }, [])

  // Sync local filter state from URL when params change (e.g. after Apply or shared link)
  useEffect(() => {
    setQ(params.get('q') || '')
    setZip((params.get('zip') || '').trim())
    setSelType(paramToArray(params.get('type')))
    setSelIntensity(paramToArray(params.get('intensity')))
    setSelCost(paramToArray(params.get('cost')))
    setSelFormat(paramToArray(params.get('format')))
    setSelDays(paramToArray(params.get('days')))
    const d = params.get('distance')
    const n = Number(d)
    const hasLocation = params.get('zip') || params.get('lat')
    setMaxDistance(hasLocation ? (d != null && !isNaN(n) && n >= DISTANCE_MIN && n <= DISTANCE_MAX ? n : DISTANCE_DEFAULT) : null)
  }, [params.toString()])

  const applyFilters = (closePanel = true) => {
    const p = new URLSearchParams()
    const zipTrimmed = (zip && String(zip).trim()) || ''
    const zipValid = normalizeZip(zipTrimmed)
    const qTrimmed = (q && String(q).trim()) || ''
    if (qTrimmed) p.set('q', qTrimmed)
    if (userCoords) {
      p.set('lat', String(userCoords[0]))
      p.set('lng', String(userCoords[1]))
      p.set('distance', String(maxDistance ?? DISTANCE_DEFAULT))
    } else {
      if (zipValid) p.set('zip', zipValid)
      if (maxDistance != null && zipValid) p.set('distance', String(maxDistance))
    }
    if (selType.length) p.set('type', selType.join(','))
    if (selIntensity.length) p.set('intensity', selIntensity.join(','))
    if (selCost.length) p.set('cost', selCost.join(','))
    if (selFormat.length) p.set('format', selFormat.join(','))
    if (selDays.length) p.set('days', selDays.join(','))
    navigate(`#/search?${p.toString()}`)
    if (closePanel) setShowFilters(false)
  }

  // Auto-apply when checkbox filters change (results update immediately)
  const didMountFilters = useRef(false)
  useEffect(() => {
    if (!didMountFilters.current) {
      didMountFilters.current = true
      return
    }
    applyFilters(false)
  }, [selType, selIntensity, selCost, selFormat, selDays])

  // Auto-apply distance changes with debounce so slider dragging isn't disrupted
  const didMountDistance = useRef(false)
  const distanceDebounceRef = useRef(null)
  useEffect(() => {
    if (!didMountDistance.current) {
      didMountDistance.current = true
      return
    }
    if (distanceDebounceRef.current) clearTimeout(distanceDebounceRef.current)
    distanceDebounceRef.current = setTimeout(() => {
      applyFilters(false)
      distanceDebounceRef.current = null
    }, 400)
    return () => {
      if (distanceDebounceRef.current) clearTimeout(distanceDebounceRef.current)
    }
  }, [maxDistance])

  // Auto-apply when keyword search or zip change (debounced so we don't navigate on every keystroke).
  // Scroll containment for the sidebar is handled by `overscroll-behavior` in CSS.
  const didMountSearch = useRef(false)
  const debounceRef = useRef(null)
  useEffect(() => {
    if (!didMountSearch.current) {
      didMountSearch.current = true
      return
    }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      applyFilters(false)
      debounceRef.current = null
    }, 400)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [zip, q])

  const clearFilters = () => {
    setSelType([]); setSelIntensity([]); setSelCost([])
    setSelFormat([]); setSelDays([]); setZip(''); setQ('')
    setMaxDistance((params.get('zip') || params.get('lat')) ? DISTANCE_DEFAULT : null)
    const keep = new URLSearchParams()
    if (params.get('zip')) keep.set('zip', params.get('zip'))
    else if (params.get('lat') && params.get('lng')) {
      keep.set('lat', params.get('lat'))
      keep.set('lng', params.get('lng'))
      keep.set('distance', params.get('distance') || String(DISTANCE_DEFAULT))
    }
    navigate('#/search' + (keep.toString() ? `?${keep.toString()}` : ''))
  }

  const activeFilterCount = selType.length + selIntensity.length + selCost.length + selFormat.length + selDays.length

  // Build list of active filter chips for display above results
  const activeChips = [
    ...selType.map(v => ({ label: v, remove: () => setSelType(selType.filter(x => x !== v)) })),
    ...selIntensity.map(v => ({ label: v, remove: () => setSelIntensity(selIntensity.filter(x => x !== v)) })),
    ...selCost.map(v => ({ label: v, remove: () => setSelCost(selCost.filter(x => x !== v)) })),
    ...selFormat.map(v => ({ label: v, remove: () => setSelFormat(selFormat.filter(x => x !== v)) })),
    ...selDays.map(v => ({ label: v, remove: () => setSelDays(selDays.filter(x => x !== v)) })),
  ]

  return (
    <div>
      <div className="search-header">
        <form
          className="search-header-inner"
          role="search"
          onSubmit={(e) => { e.preventDefault(); applyFilters() }}
        >
          <label className="sr-only" htmlFor="search-q">
            Search by activity, place, or address
          </label>
          <input
            id="search-q"
            className="q-input"
            type="search"
            placeholder="Search activities (e.g. boxing, yoga)…"
            value={q}
            onChange={e => setQ(e.target.value)}
            autoComplete="off"
          />
          <label className="sr-only" htmlFor="search-zip">
            Zip code
          </label>
          <input
            id="search-zip"
            className="zip"
            type="text"
            inputMode="numeric"
            pattern="\d*"
            placeholder="Zip Code"
            autoComplete="postal-code"
            value={zip}
            onChange={e => setZip(e.target.value)}
            maxLength={5}
            aria-describedby={locError ? 'search-loc-error' : undefined}
          />
          <button
            type="button"
            onClick={requestLocation}
            disabled={locLoading}
            className="btn-loc btn-loc-compact"
            aria-describedby={locError ? 'search-loc-error' : undefined}
          >
            <span className="btn-loc-icon" aria-hidden="true">{locLoading ? <span className="btn-loc-spinner" /> : <Icon.location />}</span>
            <span className="btn-loc-label">{locLoading ? 'Locating…' : 'Use my location'}</span>
          </button>
          {locError && (
            <span id="search-loc-error" className="loc-error" role="alert">
              {locError}
            </span>
          )}
          <button type="submit" className="btn btn-primary">Search</button>
          <button
            type="button"
            className="btn btn-outline btn-filter-toggle"
            aria-expanded={showFilters}
            aria-controls="filters-panel"
            onClick={() => setShowFilters(f => !f)}
          >
            {showFilters ? 'Hide filters' : 'Filters'}
            {activeFilterCount > 0 && <span className="filter-badge" aria-label={`${activeFilterCount} active`}>{activeFilterCount}</span>}
          </button>
        </form>
      </div>

      <div className="results-layout">
        {/* Filters sidebar */}
        <aside
          id="filters-panel"
          className={`filters-panel ${showFilters ? 'filters-open' : ''}`}
          aria-label="Activity filters"
        >
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'0.5rem'}}>
            <strong style={{fontSize:'0.95rem'}}>Filters</strong>
            {(selType.length > 0 || selIntensity.length > 0 || selCost.length > 0 || selFormat.length > 0 || selDays.length > 0 || (zip && maxDistance != null) || params.get('lat')) && (
              <button onClick={clearFilters} className="filters-clear">Clear all</button>
            )}
          </div>

          <FilterGroupMulti title="Activity Type" options={unionSortedStrings(filterOptions.activityType, DEFAULT_FILTER_OPTIONS.activityType)} value={selType} onChange={setSelType} initialVisible={6} />
          <FilterGroupMulti title="Intensity" options={unionSortedStrings(filterOptions.intensity, DEFAULT_FILTER_OPTIONS.intensity)} value={selIntensity} onChange={setSelIntensity} initialVisible={5} />
          <FilterGroupMulti title="Cost" options={unionSortedStrings(filterOptions.cost, DEFAULT_FILTER_OPTIONS.cost)} value={selCost} onChange={setSelCost} initialVisible={5} />
          <FilterGroupMulti title="Format" options={unionSortedStrings(filterOptions.format, DEFAULT_FILTER_OPTIONS.format)} value={selFormat} onChange={setSelFormat} initialVisible={5} />
          <FilterGroupMulti title="Days of week" options={unionDaysOfWeek(filterOptions.daysOfWeek, DEFAULT_FILTER_OPTIONS.daysOfWeek)} value={selDays} onChange={setSelDays} initialVisible={7} />

          <fieldset className="filter-distance" aria-describedby="distance-help">
            <legend className="filter-title">Distance from you</legend>
            <p id="distance-help" className="filter-distance-desc">Enter your zip or use your location, then choose how far you’re willing to travel.</p>
            <div style={{display:'flex',gap:'0.5rem',alignItems:'center',flexWrap:'wrap'}}>
              <label className="sr-only" htmlFor="filter-zip">
                Your zip code
              </label>
              <input
              id="filter-zip"
              type="text"
              className="filter-zip-input"
              inputMode="numeric"
              pattern="\d*"
              placeholder="Your zip code"
              autoComplete="postal-code"
              value={zip}
              onChange={e => setZip(e.target.value)}
              maxLength={5}
              aria-describedby={locError ? 'filter-loc-error' : undefined}
            />
              <button
                type="button"
                onClick={requestLocation}
                disabled={locLoading}
                className="btn-loc"
                aria-describedby={locError ? 'filter-loc-error' : undefined}
              >
                <span className="btn-loc-icon" aria-hidden="true">{locLoading ? <span className="btn-loc-spinner" /> : <Icon.location />}</span>
                <span className="btn-loc-label">{locLoading ? 'Locating…' : 'Use my location'}</span>
              </button>
            </div>
              {locError && <span id="filter-loc-error" className="loc-error" role="alert">{locError}</span>}
            {((zip && /^\d{5}$/.test(zip)) || userCoords || params.get('lat')) && (
            <>
              <div className="distance-slider-label">Within <strong>{maxDistance ?? DISTANCE_DEFAULT} miles</strong></div>
              <div className="distance-slider-wrap">
                <input
                  type="range"
                  className="distance-slider"
                  min={DISTANCE_MIN}
                  max={DISTANCE_MAX}
                  step={5}
                  value={maxDistance ?? DISTANCE_DEFAULT}
                  onChange={e => setMaxDistance(Number(e.target.value))}
                  aria-label="Maximum distance"
                  aria-valuetext={`${maxDistance ?? DISTANCE_DEFAULT} miles`}
                />
              </div>
              <div className="distance-ticks">
                {DISTANCE_QUICK.map(m => (
                  <button
                    key={m}
                    type="button"
                    className={`distance-tick ${(maxDistance ?? DISTANCE_DEFAULT) === m ? 'active' : ''}`}
                    aria-pressed={(maxDistance ?? DISTANCE_DEFAULT) === m}
                    onClick={() => setMaxDistance(m)}
                  >
                    {m} mi
                  </button>
                ))}
              </div>
            </>
            )}
          </fieldset>

          <button className="btn btn-primary" style={{width:'100%',marginTop:'1rem'}} onClick={applyFilters}>
            Apply Filters
          </button>
        </aside>

        {/* Results */}
        <section aria-labelledby="results-heading">
          {loading ? (
            <div className="state-msg" role="status"><div className="spinner" aria-hidden="true"/><p>Loading activities…</p></div>
          ) : error ? (
            <div className="state-msg state-msg-error" role="alert">
              <p><strong>We couldn't load activities right now.</strong></p>
              <p style={{marginTop:'0.5rem',fontSize:'0.95rem'}}>Please check your internet connection, or try again in a few minutes.</p>
              <button className="btn btn-primary" style={{marginTop:'1.25rem'}} onClick={load}>
                Try again
              </button>
            </div>
          ) : (
            <>
              <h1 id="results-heading" className="results-heading">
                {(activeFilterCount > 0 || params.get('q') || params.get('zip') || params.get('lat'))
                  ? 'Activities that match your search'
                  : 'All activities'}
              </h1>
              <div aria-live="polite" aria-atomic="true">
                <p className="results-meta">
                  <strong>{activities.length}</strong> {activities.length === 1 ? 'activity' : 'activities'} found
                  {(params.get('lat') && params.get('lng')) ? ' near you' : params.get('zip') ? ` near ${params.get('zip')}` : ''}
                  {((params.get('lat') && params.get('lng')) || params.get('zip')) && ` within ${params.get('distance') || DISTANCE_DEFAULT} mi`}
                </p>
              </div>
              {activeChips.length > 0 && (
                <div className="active-chips" aria-label="Active filters">
                  {activeChips.map((c, i) => (
                    <button key={i} className="chip" onClick={c.remove} aria-label={`Remove ${c.label} filter`}>
                      {c.label} <span className="chip-x" aria-hidden="true">×</span>
                    </button>
                  ))}
                  {activeChips.length > 1 && (
                    <button className="chip" onClick={clearFilters} style={{background:'transparent',borderStyle:'dashed'}}>
                      Clear all
                    </button>
                  )}
                </div>
              )}
              {activities.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-state-icon" aria-hidden="true">🔍</div>
                  <h2>No activities found</h2>
                  <p>Try adjusting your filters, expanding your search distance, or searching from a different location.</p>
                  <button className="btn btn-primary" onClick={clearFilters}>Clear all filters</button>
                </div>
              ) : (
                <ul className="activity-list" role="list">
                  {activities.map(a => <ActivityCard key={a.id} activity={a} />)}
                </ul>
              )}
            </>
          )}
        </section>
      </div>

      <footer>
        <strong>MN Parkinson's Connect</strong> — Helping you connect with community.<br />
        <span style={{marginTop:'0.5rem',display:'inline-block',opacity:0.9}}>Powered by <a href="https://technextdoormn.com" target="_blank" rel="noopener noreferrer" style={{color:'#b8ccab'}}>Tech Next Door MN<ExtLink /></a></span>
      </footer>
    </div>
  )
}

function ActivityCard({ activity: a }) {
  // The card is a list item with a real link on the activity name. A CSS
  // "stretched link" (::after covering the card) keeps the whole card
  // clickable while screen readers still get every detail line — a button
  // with aria-label would have hidden the schedule, cost, and distance.
  const isFreeCost = (() => {
    const label = String(a.costCategory || a.costDisplay || '').trim()
    return label === 'Free'
  })()

  return (
    <li className="activity-card">
      <div className="card-top">
        <div>
          <h2 className="card-name">
            <a className="card-link" href={`#/activity/${a.id}`}>
              {a.name}
              <span className="sr-only"> — view details</span>
            </a>
          </h2>
          <div className="card-location">
            {a.format === 'Virtual' ? '🌐 Virtual' : <><Icon.pin /> {a.location || a.address || a.zip}</>}
          </div>
          {a.address && (
            <div className="card-address">{a.address}</div>
          )}
          {(a.daysOfWeek || a.schedule) && (
            <div className="card-days">
              {a.daysOfWeek ? <>Days: {a.daysOfWeek}</> : <>Schedule: {a.schedule}</>}
            </div>
          )}
        </div>
        <span className={`badge ${isFreeCost ? 'badge-cost-free' : ''}`}>
          {isFreeCost ? 'Free' : <><Icon.dollar />{a.costCategory || a.costDisplay || '—'}</>}
        </span>
      </div>
      <div className="card-meta">
        {a.schedule && <span className="badge"><Icon.clock />{a.schedule.split(',')[0]}</span>}
        {a.intensity && <span className="badge"><Icon.bolt />{a.intensity}</span>}
        {(Array.isArray(a.type) ? a.type.length > 0 : !!a.type) && <span className="badge blue">{Array.isArray(a.type) ? a.type.join(', ') : a.type}</span>}
        {a.dist != null && <span className="badge">{a.dist.toFixed(1)} mi away</span>}
      </div>
    </li>
  )
}

// ─────────────────────────────────────────────
// ACTIVITY DETAIL PAGE
// ─────────────────────────────────────────────

// "Report incorrect information" — a quiet disclosure at the bottom of each
// activity page. Submits to /api/report, which files the note in the Reports
// table in Airtable, linked to this activity.
function ReportIssueSection({ activity }) {
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [email, setEmail] = useState('')
  const [website, setWebsite] = useState('') // honeypot — humans never see it
  const [status, setStatus] = useState('idle') // idle | sending | sent | error
  const [errorMsg, setErrorMsg] = useState('')
  const textareaRef = useRef(null)
  const toggleRef = useRef(null)
  const wasOpen = useRef(false)

  // Move focus into the form when it opens, and back to the toggle on Cancel.
  useEffect(() => {
    if (open) {
      wasOpen.current = true
      textareaRef.current?.focus()
    } else if (wasOpen.current) {
      toggleRef.current?.focus()
    }
  }, [open])

  const handleSubmit = async (e) => {
    e.preventDefault()
    const msg = message.trim()
    if (msg.length < 5) {
      setStatus('error')
      setErrorMsg("Please tell us a little more about what's wrong — a few words is plenty.")
      return
    }
    setStatus('sending')
    setErrorMsg('')
    try {
      const res = await fetch('/api/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activityId: activity.id,
          message: msg,
          email: email.trim() || undefined,
          website,
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || '')
      }
      setStatus('sent')
    } catch (err) {
      setStatus('error')
      setErrorMsg(err.message || "We couldn't send your report right now. Please try again in a few minutes.")
    }
  }

  if (status === 'sent') {
    return (
      <section className="report-section" aria-label="Report incorrect information">
        <p className="report-success" role="status">
          <span aria-hidden="true">✓ </span>
          Thank you — we received your note and will review this listing soon.
        </p>
      </section>
    )
  }

  return (
    <section className="report-section" aria-label="Report incorrect information">
      {!open ? (
        <button type="button" ref={toggleRef} className="report-toggle" onClick={() => setOpen(true)}>
          <Icon.flag /> See something incorrect or out of date? Let us know.
        </button>
      ) : (
        <form className="report-form" onSubmit={handleSubmit}>
          <h2 className="report-title">Report incorrect information</h2>
          <p className="report-desc">
            Tell us what's wrong with the listing for <strong>{activity.name}</strong> and we'll look into it.
          </p>

          <label className="report-label" htmlFor="report-message">
            What's incorrect or out of date?
          </label>
          <textarea
            id="report-message"
            ref={textareaRef}
            rows={4}
            maxLength={2000}
            required
            value={message}
            onChange={e => setMessage(e.target.value)}
            placeholder={'For example: "This class moved to Tuesdays" or "The phone number doesn\'t work."'}
          />

          <label className="report-label" htmlFor="report-email">
            Your email <span className="report-optional">(optional — only if you'd like a reply)</span>
          </label>
          <input
            id="report-email"
            type="email"
            maxLength={254}
            autoComplete="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
          />

          {/* Honeypot: off-screen and skipped by keyboard/screen readers.
              Real visitors never fill it; submissions that do are ignored. */}
          <div className="report-hp" aria-hidden="true">
            <label htmlFor="report-website">Website</label>
            <input
              id="report-website"
              type="text"
              tabIndex={-1}
              autoComplete="off"
              value={website}
              onChange={e => setWebsite(e.target.value)}
            />
          </div>

          {status === 'error' && (
            <p className="report-error" role="alert">{errorMsg}</p>
          )}

          <div className="report-actions">
            <button type="submit" className="btn btn-primary" disabled={status === 'sending'}>
              {status === 'sending' ? 'Sending…' : 'Send report'}
            </button>
            <button type="button" className="btn btn-outline" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  )
}

function ActivityDetail({ id }) {
  const [activity, setActivity] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [copied, setCopied] = useState(false)
  const copyResetRef = useRef(null)

  useEffect(() => {
    setLoading(true)
    fetchActivityById(id)
      .then(setActivity)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [id])

  useEffect(() => () => {
    if (copyResetRef.current) clearTimeout(copyResetRef.current)
  }, [])

  // WCAG 2.4.2 — set specific page title once activity name is known
  useEffect(() => {
    if (activity?.name) {
      document.title = `${activity.name} — MN Parkinson's Connect`
    }
  }, [activity])

  if (loading) return <div className="state-msg" role="status" style={{padding:'4rem'}}><div className="spinner" aria-hidden="true"/><p>Loading activity details…</p></div>
  if (error) return (
    <div className="state-msg state-msg-error" role="alert" style={{padding:'4rem'}}>
      <p><strong>We couldn't load this activity.</strong></p>
      <p style={{marginTop:'0.5rem',fontSize:'0.9rem'}}>The link may be out of date or the activity is no longer listed.</p>
      <a className="state-msg-action" href="#/search">
        <Icon.back /> Back to search
      </a>
    </div>
  )
  if (!activity) return null

  const a = activity

  // Derived view data — keeps the JSX below readable.
  const phones = splitPhones(a.phone)
  const scheduleGroups = parseSchedule(a.schedule)
  const websiteRaw = String(a.website || '').trim()
  const websiteUrl = websiteRaw && !/^(n\/?a|none|tbd|-|—)$/i.test(websiteRaw)
    ? safeHttpUrl(websiteRaw)
    : null
  const registrationRaw = String(a.registrationLink || '').trim()
  const registrationUrl = safeHttpUrl(registrationRaw)
  // Some activities use the Registration Link field to hold an email
  // ("email me to sign up"). Detect that so we can render a mailto:
  // button instead of dropping the CTA.
  const registrationEmail = (!registrationUrl && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(registrationRaw))
    ? registrationRaw
    : null
  const directionsUrl = a.address
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(a.address)}`
    : null
  const hasAbout = Boolean(
    (a.description && String(a.description).trim()) ||
    (a.additionalDetails && String(a.additionalDetails).trim())
  )
  const howToAttendText = String(a.howToAttend || '').trim()
  const showHowToAttend = howToAttendText && !/^(n\/a|na|tbd|-|—)$/i.test(howToAttendText)

  // Share the page via the OS share sheet where available, otherwise copy
  // the link and confirm it ("Link copied!") both visually and to screen
  // readers via the live region below.
  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'
  const handleShare = async () => {
    const url = window.location.href
    if (canNativeShare) {
      try { await navigator.share({ title: `${a.name} — MN Parkinson's Connect`, url }) } catch {}
      return
    }
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      if (copyResetRef.current) clearTimeout(copyResetRef.current)
      copyResetRef.current = setTimeout(() => setCopied(false), 2500)
    } catch {}
  }

  const Row = ({ label, value, preserveNewlines = false }) => value ? (
    <div className="info-row">
      <span className="info-label">{label}</span>
      <span className="info-value" style={preserveNewlines ? { whiteSpace: 'pre-wrap' } : undefined}>
        {value}
      </span>
    </div>
  ) : null

  return (
    <div>
      <div className="detail-wrap">
        <div className="detail-topbar">
          <button className="detail-back" onClick={() => {
            // Preserve search context — go back if there's history, otherwise fall back to search
            if (window.history.length > 1) { window.history.back() } else { navigate('#/search') }
          }}>
            <Icon.back /> Back to results
          </button>
          <div className="detail-actions">
            <button type="button" className="detail-action-btn" onClick={handleShare}>
              <Icon.share /> {canNativeShare ? 'Share' : (copied ? 'Link copied!' : 'Copy link')}
            </button>
            <button type="button" className="detail-action-btn" onClick={() => window.print()}>
              <Icon.printer /> Print
            </button>
          </div>
          <span className="sr-only" role="status" aria-live="polite">
            {copied ? 'Link copied to clipboard' : ''}
          </span>
        </div>

        <div className="detail-tags">
          {(Array.isArray(a.type) ? a.type.length > 0 : !!a.type) && <span className="badge blue">{Array.isArray(a.type) ? a.type.join(', ') : a.type}</span>}
          {a.format && <span className="badge">{a.format}</span>}
          {a.status === 'Active' && <span className="badge green">Active</span>}
        </div>

        <h1 className="detail-title">{a.name}</h1>
        {a.format === 'Virtual' ? (
          <p className="detail-venue">🌐 Virtual Activity</p>
        ) : a.location ? (
          <p className="detail-venue"><span className="detail-venue-at">at </span>{a.location}</p>
        ) : null}

        <div className="detail-grid">
          {/* Left column — schedule, location, contact, about */}
          <div>
            <section className="info-card" aria-labelledby="schedule-heading">
              <h2 id="schedule-heading">Schedule</h2>
              {scheduleGroups ? (
                <dl className="schedule-list">
                  {scheduleGroups.map((g, i) => (
                    <div className="schedule-row" key={i}>
                      <dt className="schedule-day">{g.day}</dt>
                      <dd className="schedule-times">
                        {g.times.length > 0
                          ? g.times.map((t, j) => <div key={j}>{t}</div>)
                          : <span aria-hidden="true">—</span>}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <Row label="Days & times" value={a.schedule} preserveNewlines />
              )}
              <Row label="Time of day" value={a.timeOfDay} />
              <Row label="Intensity" value={a.intensity} />
              <Row label="Format" value={a.format} />
              <Row label="Caregiver friendly" value={a.caregiverFriendly} />
            </section>

            {(a.location || a.address || (a.format !== 'Virtual' && a.zip)) && (
              <section className="info-card" aria-labelledby="location-heading">
                <h2 id="location-heading">Location</h2>
                <Row label="Venue" value={a.location} />
                {a.format !== 'Virtual' && a.address && (
                  <>
                    <div className="info-row">
                      <span className="info-label">Address</span>
                      <span className="info-value" style={{ whiteSpace: 'pre-wrap' }}>{a.address}</span>
                    </div>
                    {directionsUrl && (
                      <div className="info-row info-row-action">
                        <span className="info-label" aria-hidden="true"></span>
                        <a
                          className="info-value directions-link"
                          href={directionsUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={`Get directions to ${a.address}`}
                        >
                          <Icon.pin /> Get directions<ExtLink />
                        </a>
                      </div>
                    )}
                  </>
                )}
                {a.format !== 'Virtual' && a.zip && <Row label="Zip code" value={a.zip} />}
              </section>
            )}

            {(a.contact || phones.length > 0 || a.email) && (
              <section className="info-card" aria-labelledby="contact-heading">
                <h2 id="contact-heading">Contact</h2>
                <Row label="Contact" value={a.contact} />
                {phones.length > 0 && (
                  <div className="info-row">
                    <span className="info-label">Phone</span>
                    <div className="info-value phone-list">
                      {phones.map((p, i) => (
                        <a key={i} href={p.href} className="contact-link">
                          <Icon.phone /> {p.display}
                        </a>
                      ))}
                    </div>
                  </div>
                )}
                {a.email && (
                  <div className="info-row">
                    <span className="info-label">Email</span>
                    <a className="info-value contact-link" href={`mailto:${a.email}`}>
                      <Icon.mail /> {a.email}
                    </a>
                  </div>
                )}
              </section>
            )}

            {hasAbout && (
              <section className="info-card" aria-labelledby="about-heading">
                <h2 id="about-heading">About this activity</h2>
                {a.description && String(a.description).trim() && (
                  <div className="description-body" style={{ whiteSpace: 'pre-wrap' }}>{a.description}</div>
                )}
                {a.additionalDetails && String(a.additionalDetails).trim() && (
                  <div className="description-body" style={{ whiteSpace: 'pre-wrap', marginTop: a.description ? '0.75rem' : 0 }}>
                    {a.additionalDetails}
                  </div>
                )}
              </section>
            )}
          </div>

          {/* Right sidebar — cost & primary actions */}
          <aside aria-label={registrationUrl ? 'Cost and registration' : 'Cost'}>
            <div className="sidebar-card cost-register-card">
              <h2 className="sidebar-card-title">Cost</h2>
              <div className="cost-display">
                {a.costCategory === 'Free' ? (
                  <span className="cost-free">Free</span>
                ) : (
                  <>
                    {a.costDisplay && a.costCategory && String(a.costCategory).trim() !== String(a.costDisplay).trim() && (
                      <span className="cost-category">{a.costCategory}</span>
                    )}
                    <span className="cost-detail">{a.costDisplay || a.costCategory || '—'}</span>
                  </>
                )}
              </div>

              {registrationUrl && (
                <a
                  href={registrationUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="register-cta"
                  aria-label={`Register for ${a.name} (opens in a new tab)`}
                >
                  <span>Register now</span>
                  <span className="register-cta-arrow" aria-hidden="true">→</span>
                  <ExtLink />
                </a>
              )}
              {!registrationUrl && registrationEmail && (
                <a
                  href={`mailto:${registrationEmail}?subject=${encodeURIComponent('Sign-up: ' + a.name)}`}
                  className="register-cta"
                  aria-label={`Email ${registrationEmail} to register for ${a.name}`}
                >
                  <Icon.mail />
                  <span>Email to register</span>
                </a>
              )}

              {websiteUrl && (
                <p className="more-info">
                  {registrationUrl ? 'More info: ' : 'Learn more: '}
                  <a href={websiteUrl} target="_blank" rel="noopener noreferrer">
                    {getDisplayDomain(websiteUrl)}<ExtLink />
                  </a>
                </p>
              )}

              {showHowToAttend && (
                <div className="attend-section">
                  <h3 className="attend-title">How to attend</h3>
                  <div className="attend-content">
                    {renderInstructionTextWithLinks(howToAttendText)}
                  </div>
                </div>
              )}
            </div>
          </aside>
        </div>

        <ReportIssueSection activity={a} />
      </div>

      <footer>
        <strong>MN Parkinson's Connect</strong> — Helping you connect with community.<br />
        <span style={{marginTop:'0.5rem',display:'inline-block',opacity:0.9}}>Powered by <a href="https://technextdoormn.com" target="_blank" rel="noopener noreferrer" style={{color:'#b8ccab'}}>Tech Next Door MN<ExtLink /></a></span>
      </footer>
    </div>
  )
}

// ─────────────────────────────────────────────
// APP ROOT
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// DISCLAIMER MODAL — shown once before site access
// ─────────────────────────────────────────────
const DISCLAIMER_KEY = 'mnpc_disclaimer_accepted'

function DisclaimerModal({ onAccept }) {
  const btnRef = useRef(null)
  const modalRef = useRef(null)

  useEffect(() => {
    // Move focus to the accept button so keyboard users start in the modal
    if (btnRef.current) btnRef.current.focus()
    // Prevent background scrolling while the modal is up
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    // Focus trap: keep Tab/Shift+Tab cycling inside the modal.
    // Esc accepts the disclaimer (the only available action).
    const handleKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onAccept()
        return
      }
      if (e.key !== 'Tab' || !modalRef.current) return
      const focusables = modalRef.current.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'
      )
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('keydown', handleKey)
      document.body.style.overflow = prevOverflow
    }
  }, [onAccept])

  return (
    <div
      className="disclaimer-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="disclaimer-title"
      aria-describedby="disclaimer-body"
    >
      <div ref={modalRef} className="disclaimer-modal">
        <div className="disclaimer-icon" aria-hidden="true">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="16" x2="12" y2="12"/>
            <line x1="12" y1="8" x2="12.01" y2="8"/>
          </svg>
        </div>
        <h2 id="disclaimer-title">Important Notice</h2>
        <div id="disclaimer-body" className="disclaimer-body">
          <p>
            The information on this website, including listings and descriptions of exercise programs
            for persons with Parkinson's disease, is provided by the identified organization and is
            for general informational purposes only and is not a substitute for professional medical
            advice, diagnosis, or treatment. Always seek the advice of your physician or other
            qualified healthcare provider with any questions you may have.
          </p>
          <p>
            This website makes no recommendations or representations about the appropriateness or
            quality of any program listed. Inclusion in the database does not imply competency,
            quality of services or endorsement by the site.
          </p>
        </div>
        <button
          ref={btnRef}
          className="btn-accept"
          onClick={onAccept}
        >
          I Understand — Continue
        </button>
      </div>
    </div>
  )
}

export default function App() {
  const [disclaimerAccepted, setDisclaimerAccepted] = useState(() => {
    try { return localStorage.getItem(DISCLAIMER_KEY) === 'true' } catch { return false }
  })
  const hash = useRoute()
  const { path, params } = parseHash(hash)
  const mainRef = useRef(null)

  const handleAcceptDisclaimer = useCallback(() => {
    try { localStorage.setItem(DISCLAIMER_KEY, 'true') } catch {}
    setDisclaimerAccepted(true)
  }, [])

  // Move focus to main on every route change so screen-reader users
  // start at the new page content (not stuck on the previous page's
  // last-focused element). Also fires once after the disclaimer is
  // dismissed so users land in the content, not at document.body.
  useEffect(() => {
    if (disclaimerAccepted && mainRef.current) {
      mainRef.current.focus()
    }
  }, [hash, disclaimerAccepted])

  // WCAG 2.4.2 — update page title on route change
  useEffect(() => {
    const base = 'MN Parkinson\'s Connect'
    if (path === '/search') {
      document.title = `Search Activities — ${base}`
    } else if (path.startsWith('/activity/')) {
      document.title = `Activity Details — ${base}`
    } else {
      document.title = base
    }
  }, [path])

  if (!disclaimerAccepted) {
    return <DisclaimerModal onAccept={handleAcceptDisclaimer} />
  }

  let page
  if (path === '/' || path === '') {
    page = <Home />
  } else if (path === '/search') {
    page = <SearchResults params={params} />
  } else if (path.startsWith('/activity/')) {
    const id = path.replace('/activity/', '')
    page = <ActivityDetail id={id} />
  } else {
    page = <Home />
  }

  return (
    <>
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      <Nav />
      <main
        id="main-content"
        ref={mainRef}
        tabIndex="-1"
      >
        {page}
      </main>
      <ScrollToTop />
    </>
  )
}