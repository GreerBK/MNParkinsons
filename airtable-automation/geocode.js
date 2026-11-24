// Airtable Run a script action for the Activities table.
// Geocode new activities passes recordId from the matching record.
// Refresh coordinates when Address changes passes recordId and refresh = 'yes'.

const ADDRESS = 'Address'
const LATITUDE = 'Latitude'
const LONGITUDE = 'Longitude'
const GEOCODED_AT = 'Geocoded At'
const STATUS = 'Status'
const SKIP_VALUES = new Set(['n/a', 'virtual', 'none', 'tbd'])

function validCoordinates(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
}

async function lookup(address) {
  const encoded = encodeURIComponent(address)
  const providers = [
    {
      url: `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encoded}&benchmark=2020&format=json`,
      coordinates: data => {
        const point = data.result?.addressMatches?.[0]?.coordinates
        return [Number.parseFloat(point?.y), Number.parseFloat(point?.x)]
      },
    },
    {
      url: `https://nominatim.openstreetmap.org/search?q=${encoded}&format=json&limit=1&countrycodes=us`,
      headers: { 'User-Agent': 'MNParkinsonsConnect/1.0 (https://mnparkinsons.org)' },
      coordinates: data => [Number.parseFloat(data?.[0]?.lat), Number.parseFloat(data?.[0]?.lon)],
    },
  ]
  for (const provider of providers) {
    try {
      const response = await fetch(provider.url, { headers: provider.headers })
      if (!response.ok) continue
      const [lat, lng] = provider.coordinates(await response.json())
      if (validCoordinates(lat, lng)) return { lat, lng }
    } catch {
      // Try the next provider.
    }
  }
  return null
}

function snapshot(record) {
  if (!record) return null
  return {
    address: record.getCellValueAsString(ADDRESS).trim(),
    status: record.getCellValueAsString(STATUS),
    lat: record.getCellValue(LATITUDE),
    lng: record.getCellValue(LONGITUDE),
    geocodedAt: record.getCellValue(GEOCODED_AT),
  }
}

async function geocode(table, recordId, refresh) {
  if (!recordId) return
  const fields = [ADDRESS, LATITUDE, LONGITUDE, GEOCODED_AT, STATUS]
  const before = snapshot(await table.selectRecordAsync(recordId, { fields }))
  if (!before || before.status !== 'Active' || (!refresh && validCoordinates(before.lat, before.lng))) return

  const usableAddress = before.address && !SKIP_VALUES.has(before.address.toLowerCase())
  const point = usableAddress ? await lookup(before.address) : null
  if (!point && (!refresh || (before.lat == null && before.lng == null))) return

  // The lookup can take seconds. An address or pin changed during that time
  // belongs to a newer edit and must never be replaced by this run.
  const after = snapshot(await table.selectRecordAsync(recordId, { fields }))
  if (!after || Object.keys(before).some(key => before[key] !== after[key])) return

  await table.updateRecordAsync(recordId, {
    [LATITUDE]: point?.lat ?? null,
    [LONGITUDE]: point?.lng ?? null,
    [GEOCODED_AT]: point ? new Date().toISOString() : null,
  })
}

const { recordId, refresh } = input.config()
await geocode(base.getTable('Activities'), recordId, refresh === 'yes')
