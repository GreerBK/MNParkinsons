import { useState, useEffect, useCallback, useRef } from 'react'

// ─────────────────────────────────────────────
// CONFIG — set your values here or in .env
// ─────────────────────────────────────────────
const AIRTABLE_PAT     = import.meta.env.VITE_AIRTABLE_PAT || ''
const AIRTABLE_BASE_ID = import.meta.env.VITE_AIRTABLE_BASE_ID || 'appKtPJiD3Pex9ai1'
const AIRTABLE_TABLE_ID = import.meta.env.VITE_AIRTABLE_TABLE_ID || 'tblfEZNHgfRwvvVJc'
const LOCATIONIQ_KEY   = import.meta.env.VITE_LOCATIONIQ_KEY || '' // optional: free at locationiq.com, for zip→coords when Zippopotam is blocked

// ─────────────────────────────────────────────
// AIRTABLE — maps your exact field names
// ─────────────────────────────────────────────
function mapRecord(record) {
  const f = record.fields
  return {
    id:               record.id,
    name:             f['Activity Name']          || '',
    type:             (() => {
      const raw = f['Activity Type'] ?? f['Type of Activity']
      return Array.isArray(raw) ? raw : (raw ? [raw] : [])
    })(),
    location:         f['Location']               || '',
    address:          f['Address']                || '',
    zip:              String(f['Activity Zip Code'] || ''),
    format:           f['Virtual/In-Person/Hybrid'] || 'In-Person',
    schedule:         f['Days/Times Meeting']     || '',
    daysOfWeek:       (() => {
      const raw = f['Days of Week'] ?? f['Day of Week'] ?? f['Days of the Week'] ?? f['Meeting Days']
      if (Array.isArray(raw)) return raw.join(', ')
      return raw ? String(raw).trim() : ''
    })(),
    timeOfDay:        f['Time of Day']            || '',
    intensity:        (() => {
      const raw = f['Intensity'] ?? f['Level of Intensity']
      if (Array.isArray(raw)) return raw.join(', ')
      return raw ? String(raw).trim() : ''
    })(),
    costDisplay:      f['Cost Display']           || f['Cost']  || '',
    costCategory:     f['Cost Category']          || '',
    contact:          f['Program Contact']        || '',
    email:            f['Program Email Address']  || '',
    phone:            f['Site Phone #']           || f['Phone Info'] || '',
    registrationLink: f['Registration Link'] || '',
    website:          f['Online Website']         || f['Info'] || '',
    caregiverFriendly:f['Caregiver Friendly']     || '',
    status:           f['Status']                 || 'Active',
    lat:              (() => { const v = f['Latitude']; const n = parseFloat(v); return v != null && !isNaN(n) ? n : null })(),
    lng:              (() => { const v = f['Longitude']; const n = parseFloat(v); return v != null && !isNaN(n) ? n : null })(),
  }
}

async function fetchActivities(filters = {}) {
  if (!AIRTABLE_PAT) throw new Error('Missing VITE_AIRTABLE_PAT. Add it to your .env file.')
  const conditions = [`{Status} = 'Active'`]

  // Search: use SEARCH() only on text fields. Avoid LOWER() in filterByFormula (can cause 422).
  // SEARCH is case-insensitive in Airtable. Keep to fields that exist in your base.
  if (filters.q) {
    const q = String(filters.q).trim().replace(/'/g, "\\'")
    if (q) {
      const searchParts = [
        `SEARCH('${q}', {Activity Name})`,
        `SEARCH('${q}', {Location})`,
        `SEARCH('${q}', {Address})`,
      ]
      conditions.push(`OR(${searchParts.join(', ')})`)
    }
  }
  const arr = (v) => (Array.isArray(v) ? v : v ? [v] : [])
  const typeVals = arr(filters.type)
  if (typeVals.length) conditions.push(`OR(${typeVals.map(t => `SEARCH('${String(t).replace(/'/g, "\\'")}', {Activity Type})`).join(',')})`)
  const intensityVals = arr(filters.intensity)
  if (intensityVals.length) conditions.push(`OR(${intensityVals.map(i => `SEARCH('${String(i).replace(/'/g, "\\'")}', {Intensity})`).join(',')})`)
  const costVals = arr(filters.cost)
  if (costVals.length) conditions.push(`OR(${costVals.map(c => `{Cost Category} = '${String(c).replace(/'/g, "\\'")}'`).join(',')})`)
  const formatVals = arr(filters.format)
  if (formatVals.length) conditions.push(`OR(${formatVals.map(f => `{Virtual/In-Person/Hybrid} = '${String(f).replace(/'/g, "\\'")}'`).join(',')})`)
  const daysVals = arr(filters.daysOfWeek)
  if (daysVals.length) conditions.push(`OR(${daysVals.map(d => `SEARCH('${String(d).replace(/'/g, "\\'")}', {Days of Week})`).join(',')})`)

  // NOTE: We intentionally do NOT filter by zip prefix server-side.
  // The old approach (SEARCH 3-digit prefix) was too aggressive and excluded
  // nearby activities with different zip prefixes. Instead, we fetch all Active
  // records and let the client-side distance filter do the work.

  const formula = conditions.length > 1 ? `AND(${conditions.join(',')})` : conditions[0]
  const baseUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_ID}`
  let allRecords = []
  let offset = undefined
  do {
    const url = new URL(baseUrl)
    url.searchParams.set('filterByFormula', formula)
    url.searchParams.set('pageSize', '100')
    if (offset) url.searchParams.set('offset', offset)
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${AIRTABLE_PAT}` }
    })
    if (!res.ok) throw new Error(`Airtable error: ${res.status}`)
    const data = await res.json()
    allRecords = allRecords.concat(data.records)
    offset = data.offset
  } while (offset)

  let activities = allRecords.map(mapRecord)

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

  return activities
}

