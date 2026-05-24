// Canonical Airtable field names. These match the live schema as of the
// 2026 cleanup — keep in sync if you rename anything in Airtable.
const FIELDS = {
  activityType: 'Activity Type',
  intensity: 'Intensity',
  costCategory: 'Cost Category',
  format: 'Virtual/In-Person/Hybrid',
  daysOfWeek: 'Days of Week',
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
      switch (field.name) {
        case FIELDS.activityType:  out.activityType = choices; break
        case FIELDS.intensity:     out.intensity = choices; break
        case FIELDS.costCategory:  out.cost = choices; break
        case FIELDS.format:        out.format = choices; break
        case FIELDS.daysOfWeek:
          out.daysOfWeek = [...choices].sort((a, b) => {
            const i = DAY_ORDER.indexOf(a)
            const j = DAY_ORDER.indexOf(b)
            if (i === -1 && j === -1) return a.localeCompare(b)
            if (i === -1) return 1
            if (j === -1) return -1
            return i - j
          })
          break
      }
    }
    return Response.json(out)
  } catch {
    return Response.json(null)
  }
}
