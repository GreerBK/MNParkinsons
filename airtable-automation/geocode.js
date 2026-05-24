// ─────────────────────────────────────────────────────────────
// MN Parkinson's Connect — Geocode automation
// ─────────────────────────────────────────────────────────────
// Replaces the local Python geocode_airtable.py script.
// Runs server-side inside Airtable whenever a row needs coordinates.
//
// SETUP (one-time, ~5 minutes):
//
// 1. In Airtable: Automations → "+ Create automation" → name it
//    "Geocode new activities".
//
// 2. Trigger: "When record matches conditions"
//      Table:      Activities
//      Conditions: Address is not empty
//                  AND Latitude is empty
//                  AND Status is "Active"
//
// 3. Action: "+ Add advanced logic or action" → "Run script"
//
// 4. In the script editor, on the LEFT side under "Input variables":
//      Click "+ Add input variable"
//      Name:  recordId
//      Value: click the blue "+" → choose the trigger step →
//             "Airtable record ID"
//
// 5. Paste THIS ENTIRE FILE into the code area on the right.
//    (Delete Airtable's default example code first.)
//
// 6. Click "Test" → it should geocode the trigger record.
//    Then toggle the automation ON (top-right).
//
// FROM NOW ON: every new Active row with an Address gets lat/lng
// auto-filled within ~60 seconds. No more manual script runs.
// ─────────────────────────────────────────────────────────────

const TABLE_NAME = 'Activities'
const ADDRESS_FIELD = 'Address'
const LATITUDE_FIELD = 'Latitude'
const LONGITUDE_FIELD = 'Longitude'
const GEOCODED_AT_FIELD = 'Geocoded At'

// Addresses we should never try to geocode
const SKIP_VALUES = new Set(['n/a', 'virtual', '', 'none', 'tbd'])

// ── Geocoders ───────────────────────────────────────────────
async function geocodeCensus(address) {
  const url =
    'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress' +
    `?address=${encodeURIComponent(address)}&benchmark=2020&format=json`
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const data = await res.json()
    const matches = data && data.result && data.result.addressMatches
    if (matches && matches.length > 0) {
      const c = matches[0].coordinates
      return { lat: parseFloat(c.y), lng: parseFloat(c.x) }
    }
  } catch (e) {
    console.log('Census geocoder error:', e.message)
  }
  return null
}

async function geocodeNominatim(address) {
  const url =
    'https://nominatim.openstreetmap.org/search' +
    `?q=${encodeURIComponent(address)}&format=json&limit=1&countrycodes=us`
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'MNParkinsonsConnect/1.0 (https://mnparkinsons.org)',
      },
    })
    if (!res.ok) return null
    const data = await res.json()
    if (data && data.length > 0) {
      return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) }
    }
  } catch (e) {
    console.log('Nominatim error:', e.message)
  }
  return null
}

// ── Main ────────────────────────────────────────────────────
const { recordId } = input.config()
const table = base.getTable(TABLE_NAME)
const record = await table.selectRecordAsync(recordId)

if (!record) {
  console.log(`No record found for id ${recordId}`)
} else {
  const address = (record.getCellValueAsString(ADDRESS_FIELD) || '').trim()
  const normalized = address.toLowerCase()

  if (!address || SKIP_VALUES.has(normalized)) {
    console.log(`Skipped — address is empty or marked "${address}"`)
  } else {
    let coords = await geocodeCensus(address)
    if (!coords) {
      console.log('Census missed — trying Nominatim…')
      coords = await geocodeNominatim(address)
    }

    if (!coords) {
      console.log(`Could not geocode "${address}" — needs manual lat/lng.`)
    } else {
      await table.updateRecordAsync(recordId, {
        [LATITUDE_FIELD]: coords.lat,
        [LONGITUDE_FIELD]: coords.lng,
        [GEOCODED_AT_FIELD]: new Date().toISOString(),
      })
      console.log(`✓ Geocoded "${address}" → ${coords.lat}, ${coords.lng}`)
    }
  }
}
