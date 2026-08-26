// Play Console's own orders API — the same call the Console page makes.
//
// This replaces reading the rendered page. The Console does not render the
// order table while its tab is hidden, so any approach built on a background
// tab returns an empty list forever; that is not a timing problem that a longer
// wait fixes. Calling the API directly sidesteps rendering entirely.

const HOST = 'https://playconsolemonetization-pa.clients6.google.com'
const ORIGIN = 'https://play.google.com'
// Public key shipped in the Console's own bundle, not a secret.
const API_KEY = 'AIzaSyBAha_rcoO_aGsmiR5fWbNfdOjqT0gXwbk'

// Google authenticates these with SAPISIDHASH: sha1 of "<ts> <SAPISID> <origin>".
// The server recomputes it against the Origin header it actually received, so
// the origin baked into the hash has to match what the browser sends.
async function authorization(origin) {
  const cookie = await chrome.cookies.get({ url: ORIGIN, name: 'SAPISID' })
  if (!cookie?.value) throw new Error('auth')
  const ts = Math.floor(Date.now() / 1000)
  const digest = await crypto.subtle.digest(
    'SHA-1',
    new TextEncoder().encode(`${ts} ${cookie.value} ${origin}`),
  )
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `SAPISIDHASH ${ts}_${hex}`
}

// Which origin the request ends up carrying depends on whether the header
// rewrite in rules.json applies to the extension's own requests — undocumented
// enough that guessing once and failing forever is not acceptable for a tool
// whose whole job is to not go quiet. So try the rewritten origin, and on a
// rejection fall back to the extension's own, remembering which one worked.
const ORIGIN_CANDIDATES = [ORIGIN, () => new URL(chrome.runtime.getURL('')).origin]

// The API is protobuf-over-JSON: fields are numbers, not names.
const money = (m) =>
  m?.['1'] ? { currency: m['1'], amount: Number(m['2'] ?? 0) + Number(m['3'] ?? 0) / 1e9 } : null

const STATE = { 1: 'pending', 2: 'charged', 4: 'refunded' }

function normalize(o) {
  const events = o['7'] ?? []
  return {
    id: o['1'],
    state: STATE[o['33']] ?? String(o['33'] ?? '?'),
    subscription: o['12'] === 3,
    product: o['11']?.['1'] ?? '',
    sku: o['11']?.['2'] ?? '',
    packageName: o['13'] ?? '',
    country: o['14']?.['2'] ?? '',
    total: money(o['15']),
    // 19 is the price with tax removed, 27 is what survives Google's cut, and 28
    // is that same figure converted to the developer's own currency — the number
    // that actually lands in a payout.
    beforeFee: money(o['19']),
    tax: money(o['26']),
    net: money(o['27']),
    payout: money(o['28']),
    at: Number(o['9'] ?? 0),
    lastEvent: events.at(-1)?.['3'] ?? '',
  }
}

async function request({ developerId, days, from, to, pageSize, origin }) {
  const headers = [
    'Content-Type:application/json+protobuf',
    'X-Goog-AuthUser:0',
    `Authorization:${await authorization(origin)}`,
    `X-Goog-Api-Key:${API_KEY}`,
  ].join('\r\n')

  // A window if one was named, otherwise the last `days` up to now. Named
  // windows are what let a long span be walked in pieces Play will actually
  // serve: asked for a year in one request it answers 500, not fewer orders.
  const now = Math.floor(Date.now() / 1000)
  const since = from == null ? now - days * 86400 : Math.floor(from / 1000)
  const until = to == null ? now + 86400 : Math.floor(to / 1000)
  return fetch(
    `${HOST}/v1/developer/${developerId}/orders:fetch?%24httpHeaders=${encodeURIComponent(headers)}`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json+protobuf' },
      body: JSON.stringify({
        4: { 1: { 1: String(since), 2: 0 }, 2: { 1: String(until), 2: 0 }, 3: '' },
        5: { 1: String(developerId) },
        7: '',
        8: pageSize,
      }),
    },
  )
}

export async function fetchOrders({ developerId, days = 2, from, to, pageSize = 50 }) {
  const { workingOrigin } = await chrome.storage.local.get({ workingOrigin: null })
  const candidates = ORIGIN_CANDIDATES.map((o) => (typeof o === 'function' ? o() : o))
  const ordered = workingOrigin
    ? [workingOrigin, ...candidates.filter((o) => o !== workingOrigin)]
    : candidates

  let last = null
  for (const origin of ordered) {
    const res = await request({ developerId, days, from, to, pageSize, origin })
    if (res.ok) {
      if (origin !== workingOrigin) await chrome.storage.local.set({ workingOrigin: origin })
      const data = await res.json()
      return (data['1'] ?? []).map(normalize)
    }
    last = res.status
    // 401/403 means this origin was rejected; anything else is not about origin.
    if (res.status !== 401 && res.status !== 403) break
  }
  throw new Error(last === 401 || last === 403 ? 'auth' : `http ${last}`)
}

// A refund on an already-seen order has to read as new, so state is part of the
// identity — the same reason the RTDN design keyed on order id plus event kind.
export const keyFor = (o) => `${o.id}:${o.state}`
