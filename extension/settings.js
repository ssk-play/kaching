// Single source of truth for what is configurable. Both the options page and the
// service worker read defaults from here so the two can never disagree about
// what an unset field means.

export const DEFAULTS = {
  // delivery
  botToken: '',
  chatId: '',
  senderName: '',

  // source
  consoleUrl: '',
  developerId: '',

  // what to notify
  notifyCharged: true,
  notifyRefunded: true,
  packages: '',
  minPayout: 0,

  // time
  //
  // One zone decides everything: which day an order is counted under, which day
  // /today means, which window /recount asks Play for, and what the clock in an
  // order line reads. They were not always the same zone, and a day fetched by
  // one calendar and filed by another is a day rebuilt from part of itself.
  //
  // Empty means the browser's own zone, which is right for the one machine this
  // runs on. It is a setting because that machine is not always where the
  // developer is, and because a UTC tally is a legitimate thing to want: it is
  // what the Play Console shows.
  timeZone: '',

  // message format
  // One clock, in the zone above — the zone the day under the order is counted
  // in. UTC is the second, for reconciling against the Play Console, and it is
  // off: two renderings of one instant is the kind of line that gets skipped
  // rather than read.
  showLocalTime: true,
  showUtcTime: false,
  showBreakdown: false,
  showDailyTotal: true,

  // questions
  //
  // A URL rather than a brand, because the shape below it is the same nearly
  // everywhere now. The defaults are the cheapest thing that works out of the
  // box; changing them points this at OpenAI, at a gateway, or at something on
  // the user's own machine.
  aiKey: '',
  aiBaseUrl: 'https://api.openai.com/v1',
  aiModel: 'gpt-4o-mini',
  // What the test button asks. Empty means the built-in probe, so a reader who
  // never touches it still gets a question that exercises a tool call — and one
  // who is chasing a particular wrong answer can put that question here and ask
  // it again without going back to Telegram each time.
  aiProbe: '',

  // schedule
  intervalMinutes: 10,
  days: 2,
  verbose: false,
}

export const load = () => chrome.storage.local.get(DEFAULTS)

// Users have a Console URL in front of them, not a developer id, so the id is
// derived rather than asked for.
export function developerIdFrom(url) {
  return /\/developers\/(\d{5,})/.exec(String(url ?? ''))?.[1] ?? ''
}

export const isConfigured = (s) => Boolean(s.botToken && s.chatId && s.developerId)

// The one zone. Read through this everywhere rather than defaulted per call
// site: a default written twice is how the tally and the fetch window came to
// disagree about what a day was.
//
// An unset field means the browser's, resolved fresh each time — a laptop that
// crosses a border keeps counting in the day the person holding it is living.
const here = () => Intl.DateTimeFormat().resolvedOptions().timeZone

// A stored name Intl will not take — a zone a later browser dropped, or a value
// written by an older build — must not be able to throw on every poll from here
// on. It falls back to the browser's, which is wrong by hours at worst; the
// alternative is a service worker that cannot file an order at all.
//
// Remembered for one name, because this is read once per order counted and the
// answer only changes when the setting does.
let checked = null
export const zoneOf = (s) => {
  const want = s?.timeZone
  if (!want) return here()
  if (checked?.name !== want) checked = { name: want, ok: isZone(want) }
  return checked.ok ? want : here()
}

// A zone name Intl will actually take. Anything else — a typo, a stale name a
// browser has dropped, a value from a build of Chrome without the full data —
// is refused at the form rather than thrown on every poll afterwards.
export function isZone(name) {
  if (!name) return true
  try {
    new Intl.DateTimeFormat('en', { timeZone: name })
    return true
  } catch {
    return false
  }
}

// Lets a stored developer id be shown back as the URL it was derived from, so
// the options form round-trips instead of clearing the id it cannot see.
export const consoleUrlFor = (id) =>
  id ? `https://play.google.com/console/u/0/developers/${id}/orders` : ''

// Number('') is 0 — finite — so testing the parsed value alone makes a fallback
// unreachable and turns a cleared field into the range minimum.
export function clampNumber(raw, [lo, hi], fallback) {
  const text = String(raw ?? '').trim()
  const n = Number(text)
  if (text === '' || !Number.isFinite(n)) return fallback
  return Math.min(hi, Math.max(lo, n))
}

export function packageList(packages) {
  return String(packages ?? '')
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter(Boolean)
}