async function fetchActivityById(id) {
  const res = await fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_ID}/${id}`,
    { headers: { Authorization: `Bearer ${AIRTABLE_PAT}` } }
  )
  if (!res.ok) throw new Error('Activity not found')
  return mapRecord(await res.json())
}

// Airtable field names we use for filters (match your base exactly)
const FILTER_FIELD_NAMES = {
  activityType: ['Activity Type', 'Type of Activity'],
  intensity: ['Level of Intensity', 'Intensity'],
  cost: ['Cost Category', 'Cost'],
  format: ['Virtual/In-Person/Hybrid', 'Format'],
  daysOfWeek: ['Days of Week', 'Day of Week', 'Days of the Week', 'Meeting Days'],
}

// Get select/multi-select choices from schema. Returns { activityType: [], intensity: [], ... }.
function getChoicesFromField(field) {
  if (!field || !field.options || !field.options.choices) return []
  return field.options.choices.map(c => (typeof c === 'string' ? c : c.name)).filter(Boolean)
}

async function fetchFilterOptionsFromSchema() {
  if (!AIRTABLE_BASE_ID || !AIRTABLE_TABLE_ID) return null
  try {
    const res = await fetch(
      `https://api.airtable.com/v0/meta/bases/${AIRTABLE_BASE_ID}/tables`,
      { headers: { Authorization: `Bearer ${AIRTABLE_PAT}` } }
    )
    if (!res.ok) return null
    const data = await res.json()
    const table = data.tables?.find(t => t.id === AIRTABLE_TABLE_ID)
    if (!table || !Array.isArray(table.fields)) return null
    const out = { activityType: [], intensity: [], cost: [], format: [], daysOfWeek: [] }
    const fieldTypes = ['singleSelect', 'multipleSelects']
    for (const field of table.fields) {
      const name = field.name
      if (!fieldTypes.includes(field.type)) continue
      const choices = getChoicesFromField(field)
      const DAY_ORDER = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']
      if (FILTER_FIELD_NAMES.activityType.some(n => n === name)) out.activityType = choices
      else if (FILTER_FIELD_NAMES.intensity.some(n => n === name)) out.intensity = choices
      else if (FILTER_FIELD_NAMES.cost.some(n => n === name)) out.cost = choices
      else if (FILTER_FIELD_NAMES.format.some(n => n === name)) out.format = choices
      else if (FILTER_FIELD_NAMES.daysOfWeek.some(n => n === name)) {
        out.daysOfWeek = [...choices].sort((a, b) => {
          const i = DAY_ORDER.indexOf(a); const j = DAY_ORDER.indexOf(b)
          if (i === -1 && j === -1) return a.localeCompare(b)
          if (i === -1) return 1; if (j === -1) return -1
          return i - j
        })
      }
    }
    return out
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

