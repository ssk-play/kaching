// Single source of truth for what is configurable. Both the options page and the
// service worker read defaults from here so the two can never disagree about
// what an unset field means.

import { dayKey, startOf, shift } from './totals.js'

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

  // delivery pace
  //
  // How often what has been collected is allowed out, which is a separate
  // question from how often Play is read. Someone who wants the day's orders in
  // one batch still wants the tally to be current when they ask /today, and
  // slowing the poll down to slow the messages down would cost them that.
  //
  // Off is as soon as an order is found, which is what this is for. On holds the
  // announcements and lets them out together; the orders are stored and counted
  // either way. A switch of its own rather than an hours field with a magic
  // zero, so turning it off for a week does not throw away the schedule that has
  // to be typed back in afterwards.
  deliveryScheduled: false,
  // Where the windows are counted from, as a wall clock in the zone above. Set
  // 05:00 with a 24-hour window and the day's takings arrive once, at five in
  // the morning, every morning.
  deliveryAnchor: '00:00',
  deliveryHours: 24,
  // The same hold, with no clock on it. Kept apart from the hours rather than
  // encoded as one of them, because a pause is a thing you switch back off
  // without having to remember what the number used to be.
  deliveryPaused: false,

  verbose: false,
}

// The hours worth offering as a list. Not a closed set — the field takes a typed
// number too, because the person who wants 4 should not have to petition for it.
export const DELIVERY_PRESETS = [1, 2, 3, 6, 12, 24]

export const HOUR_MS = 3_600_000

// A wall clock as minutes past midnight. Anything that is not one is midnight:
// the field is a time picker, so a bad value means storage written by hand or by
// an older build, and a delivery time nobody can explain is worse than the
// default they never set.
export function anchorMinutes(raw) {
  const [, h, m] = /^(\d{1,2}):(\d{2})$/.exec(String(raw ?? '').trim()) ?? []
  const hours = Number(h)
  const mins = Number(m)
  if (!(hours >= 0 && hours < 24 && mins >= 0 && mins < 60)) return 0
  return hours * 60 + mins
}

// What a time field should hold, given whatever it holds now. Blank is the
// default rather than an error, because clearing a time input is how a browser
// says "I have not decided", not "count from nowhere".
export const normalizeAnchor = (raw) => {
  const total = anchorMinutes(raw)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

// The start of the window the given instant falls in, counted from the anchor
// time in the zone the day itself is counted in. Anchored rather than measured
// from the last delivery: every-three-hours from 00:00 means 00:00, 03:00,
// 06:00 — times a person can name and expect — where a rolling three hours would
// drift by however long the browser happened to be asleep, and a "once a day"
// setting would land at a different time every day.
//
// The anchor is re-read each day rather than run forward from one fixed instant,
// so 05:00 is 05:00 on every one of them. A window length that does not divide
// the day is therefore cut short once a day, at the anchor — which is the answer
// that keeps the promise the setting makes, since the named time is the one
// thing the reader chose.
//
// Simple arithmetic off the anchor, so on the day a zone shifts its clocks the
// boundaries after the shift sit an hour off the named ones for the rest of that
// day. The alternative is a window that is not the length it says it is, twice a
// year, which is the worse of the two surprises.
export function windowStart(s, now = Date.now()) {
  const hours = Number(s?.deliveryHours) || 0
  if (!s?.deliveryScheduled || hours <= 0) return now
  const zone = zoneOf(s)
  const offset = anchorMinutes(s?.deliveryAnchor) * 60_000
  const today = dayKey(now, zone)
  // Before today's anchor, the window running is the one that opened under
  // yesterday's. Without this, everything between midnight and the anchor would
  // count from a boundary that has not happened yet.
  const base = startOf(today, zone) + offset
  const from = now < base ? startOf(shift(today, -1), zone) + offset : base
  const span = hours * HOUR_MS
  return from + Math.floor((now - from) / span) * span
}

// Whether this run may announce. Paused wins over everything; 0 hours means the
// question does not arise; otherwise it is one batch per window, and this window
// has not had its yet.
//
// Which is a different question from whether the window has just opened. A poll
// that lands at 09:00 on the dot is not something anyone can arrange — Chrome
// may have been asleep, and the check runs on its own interval — so the batch
// goes out at the first check of the window with something to say, and the
// window is then spent. That holds the promise the setting actually makes: never
// more than one interruption per window, at times counted from midnight.
//
// Never having delivered counts as due, so the first order after this is
// switched on arrives rather than starting the clock in silence.
export function deliveryDue(s, lastDeliveryAt, now = Date.now()) {
  if (s?.deliveryPaused) return false
  if (!s?.deliveryScheduled || !(Number(s?.deliveryHours) > 0)) return true
  return !lastDeliveryAt || lastDeliveryAt < windowStart(s, now)
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
