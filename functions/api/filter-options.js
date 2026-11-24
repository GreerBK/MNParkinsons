import { loadActivityChoices, submissionActivityTypes } from '../_shared/activity-schema.js'

export async function onRequestGet(context) {
  const choices = await loadActivityChoices(context)
  const purpose = context.request && new URL(context.request.url).searchParams.get('purpose')
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': choices ? 'public, max-age=300, s-maxage=600' : 'no-store',
  }
  const options = purpose === 'submit'
    ? { activityType: submissionActivityTypes(choices) }
    : choices?.activityOptions ?? null
  return Response.json(options, { headers })
}
