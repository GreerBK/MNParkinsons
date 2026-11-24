const MAILBOX = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i

export function isBareEmail(value) {
  return typeof value === 'string' && value.length <= 254 && MAILBOX.test(value)
}

export function normalizeWebUrl(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text || /[\s<>\\]/.test(text) || text.startsWith('/')) return null
  const absolute = /^https?:\/\//i.test(text)
  if (!absolute && /^[a-z][a-z\d+.-]*:\/\//i.test(text)) return null
  try {
    const url = new URL(absolute ? text : `https://${text}`)
    if (url.username || url.password || (!url.hostname.includes('.') && !url.hostname.startsWith('['))) return null
    return url.href
  } catch {
    return null
  }
}

export function parseRegistrationLink(value) {
  const text = String(value ?? '').trim().replace(/^<(.+)>$/, '$1').trim()
  const url = normalizeWebUrl(text)
  if (url) return { url, email: '' }
  const email = text.replace(/^mailto:/i, '')
  return { url: '', email: isBareEmail(email) ? email : '' }
}