// Minnesota zip code → approximate lat/lng lookup table
// Covers the major zip code prefixes in MN. For zips not in the table,
// we fall back to an external API.
const MN_ZIP_COORDS = {
  '55001':[44.7461,-92.8063],'55003':[44.9772,-92.7686],'55005':[45.4025,-93.2466],
  '55006':[45.8108,-93.1522],'55007':[45.9572,-92.8783],'55008':[45.5727,-93.2244],
  '55009':[44.4447,-92.8538],'55010':[44.5619,-93.0839],'55011':[45.3208,-93.2302],
  '55012':[45.3961,-92.7800],'55013':[45.3867,-92.8050],'55014':[45.1608,-93.1472],
  '55016':[44.7633,-92.9594],'55017':[45.5625,-93.0736],'55018':[44.3397,-92.8672],
  '55019':[44.2972,-93.2400],'55020':[44.5808,-93.1547],'55021':[44.2994,-93.2558],
  '55024':[44.6331,-93.1578],'55025':[45.0558,-92.9453],'55026':[44.4756,-92.3583],
  '55027':[44.3492,-92.6808],'55029':[45.6708,-93.1083],'55030':[45.5753,-92.9508],
  '55031':[44.6400,-92.9617],'55032':[45.5892,-92.7764],'55033':[44.5808,-92.9494],
  '55038':[45.0797,-92.9556],'55040':[45.4717,-93.3108],'55041':[44.4383,-92.0736],
  '55042':[44.9908,-92.8728],'55043':[44.9447,-92.7908],'55044':[44.6358,-93.2425],
  '55045':[45.3617,-92.7758],'55046':[44.2919,-93.4500],'55047':[45.1492,-92.8175],
  '55049':[43.8733,-93.2250],'55051':[45.8758,-93.2722],'55052':[44.2047,-93.2894],
  '55053':[44.3722,-93.0919],'55054':[44.5642,-93.2650],'55055':[44.8953,-92.9806],
  '55056':[45.4342,-92.7678],'55057':[44.4619,-93.1617],'55060':[44.0208,-93.2272],
  '55063':[45.6608,-92.8708],'55065':[44.4125,-92.9914],'55066':[44.5156,-92.5442],
  '55068':[44.5833,-93.0581],'55069':[45.5292,-92.8786],'55070':[45.3525,-93.2639],
  '55071':[44.7339,-93.0639],'55072':[46.2183,-92.5250],'55073':[45.1375,-92.9111],
  '55074':[45.3958,-92.6608],'55075':[44.8922,-93.0406],'55076':[44.8317,-93.0164],
  '55077':[44.8092,-93.0517],'55078':[45.1639,-92.9736],'55079':[45.3483,-92.8908],
  '55080':[45.5650,-93.3592],'55082':[45.0567,-92.8222],'55084':[45.3400,-92.7233],
  '55085':[44.6850,-93.0250],'55087':[44.2358,-93.5111],'55088':[44.5353,-93.2611],
  '55089':[44.5208,-92.7372],'55090':[45.0817,-92.9933],'55092':[45.3208,-93.0847],
  '55101':[44.9544,-93.0900],'55102':[44.9369,-93.1158],'55103':[44.9647,-93.1167],
  '55104':[44.9553,-93.1436],'55105':[44.9400,-93.1658],'55106':[44.9558,-93.0478],
  '55107':[44.9303,-93.0758],'55108':[44.9808,-93.1794],'55109':[45.0167,-93.0258],
  '55110':[45.0608,-93.0917],'55111':[44.8819,-93.2061],'55112':[45.0806,-93.1894],
  '55113':[45.0128,-93.1567],'55114':[44.9611,-93.1922],'55115':[44.9958,-92.9542],
  '55116':[44.9133,-93.1644],'55117':[44.9925,-93.1028],'55118':[44.9003,-93.1058],
  '55119':[44.9422,-93.0133],'55120':[44.8750,-93.1567],'55121':[44.8503,-93.1494],
  '55122':[44.8258,-93.1828],'55123':[44.8017,-93.2208],'55124':[44.7594,-93.2008],
  '55125':[44.9125,-92.9417],'55126':[45.0758,-93.1239],'55127':[45.0558,-93.0933],
  '55128':[44.9700,-92.9317],'55129':[44.8944,-92.9300],'55130':[44.9539,-93.0794],
  '55150':[44.8600,-93.1550],'55155':[44.9508,-93.0944],
  '55301':[45.1947,-93.5806],'55302':[45.3567,-94.0611],'55303':[45.2683,-93.3997],
  '55304':[45.2692,-93.3044],'55305':[44.9547,-93.3822],'55306':[44.7269,-93.2917],
  '55311':[45.0533,-93.4286],'55312':[44.7347,-93.7806],'55313':[45.3333,-93.7917],
  '55314':[44.5319,-94.1500],'55315':[44.6725,-93.4992],'55316':[45.1208,-93.3594],
  '55317':[44.8531,-93.5556],'55318':[44.8144,-93.6083],'55319':[45.4119,-93.8694],
  '55320':[45.1875,-93.8286],'55321':[45.1767,-93.9708],'55322':[44.7694,-93.5681],
  '55325':[45.0786,-93.7947],'55327':[45.1725,-93.4583],'55328':[45.0417,-93.6639],
  '55329':[45.3286,-94.2056],'55330':[45.2958,-93.5539],'55331':[44.8889,-93.5208],
  '55332':[44.4672,-94.7083],'55333':[44.7600,-94.8667],'55334':[44.3933,-94.2083],
  '55335':[44.5694,-93.6639],'55336':[44.7167,-93.9528],'55337':[44.8175,-93.2919],
  '55338':[44.5592,-93.5278],'55339':[44.7569,-93.6278],'55340':[45.0600,-93.5706],
  '55341':[45.0558,-93.6000],'55342':[44.5583,-94.5139],'55343':[44.9167,-93.4167],
  '55344':[44.8667,-93.4444],'55345':[44.9153,-93.4653],'55346':[44.8833,-93.4833],
  '55347':[44.8500,-93.4667],'55349':[45.1917,-93.9194],'55350':[44.8875,-94.3778],
  '55352':[44.6283,-93.5047],'55353':[45.4750,-94.1500],'55354':[44.6194,-93.7889],
  '55355':[45.1222,-94.2222],'55356':[44.9122,-93.5844],'55357':[45.0617,-93.5333],
  '55358':[45.2958,-93.9833],'55359':[44.9603,-93.5833],'55360':[44.9111,-93.6028],
  '55362':[45.2333,-93.6000],'55363':[45.0000,-93.6361],'55364':[44.9000,-93.5528],
  '55367':[44.9028,-93.6639],'55368':[44.7333,-93.6667],'55369':[45.1000,-93.4167],
  '55370':[44.7583,-93.9167],'55371':[45.5833,-93.5556],'55372':[44.7458,-93.4139],
  '55373':[45.0417,-93.5458],'55374':[45.1917,-93.5333],'55375':[44.9083,-93.5583],
  '55376':[45.2083,-93.6667],'55378':[44.7583,-93.3667],'55379':[44.7583,-93.5250],
  '55381':[44.7833,-93.8500],'55382':[45.3000,-94.0750],'55384':[44.8625,-93.5250],
  '55385':[44.5694,-94.0917],'55386':[44.7750,-93.6500],'55387':[44.7750,-93.6750],
  '55388':[44.8583,-93.7194],'55389':[45.1917,-94.0833],'55390':[45.0917,-94.1833],
  '55391':[44.9500,-93.5583],'55395':[44.8750,-93.9583],'55396':[44.4500,-93.5833],
  '55397':[44.8917,-93.7194],'55398':[45.3417,-93.5917],
  '55401':[44.9833,-93.2667],'55402':[44.9750,-93.2750],'55403':[44.9722,-93.2833],
  '55404':[44.9622,-93.2617],'55405':[44.9708,-93.3000],'55406':[44.9417,-93.2250],
  '55407':[44.9350,-93.2550],'55408':[44.9483,-93.2883],'55409':[44.9267,-93.2833],
  '55410':[44.9167,-93.3167],'55411':[44.9958,-93.3000],'55412':[45.0167,-93.3000],
  '55413':[44.9917,-93.2417],'55414':[44.9833,-93.2167],'55415':[44.9750,-93.2583],
  '55416':[44.9508,-93.3428],'55417':[44.9083,-93.2167],'55418':[45.0167,-93.2417],
  '55419':[44.9033,-93.2917],'55420':[44.8417,-93.2583],'55421':[45.0417,-93.2417],
  '55422':[45.0083,-93.3500],'55423':[44.8750,-93.2833],'55424':[44.8917,-93.3333],
  '55425':[44.8500,-93.2417],'55426':[44.9500,-93.3833],'55427':[45.0083,-93.3833],
  '55428':[45.0583,-93.3833],'55429':[45.0583,-93.3333],'55430':[45.0583,-93.2917],
  '55431':[44.8292,-93.3083],'55432':[45.0917,-93.2583],'55433':[45.1667,-93.3167],
  '55434':[45.1333,-93.2500],'55435':[44.8750,-93.3583],'55436':[44.8917,-93.3833],
  '55437':[44.8500,-93.3417],'55438':[44.8250,-93.3583],'55439':[44.8833,-93.4167],
  '55441':[45.0083,-93.4333],'55442':[45.0083,-93.4750],'55443':[45.1083,-93.3500],
  '55444':[45.0917,-93.3167],'55445':[45.1083,-93.3917],'55446':[44.9750,-93.4667],
  '55447':[44.9750,-93.5083],'55448':[45.1750,-93.3083],'55449':[45.1667,-93.2500],
  '55450':[44.8833,-93.2083],'55454':[44.9722,-93.2417],'55455':[44.9722,-93.2333],
  // Duluth area
  '55802':[46.7833,-92.1167],'55803':[46.8417,-92.1167],'55804':[46.8417,-92.0833],
  '55805':[46.8000,-92.1000],'55806':[46.7583,-92.1333],'55807':[46.7417,-92.1583],
  '55808':[46.7083,-92.1833],'55810':[46.7250,-92.2333],'55811':[46.8333,-92.1833],
  '55812':[46.8167,-92.0833],
  // St. Cloud area
  '56301':[45.5500,-94.1667],'56303':[45.5833,-94.1500],'56304':[45.5500,-94.1167],
  // Rochester area
  '55901':[44.0583,-92.4417],'55902':[43.9917,-92.5083],'55904':[43.9833,-92.4250],
  '55906':[44.0917,-92.3917],
  // Mankato area
  '56001':[44.1833,-94.0000],'56003':[44.1667,-93.9583],
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
const Icon = {
  search: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>,
  pin: () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>,
  clock: () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
  dollar: () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="2" x2="12" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>,
  bolt: () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>,
  back: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>,
  phone: () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.87 12.26 19.79 19.79 0 0 1 1.81 3.67 2 2 0 0 1 3.78 1.5h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.77-1.77a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>,
  mail: () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>,
  link: () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>,
  location: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>,
}

// ─────────────────────────────────────────────
// NAV
// ─────────────────────────────────────────────
function Nav() {
  return (
    <nav>
      <div className="nav-inner">
        <button className="nav-logo" onClick={() => navigate('#/')}>
          MN <span>Parkinson's Connect</span>
        </button>
        <button className="btn btn-outline" style={{fontSize:'0.82rem'}} onClick={() => navigate('#/search')}>
          Find Activities
        </button>
      </div>
    </nav>
  )
}

// ─────────────────────────────────────────────
// HOME PAGE
// ─────────────────────────────────────────────
function Home() {
  const [zip, setZip] = useState('')
  const [types, setTypes] = useState([])
  const { coords: userCoords, loading: locLoading, error: locError, requestLocation } = useUserLocation()

  // When user allows location on home, go straight to search with "near you"
  useEffect(() => {
    if (!userCoords) return
    const p = new URLSearchParams()
    p.set('lat', String(userCoords[0]))
    p.set('lng', String(userCoords[1]))
    p.set('distance', '50')
    navigate(`#/search?${p.toString()}`)
  }, [userCoords])

  useEffect(() => {
    fetchActivities().then(acts => {
      const seen = new Set()
      acts.forEach(a => {
        if (!a.type) return
        const list = Array.isArray(a.type) ? a.type : [a.type]
        list.forEach(t => t && seen.add(String(t).trim()))
      })
      setTypes([...seen].sort())
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
        <div className="hero-eyebrow">Supported by APDA & Parkinson's Foundation</div>
        <h1>Find Your <em>Community</em> in Minnesota</h1>
        <p>Connecting people with Parkinson's and their caregivers to local activities, support groups, and resources across the state.</p>

        <form className="search-box" onSubmit={handleSearch}>
          <input
            className="zip-input"
            type="text"
            placeholder="Zip Code"
            value={zip}
            onChange={e => setZip(e.target.value)}
            maxLength={5}
          />
          <button
            type="button"
            onClick={requestLocation}
            disabled={locLoading}
            title="Use my location"
            className="btn-loc"
          >
            <span className="btn-loc-icon">{locLoading ? <span className="btn-loc-spinner" /> : <Icon.location />}</span>
            <span className="btn-loc-label">Use my location</span>
          </button>
          {locError && <span className="loc-error">{locError}</span>}
          <button type="submit" className="btn btn-primary">Search</button>
        </form>
      </section>

      <section className="categories container">
        <h2>Browse by Category</h2>
        {types.length > 0 ? (
          <div className="cat-grid">
            {types.map(type => (
              <div
                key={type}
                className="cat-card"
                onClick={() => navigate(`#/search?type=${encodeURIComponent(type)}`)}
              >
                {type}
              </div>
            ))}
          </div>
        ) : (
          <div className="state-msg"><div className="spinner" /><p>Loading categories…</p></div>
        )}
      </section>

      <footer>
        <strong>MN Parkinson's Connect</strong> — A collaborative initiative of APDA Minnesota &amp; Parkinson's Foundation.<br />
        <span style={{marginTop:'0.5rem',display:'inline-block'}}>Questions? <a href="mailto:info@mnparkinsons.org" style={{color:'#60A5FA'}}>info@mnparkinsons.org</a></span><br />
        <span style={{marginTop:'0.5rem',display:'inline-block',opacity:0.9}}>Powered by <a href="https://technextdoormn.com" target="_blank" rel="noopener noreferrer" style={{color:'#60A5FA'}}>Tech Next Door MN</a></span>
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
  cost: ['Free', 'Paid', 'Free Trial'],
  format: ['In-Person', 'Virtual'],
  daysOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
}
// Merge data options with defaults so we never show an empty or partial list when landing with a filter
function mergeOptions(dataOptions, defaultList) {
  const combined = [...(defaultList || []), ...(dataOptions || [])]
  return [...new Set(combined)]
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
      // Merge filter options from data (fallback / supplement when schema API not used)
      const derived = deriveFilterOptionsFromActivities(data)
      setFilterOptions(prev => ({
        activityType: prev.activityType.length ? prev.activityType : derived.activityType,
        intensity: prev.intensity.length ? prev.intensity : derived.intensity,
        cost: prev.cost.length ? prev.cost : derived.cost,
        format: prev.format.length ? prev.format : derived.format,
        daysOfWeek: prev.daysOfWeek.length ? prev.daysOfWeek : derived.daysOfWeek,
      }))
    } catch(e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [params.toString(), userCoords?.join(',')])

  useEffect(() => { load() }, [load])

  // Fetch filter options from Airtable schema once on mount (PAT may need schema.bases:read scope)
  // Merge with existing so we never overwrite non-empty options with empty (avoids missing filter options)
  useEffect(() => {
    fetchFilterOptionsFromSchema().then(opts => {
      if (!opts) return
      setFilterOptions(prev => ({
        activityType: (opts.activityType?.length ? opts.activityType : prev.activityType) || [],
        intensity: (opts.intensity?.length ? opts.intensity : prev.intensity) || [],
        cost: (opts.cost?.length ? opts.cost : prev.cost) || [],
        format: (opts.format?.length ? opts.format : prev.format) || [],
        daysOfWeek: (opts.daysOfWeek?.length ? opts.daysOfWeek : prev.daysOfWeek) || [],
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

  // Auto-apply when checkbox/distance filters change (results update immediately)
  const didMountFilters = useRef(false)
  useEffect(() => {
    if (!didMountFilters.current) {
      didMountFilters.current = true
      return
    }
    applyFilters(false)
  }, [selType, selIntensity, selCost, selFormat, selDays, maxDistance])

  // Auto-apply when search or zip change (debounced so we don't navigate on every keystroke)
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
  }, [zip])

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

  const toggleMulti = (arr, item) => {
    if (arr.includes(item)) return arr.filter(x => x !== item)
    return [...arr, item]
  }

  const FilterGroupMulti = ({ title, options, value, onChange }) => (
    <>
      <div className="filter-title">{title}</div>
      {options.map(opt => (
        <label key={opt} className="filter-option">
          <input
            type="checkbox"
            checked={value.includes(opt)}
            onChange={() => onChange(toggleMulti(value, opt))}
          />
          {opt}
        </label>
      ))}
    </>
  )

  return (
    <div>
      <div className="search-header">
        <div className="search-header-inner">
          <input
            className="zip"
            type="text"
            placeholder="Zip Code"
            value={zip}
            onChange={e => setZip(e.target.value)}
            maxLength={5}
          />
          <button
            type="button"
            onClick={requestLocation}
            disabled={locLoading}
            title="Use my location"
            className="btn-loc btn-loc-compact"
          >
            <span className="btn-loc-icon">{locLoading ? <span className="btn-loc-spinner" /> : <Icon.location />}</span>
            <span className="btn-loc-label">Use my location</span>
          </button>
          {locError && <span className="loc-error">{locError}</span>}
          <button className="btn btn-primary" onClick={applyFilters}>Search</button>
          <button className="btn btn-outline btn-filter-toggle" onClick={() => setShowFilters(f => !f)}>
            {showFilters ? 'Hide Filters' : 'Filters'}
          </button>
        </div>
      </div>

      <div className="results-layout">
        {/* Filters sidebar */}
        <aside className={`filters-panel ${showFilters ? 'filters-open' : ''}`}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'0.5rem'}}>
            <strong style={{fontSize:'0.95rem'}}>Filters</strong>
            {(selType.length > 0 || selIntensity.length > 0 || selCost.length > 0 || selFormat.length > 0 || selDays.length > 0 || (zip && maxDistance != null) || params.get('lat')) && (
              <button onClick={clearFilters} style={{fontSize:'0.78rem',color:'var(--blue)',fontWeight:600}}>Clear all</button>
            )}
          </div>

          <FilterGroupMulti title="Activity Type" options={mergeOptions(filterOptions.activityType, DEFAULT_FILTER_OPTIONS.activityType)} value={selType} onChange={setSelType} />
          <FilterGroupMulti title="Intensity" options={mergeOptions(filterOptions.intensity, DEFAULT_FILTER_OPTIONS.intensity)} value={selIntensity} onChange={setSelIntensity} />
          <FilterGroupMulti title="Cost" options={mergeOptions(filterOptions.cost, DEFAULT_FILTER_OPTIONS.cost)} value={selCost} onChange={setSelCost} />
          <FilterGroupMulti title="Format" options={mergeOptions(filterOptions.format, DEFAULT_FILTER_OPTIONS.format)} value={selFormat} onChange={setSelFormat} />
          <FilterGroupMulti title="Days of week" options={mergeOptions(filterOptions.daysOfWeek, DEFAULT_FILTER_OPTIONS.daysOfWeek)} value={selDays} onChange={setSelDays} />

          <div className="filter-distance">
            <div className="filter-title">Distance from you</div>
            <p className="filter-distance-desc">Enter your zip or use your location, then choose how far you’re willing to travel.</p>
            <div style={{display:'flex',gap:'0.5rem',alignItems:'center',flexWrap:'wrap'}}>
              <input
              type="text"
              className="filter-zip-input"
              placeholder="Your zip code"
              value={zip}
              onChange={e => setZip(e.target.value)}
              maxLength={5}
            />
              <button
                type="button"
                onClick={requestLocation}
                disabled={locLoading}
                title="Use my location"
                className="btn-loc"
              >
                <span className="btn-loc-icon">{locLoading ? <span className="btn-loc-spinner" /> : <Icon.location />}</span>
                <span className="btn-loc-label">Use my location</span>
              </button>
            </div>
            {locError && <span className="loc-error">{locError}</span>}
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
                />
              </div>
              <div className="distance-ticks">
                {DISTANCE_QUICK.map(m => (
                  <button
                    key={m}
                    type="button"
                    className={`distance-tick ${(maxDistance ?? DISTANCE_DEFAULT) === m ? 'active' : ''}`}
                    onClick={() => setMaxDistance(m)}
                  >
                    {m} mi
                  </button>
                ))}
              </div>
            </>
            )}
          </div>

          <button className="btn btn-primary" style={{width:'100%',marginTop:'1rem'}} onClick={applyFilters}>
            Apply Filters
          </button>
        </aside>

        {/* Results */}
        <main>
          {loading ? (
            <div className="state-msg"><div className="spinner"/><p>Loading activities…</p></div>
          ) : error ? (
            <div className="state-msg" style={{color:'#DC2626'}}>
              <p><strong>Error:</strong> {error}</p>
              <p style={{marginTop:'0.5rem',fontSize:'0.85rem'}}>Check that your AIRTABLE_PAT is set in your .env file.</p>
            </div>
          ) : (
            <>
              <p className="results-meta">
                <strong>{activities.length}</strong> {activities.length === 1 ? 'activity' : 'activities'} found
                {(params.get('lat') && params.get('lng')) ? ' near you' : params.get('zip') ? ` near ${params.get('zip')}` : ''}
                {((params.get('lat') && params.get('lng')) || params.get('zip')) && ` within ${params.get('distance') || DISTANCE_DEFAULT} mi`}
              </p>
              {activities.length === 0 ? (
                <div className="state-msg">
                  <p>No activities match your filters.</p>
                  <button style={{marginTop:'0.75rem',color:'var(--blue)',fontWeight:600}} onClick={clearFilters}>Clear filters</button>
                </div>
              ) : (
                <div className="activity-list">
                  {activities.map(a => <ActivityCard key={a.id} activity={a} />)}
                </div>
              )}
            </>
          )}
        </main>
      </div>

      <footer>
        <strong>MN Parkinson's Connect</strong> — A collaborative initiative of APDA Minnesota &amp; Parkinson's Foundation.<br />
        <span style={{marginTop:'0.5rem',display:'inline-block',opacity:0.9}}>Powered by <a href="https://technextdoormn.com" target="_blank" rel="noopener noreferrer" style={{color:'#60A5FA'}}>Tech Next Door MN</a></span>
      </footer>
    </div>
  )
}

function ActivityCard({ activity: a }) {
  return (
    <div className="activity-card" onClick={() => navigate(`#/activity/${a.id}`)}>
      <div className="card-top">
        <div>
          <div className="card-name">{a.name}</div>
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
        <span className={`badge ${a.costCategory === 'Free' ? 'green' : 'blue'}`}>
          <Icon.dollar />{a.costCategory || a.costDisplay || '—'}
        </span>
      </div>
      <div className="card-meta">
        {a.schedule && <span className="badge"><Icon.clock />{a.schedule.split(',')[0]}</span>}
        {a.intensity && <span className="badge"><Icon.bolt />{a.intensity}</span>}
        {(Array.isArray(a.type) ? a.type.length > 0 : !!a.type) && <span className="badge blue">{Array.isArray(a.type) ? a.type.join(', ') : a.type}</span>}
        {a.dist != null && <span className="badge">{a.dist.toFixed(1)} mi</span>}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────
// ACTIVITY DETAIL PAGE
// ─────────────────────────────────────────────
function ActivityDetail({ id }) {
  const [activity, setActivity] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    setLoading(true)
    fetchActivityById(id)
      .then(setActivity)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [id])

  if (loading) return <div className="state-msg" style={{padding:'4rem'}}><div className="spinner"/><p>Loading…</p></div>
  if (error) return <div className="state-msg" style={{padding:'4rem',color:'#DC2626'}}><p>{error}</p><button style={{marginTop:'1rem',color:'var(--blue)',fontWeight:600}} onClick={()=>navigate('#/search')}>← Back to search</button></div>
  if (!activity) return null

  const a = activity

  const Row = ({ label, value }) => value ? (
    <div className="info-row">
      <span className="info-label">{label}</span>
      <span className="info-value">{value}</span>
    </div>
  ) : null

  return (
    <div>
      <div className="detail-wrap">
        <button className="detail-back" onClick={() => navigate('#/search')}>
          <Icon.back /> Back to results
        </button>

        <div className="detail-tags">
          {(Array.isArray(a.type) ? a.type.length > 0 : !!a.type) && <span className="badge blue">{Array.isArray(a.type) ? a.type.join(', ') : a.type}</span>}
          {a.format && <span className="badge">{a.format}</span>}
          {a.status === 'Active' && <span className="badge green">Active</span>}
        </div>

        <h1 className="detail-title">{a.name}</h1>
        <p className="detail-venue">
          {a.format === 'Virtual' ? '🌐 Virtual Activity' : a.location}
        </p>

        <div className="detail-grid">
          {/* Left column */}
          <div>
            <div className="info-card">
              <h3>Schedule & Logistics</h3>
              <Row label="Days & Times" value={a.schedule} />
              <Row label="Days of Week" value={a.daysOfWeek} />
              <Row label="Time of Day" value={a.timeOfDay} />
              <Row label="Intensity" value={a.intensity} />
              <Row label="Format" value={a.format} />
              <Row label="Caregiver Friendly" value={a.caregiverFriendly} />
            </div>

            <div className="info-card">
              <h3>Location</h3>
              <Row label="Venue" value={a.location} />
              <Row label="Address" value={a.format !== 'Virtual' ? a.address : null} />
              <Row label="Zip Code" value={a.format !== 'Virtual' ? a.zip : null} />
              {a.lat && a.lng && a.format !== 'Virtual' && (
                <div className="info-row">
                  <span className="info-label">Map</span>
                  <a
                    className="info-value"
                    style={{color:'var(--blue)',fontWeight:500}}
                    href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(a.address || a.location)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open in Google Maps ↗
                  </a>
                </div>
              )}
            </div>

            <div className="info-card">
              <h3>Contact</h3>
              <Row label="Contact" value={a.contact} />
              {a.phone && (
                <div className="info-row">
                  <span className="info-label">Phone</span>
                  <a className="info-value" href={`tel:${a.phone}`} style={{color:'var(--blue)',fontWeight:500}}>
                    <Icon.phone /> {a.phone}
                  </a>
                </div>
              )}
              {a.email && (
                <div className="info-row">
                  <span className="info-label">Email</span>
                  <a className="info-value" href={`mailto:${a.email}`} style={{color:'var(--blue)',fontWeight:500}}>
                    <Icon.mail /> {a.email}
                  </a>
                </div>
              )}
              {a.website && a.website !== 'N/A' && (
                <div className="info-row">
                  <span className="info-label">Website</span>
                  <a className="info-value" href={a.website.startsWith('http') ? a.website : `https://${a.website}`} target="_blank" rel="noopener noreferrer" style={{color:'var(--blue)',fontWeight:500}}>
                    <Icon.link /> Visit website ↗
                  </a>
                </div>
              )}
            </div>
          </div>

          {/* Right sidebar */}
          <div>
            <div className="sidebar-card cost-register-card">
              <h3 className="sidebar-card-title">Cost</h3>
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
              {(() => {
                const raw = (a.registrationLink || '').trim()
                if (!raw || /^(n\/a|na|tbd|-|—)$/i.test(raw)) return null
                const href = raw.startsWith('http://') || raw.startsWith('https://') ? raw : `https://${raw}`
                if (href.length < 12 || !href.includes('.')) return null
                return (
                  <a
                    className="register-btn"
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Icon.link /> Register / Sign up
                  </a>
                )
              })()}
            </div>
          </div>
        </div>
      </div>

      <footer>
        <strong>MN Parkinson's Connect</strong> — A collaborative initiative of APDA Minnesota &amp; Parkinson's Foundation.<br />
        <span style={{marginTop:'0.5rem',display:'inline-block',opacity:0.9}}>Powered by <a href="https://technextdoormn.com" target="_blank" rel="noopener noreferrer" style={{color:'#60A5FA'}}>Tech Next Door MN</a></span>
      </footer>
    </div>
  )
}

// ─────────────────────────────────────────────
// APP ROOT
// ─────────────────────────────────────────────
export default function App() {
  const hash = useRoute()
  const { path, params } = parseHash(hash)

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
      <Nav />
      {page}
    </>
  )
}