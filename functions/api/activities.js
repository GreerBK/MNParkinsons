const FILTER_FIELD_NAMES = {
  activityType: ['Activity Type', 'Type of Activity'],
  intensity: ['Level of Intensity', 'Intensity'],
  cost: ['Cost Category', 'Cost'],
  format: ['Virtual/In-Person/Hybrid', 'Format'],
  daysOfWeek: ['Days of Week', 'Day of Week', 'Days of the Week', 'Meeting Days'],
}

// Airtable formula strings use '' (doubled quote) to escape single quotes, not backslash.
function esc(s) {
  return String(s).trim().replace(/'/g, "''")
}

export async function onRequestGet({ request, env }) {
  const pat = env.AIRTABLE_PAT
  const baseId = env.AIRTABLE_BASE_ID
  const tableId = env.AIRTABLE_TABLE_ID

  if (!pat) return Response.json({ error: 'Server configuration error' }, { status: 500 })

  const { searchParams } = new URL(request.url)
  const q = searchParams.get('q') || ''
  const type = searchParams.getAll('type')
  const intensity = searchParams.getAll('intensity')
  const cost = searchParams.getAll('cost')
  const format = searchParams.getAll('format')
  const daysOfWeek = searchParams.getAll('daysOfWeek')

  const conditions = [`{Status} = 'Active'`]

  const qt = q.trim()
  if (qt) {
    const eq = esc(qt)
    conditions.push(
      `OR(SEARCH('${eq}', {Activity Name}), SEARCH('${eq}', {Location}), SEARCH('${eq}', {Address}))`
    )
  }
  if (type.length) conditions.push(`OR(${type.map(t => `SEARCH('${esc(t)}', {Activity Type})`).join(',')})`)
  if (intensity.length) conditions.push(`OR(${intensity.map(i => `SEARCH('${esc(i)}', {Intensity})`).join(',')})`)
  if (cost.length) conditions.push(`OR(${cost.map(c => `{Cost Category} = '${esc(c)}'`).join(',')})`)
  if (format.length) conditions.push(`OR(${format.map(f => `{Virtual/In-Person/Hybrid} = '${esc(f)}'`).join(',')})`)
  if (daysOfWeek.length) conditions.push(`OR(${daysOfWeek.map(d => `SEARCH('${esc(d)}', {Days of Week})`).join(',')})`)

  const formula = conditions.length > 1 ? `AND(${conditions.join(',')})` : conditions[0]
  const airtableBase = `https://api.airtable.com/v0/${baseId}/${tableId}`

  let allRecords = []
  let offset

  do {
    const url = new URL(airtableBase)
    url.searchParams.set('filterByFormula', formula)
    url.searchParams.set('pageSize', '100')
    if (offset) url.searchParams.set('offset', offset)

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${pat}` },
    })
    if (!res.ok) return Response.json({ error: `Airtable error: ${res.status}` }, { status: res.status })

    const data = await res.json()
    allRecords = allRecords.concat(data.records)
    offset = data.offset
  } while (offset)

  return Response.json({ records: allRecords })
}
