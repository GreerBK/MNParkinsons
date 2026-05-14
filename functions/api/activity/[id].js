export async function onRequestGet({ env, params }) {
  const pat = env.AIRTABLE_PAT
  const baseId = env.AIRTABLE_BASE_ID
  const tableId = env.AIRTABLE_TABLE_ID

  if (!pat) return Response.json({ error: 'Server configuration error' }, { status: 500 })

  const res = await fetch(
    `https://api.airtable.com/v0/${baseId}/${tableId}/${params.id}`,
    { headers: { Authorization: `Bearer ${pat}` } }
  )
  if (!res.ok) return Response.json({ error: 'Activity not found' }, { status: res.status })
  return Response.json(await res.json())
}
