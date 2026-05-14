const FILTER_FIELD_NAMES = {
  activityType: ['Activity Type', 'Type of Activity'],
  intensity: ['Level of Intensity', 'Intensity'],
  cost: ['Cost Category', 'Cost'],
  format: ['Virtual/In-Person/Hybrid', 'Format'],
  daysOfWeek: ['Days of Week', 'Day of Week', 'Days of the Week', 'Meeting Days'],
}

const DAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

function getChoicesFromField(field) {
  if (!field?.options?.choices) return []
  return field.options.choices.map(c => (typeof c === 'string' ? c : c.name)).filter(Boolean)
}

export async function onRequestGet({ env }) {
  const pat = env.AIRTABLE_PAT
  const baseId = env.AIRTABLE_BASE_ID
  const tableId = env.AIRTABLE_TABLE_ID

  if (!pat) return Response.json(null)

  try {
    const res = await fetch(
      `https://api.airtable.com/v0/meta/bases/${baseId}/tables`,
      { headers: { Authorization: `Bearer ${pat}` } }
    )
    if (!res.ok) return Response.json(null)

    const data = await res.json()
    const table = data.tables?.find(t => t.id === tableId)
    if (!table || !Array.isArray(table.fields)) return Response.json(null)

    const out = { activityType: [], intensity: [], cost: [], format: [], daysOfWeek: [] }
    for (const field of table.fields) {
      if (!['singleSelect', 'multipleSelects'].includes(field.type)) continue
      const choices = getChoicesFromField(field)
      const name = field.name
      if (FILTER_FIELD_NAMES.activityType.some(n => n === name)) out.activityType = choices
      else if (FILTER_FIELD_NAMES.intensity.some(n => n === name)) out.intensity = choices
      else if (FILTER_FIELD_NAMES.cost.some(n => n === name)) out.cost = choices
      else if (FILTER_FIELD_NAMES.format.some(n => n === name)) out.format = choices
      else if (FILTER_FIELD_NAMES.daysOfWeek.some(n => n === name)) {
        out.daysOfWeek = [...choices].sort((a, b) => {
          const i = DAY_ORDER.indexOf(a)
          const j = DAY_ORDER.indexOf(b)
          if (i === -1 && j === -1) return a.localeCompare(b)
          if (i === -1) return 1
          if (j === -1) return -1
          return i - j
        })
      }
    }
    return Response.json(out)
  } catch {
    return Response.json(null)
  }
}
