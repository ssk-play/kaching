// Unit tests for the parts of the extension that hold real logic. Kept outside
// extension/ so they are not shipped in the store package.
//
// Run: node --test tools/extension.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const EXT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension')
const messages = JSON.parse(fs.readFileSync(path.join(EXT, '_locales/en/messages.json'), 'utf8'))

// Stub only what these modules touch, and back i18n with the real catalogue so a
// renamed or missing key fails here rather than in the store build.
// Storage is stubbed per test by whatever needs it; the default is an install
// that has never counted anything.
let storage = {}
globalThis.chrome = {
  storage: { local: { get: async (defaults) => ({ ...defaults, ...storage }) } },
  i18n: {
    getMessage: (key, subs = []) => {
      const raw = messages[key]?.message
      assert.ok(raw !== undefined, `missing i18n key: ${key}`)
      return raw.replace(/\$(\d)/g, (_, n) => subs[Number(n) - 1] ?? '')
    },
  },
}

// Absolute paths must be file: URLs for dynamic import.
const load = (f) => import(pathToFileURL(path.join(EXT, f)).href)
const {
  DEFAULTS, developerIdFrom, packageList, isConfigured, consoleUrlFor, clampNumber, zoneOf, isZone,
} = await load('settings.js')
const { matches, plan } = await load('filters.js')
const { times, describe, feeRate, cycleOf, estimatedNet, isSettled } = await load('format.js')
const { shouldAlert, FAILS_BEFORE_ALERT, ALERT_COOLDOWN_MS } = await load('health.js')
const { ratesFrom, merge, payoutCurrency, convert, rateFor } = await load('fx.js')
const T = await load('totals.js')
const { chatsIn, menuFingerprint, MENU } = await load('telegram.js')
const { totalLine } = await load('format.js')
const { trim, MAX_ENTRIES } = await load('log.js')
const { rangeOf, byCurrency, byKind, MAX_RANGE_DAYS, tools: ledgerTools } = await load('ledger.js')
const {
  ask, textOf, isQuestion, freshTurns, nextTurns, endpointFor, MAX_TURNS_KEPT, HISTORY_TTL_MS,
  summarize, compacted, RECAP,
} = await load('llm.js')

// One wide span rather than a window per glyph. Half the pictograms this
// codebase carried were in the emoji planes ("🔔" U+1F514, "🔁" U+1F501) and half
// were far below them ("⏱" U+23F1, "⚠" U+26A0, "↩" U+21A9), so a class assembled
// from the ones somebody remembered has a hole for the ones they did not: "ℹ" is
// U+2139, "‼" U+203C, "⤴" U+2934.
//
// The bare forms are the point. "↩️" carries a trailing variation selector and
// matches on that alone, so a class that misses U+21A9 still passes every test
// written with the emoji-keyboard form while letting through the plain
// code-point form — which is exactly how "⏱" reached the failure alert.
//
// "→" is punctuation inside the span, so it is taken out by name. Starting the
// span above it instead is what left the hole in the first place.
//
// U+203C and U+2049 are named one by one because they are the only two emoji
// below U+2100; extending the span down to reach them would swallow the em
// dash, the ellipsis and the quotation marks these messages legitimately use.
const pictogram = (text) =>
  /[\u{203C}\u{2049}\u{2100}-\u{2BFF}\u{1F000}-\u{1FAFF}\u{FE0F}]/u.test(
    text.replaceAll('→', ''),
  )

test('the pictogram guard can see the characters it was written about', () => {
  // A guard that would not have caught them proves nothing, so it is checked
  // against the four this codebase actually carried — each in the bare form, not
  // only the variation-selector form that matches for the wrong reason.
  for (const glyph of ['↩', '↩️', '⚠', '⚠️', '⏱', '🔔', '🔁', 'ℹ', '‼', '⤴', '™']) {
    assert.equal(pictogram(glyph), true, glyph)
  }
  // And it does not fire on the punctuation the reports legitimately carry.
  // And not on the punctuation these messages legitimately carry, which is why
  // the span stops short of it and picks up its two exceptions by name.
  for (const plain of [
    'KR, USD 4.99 → KRW 6,500 net',
    'Today 2 orders · KRW 8,000',
    '오늘 11건 · KRW 56,671',
    'a — b … c "d" ₩1,000 ¥100',
  ]) {
    assert.equal(pictogram(plain), false, plain)
  }
})

test('no message the bot can send carries a pictogram', () => {
  // describe() is not the only report. The failure alert and the verbose status
  // line go to the same chat through the same sender, and both carried one until
  // this change — so the catalogue itself is what gets checked, in both
  // languages, rather than the one function whose output is easy to reach.
  for (const [locale, file] of [['en', 'en'], ['ko', 'ko']]) {
    const catalogue = JSON.parse(
      fs.readFileSync(path.join(EXT, `_locales/${file}/messages.json`), 'utf8'),
    )
    for (const [key, entry] of Object.entries(catalogue)) {
      assert.equal(pictogram(entry.message), false, `${locale}/${key}: ${entry.message}`)
    }
  }
})

const order = (over = {}) => ({
  id: 'GPA.1111-2222-3333-44444',
  state: 'charged',
  subscription: false,
  product: 'Premium',
  sku: 'premium_unlock',
  packageName: 'com.example.app',
  country: 'KR',
  total: { currency: 'USD', amount: 4.99 },
  beforeFee: { currency: 'USD', amount: 4.54 },
  tax: { currency: 'USD', amount: 0.45 },
  net: { currency: 'USD', amount: 3.86 },
  payout: { currency: 'KRW', amount: 6500 },
  at: Date.UTC(2026, 7, 18, 23, 40),
  ...over,
})

test('developerIdFrom reads the id out of a Console URL', () => {
  assert.equal(
    developerIdFrom('https://play.google.com/console/u/0/developers/9876543210987654321/orders'),
    '9876543210987654321',
  )
  assert.equal(developerIdFrom('https://play.google.com/console/u/2/developers/12345/app/x'), '12345')
  assert.equal(developerIdFrom('https://play.google.com/console/'), '')
  assert.equal(developerIdFrom(''), '')
  assert.equal(developerIdFrom(undefined), '')
})

test('packageList tolerates the separators users actually type', () => {
  assert.deepEqual(packageList('a.b, c.d'), ['a.b', 'c.d'])
  assert.deepEqual(packageList(' a.b \n c.d '), ['a.b', 'c.d'])
  assert.deepEqual(packageList(''), [])
  assert.deepEqual(packageList(undefined), [])
})

test('isConfigured requires all three of token, chat and developer id', () => {
  assert.equal(isConfigured({ botToken: 't', chatId: 'c', developerId: 'd' }), true)
  assert.equal(isConfigured({ botToken: 't', chatId: 'c', developerId: '' }), false)
  assert.equal(isConfigured({ botToken: '', chatId: 'c', developerId: 'd' }), false)
})

test('state toggles gate their own event only', () => {
  const s = { ...DEFAULTS, notifyRefunded: false }
  assert.equal(matches(order(), s), true)
  assert.equal(matches(order({ state: 'refunded' }), s), false)

  const r = { ...DEFAULTS, notifyCharged: false }
  assert.equal(matches(order(), r), false)
  assert.equal(matches(order({ state: 'refunded' }), r), true)
})

test('empty package filter means every app', () => {
  assert.equal(matches(order(), { ...DEFAULTS, packages: '' }), true)
  assert.equal(matches(order(), { ...DEFAULTS, packages: 'com.example.app' }), true)
  assert.equal(matches(order(), { ...DEFAULTS, packages: 'com.other' }), false)
  assert.equal(matches(order(), { ...DEFAULTS, packages: 'com.other, com.example.app' }), true)
})

test('minPayout of zero notifies everything, one hides free test orders', () => {
  const free = order({ total: { currency: 'KRW', amount: 0 }, payout: { currency: 'KRW', amount: 0 } })
  assert.equal(matches(free, { ...DEFAULTS, minPayout: 0 }), true)
  assert.equal(matches(free, { ...DEFAULTS, minPayout: 1 }), false)
  assert.equal(matches(order(), { ...DEFAULTS, minPayout: 1 }), true)
})

test('minPayout is compared in the currency it was written in', () => {
  // The minimum is a payout figure. An unsettled order only carries the buyer's
  // total, so it has to be converted first — comparing USD 4.99 against a KRW
  // minimum muted real orders, and muting a refund leaves the charge it undoes
  // in the running total for good.
  const unsettled = order({ payout: null })
  const usd = { currency: 'USD', rates: {} }
  assert.equal(matches(unsettled, { ...DEFAULTS, minPayout: 4 }, usd), true)
  assert.equal(matches(unsettled, { ...DEFAULTS, minPayout: 5 }, usd), false)
  // Converted, USD 4.99 clears a KRW minimum it would fail as a bare number.
  const krw = { currency: 'KRW', rates: { 'USD>KRW': 1392.9 } }
  assert.equal(matches(unsettled, { ...DEFAULTS, minPayout: 5000 }, krw), true)
  // No rate to cross means no comparison to make, and failing to hush an order
  // is the cheaper mistake.
  assert.equal(matches(unsettled, { ...DEFAULTS, minPayout: 5000 }, { currency: 'KRW' }), true)
  // A settled payout is already the right currency and needs no help.
  assert.equal(matches(order(), { ...DEFAULTS, minPayout: 7000 }, krw), false)
})

// The text between a call's parentheses, and how many arguments it splits into.
// A regex cannot do this: dayKey(Date.now(), zone) closes an inner paren first,
// and a nested comma belongs to the inner call rather than the outer one.
function argsAt(text, start) {
  let depth = 0
  for (let i = start; i < text.length; i += 1) {
    const c = text[i]
    if (c === '(') depth += 1
    else if (c === ')') {
      if (depth === 0) return text.slice(start, i)
      depth -= 1
    }
  }
  return text.slice(start)
}

function topLevelCommas(args) {
  let depth = 0
  let found = 0
  for (const c of args) {
    if ('([{'.includes(c)) depth += 1
    else if (')]}'.includes(c)) depth -= 1
    else if (c === ',' && depth === 0) found += 1
  }
  return found
}

test('an unusable stored zone falls back rather than breaking every poll', () => {
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone
  assert.equal(zoneOf({ timeZone: 'Asia/Seoul' }), 'Asia/Seoul')
  // Unset means the browser's, so a fresh install counts in the day of whoever
  // is looking at it.
  assert.equal(zoneOf({ timeZone: '' }), here)
  assert.equal(zoneOf({}), here)
  assert.equal(zoneOf(null), here)
  // A name Intl will not take — a zone a later browser dropped, or a value from
  // an older build. Wrong by hours at worst; the alternative is a worker that
  // throws on every order it tries to file.
  assert.equal(zoneOf({ timeZone: 'Mars/Olympus' }), here)
  assert.equal(isZone('Mars/Olympus'), false)
  assert.equal(isZone('Asia/Seoul'), true)
  // Empty is not invalid, it is unset.
  assert.equal(isZone(''), true)
  // The memo is per name, so two zones in a row do not answer with the first.
  assert.equal(zoneOf({ timeZone: 'UTC' }), 'UTC')
  assert.equal(zoneOf({ timeZone: 'Mars/Olympus' }), here)
  assert.equal(zoneOf({ timeZone: 'Asia/Kolkata' }), 'Asia/Kolkata')
})

test('every element the options page reaches for is in the options page', () => {
  // options.js is not loaded here — it needs a DOM and a chrome.* that this
  // harness has no reason to build. What it does have is one failure mode worth
  // catching without either: $('sample') on an id nobody added to the HTML,
  // which throws on load and leaves the whole settings page blank.
  const js = fs.readFileSync(path.join(EXT, 'options.js'), 'utf8')
  const html = fs.readFileSync(path.join(EXT, 'options.html'), 'utf8')
  const present = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]))
  const wanted = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]))
  assert.ok(wanted.size > 10, 'the id scan found nothing, so it is checking nothing')
  for (const id of wanted) assert.ok(present.has(id), `options.html has no #${id}`)

  // And every i18n key the page names is in the catalogue, for the same reason:
  // a missing one renders as an empty label rather than as an error.
  for (const m of html.matchAll(/data-i18n(?:-placeholder)?="([^"]+)"/g)) {
    assert.ok(messages[m[1]], `no such message: ${m[1]}`)
  }
})

test('nothing in the extension reads a day without naming the zone', () => {
  // The guard the argument cannot give on its own. dayKey throws on a missing
  // zone, but only when that line runs — and the line that files an order into a
  // day runs on a poll, in a service worker, where a throw is a log entry nobody
  // reads. Caught here instead, where it is a failing build.
  //
  // Read off the source rather than asserted in prose: this is a rule about
  // every call site, and a rule about every call site has to be checked against
  // all of them.
  for (const file of fs.readdirSync(EXT).filter((f) => f.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(EXT, file), 'utf8')
    for (const call of text.matchAll(/\b(dayKey|startOf|endOf)\(/g)) {
      const args = argsAt(text, call.index + call[0].length)
      // The definitions themselves, whose parameter list is the thing being
      // required rather than a call that has to satisfy it.
      if (/^(ms|key), timeZone$/.test(args)) continue
      assert.ok(
        topLevelCommas(args) >= 1,
        `${file}: ${call[1]}(${args}) — a day read with no zone is the second calendar`,
      )
    }
  }
})

test('the clock reads in the configured zone, with UTC beside it', () => {
  const at = Date.UTC(2026, 7, 18, 23, 40)
  const seoul = { timeZone: 'Asia/Seoul', showLocalTime: true, showUtcTime: true }
  // The zone that decides the day leads, because the day printed here is the day
  // the total under it belongs to. UTC follows, for reconciling with the Console.
  assert.equal(times(at, seoul), '2026-08-19 08:40 GMT+9 / 2026-08-18 23:40 UTC')
  assert.equal(times(at, { ...seoul, showLocalTime: false }), '2026-08-18 23:40 UTC')
  assert.equal(times(at, { ...seoul, showUtcTime: false }), '2026-08-19 08:40 GMT+9')
  // Both off is a choice, not an error: the line disappears.
  assert.equal(times(at, { ...seoul, showLocalTime: false, showUtcTime: false }), '')

  // An unset zone is the browser's, so a fresh install shows the reader's own
  // clock without being told what it is.
  assert.match(times(at, { showLocalTime: true, showUtcTime: false }), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)

  // A zone that IS UTC prints one line, not the same instant twice under two
  // names — which is what a developer who picks UTC has asked for.
  assert.equal(times(at, { timeZone: 'UTC', showLocalTime: true, showUtcTime: true }), '2026-08-18 23:40 UTC')
})

test('an order reads as five lines, each answering one question', () => {
  // What kind of sale, what sold and from which app, for how much and where,
  // when, and which order. Pinned whole because the value of the shape is that
  // it is the same shape every time — a reader scanning a month of these is
  // reading down a column, not across a sentence.
  // The zone is named rather than left to the browser, so this pins a shape
  // instead of pinning whatever machine ran it.
  const s = { ...DEFAULTS, senderName: '', timeZone: 'Asia/Seoul', showUtcTime: false }
  assert.deepEqual(describe(order(), s).split('\n'), [
    'Purchase',
    // The product id, not its display name: "premium_unlock" is what the
    // Console, a receipt and a support ticket all call this thing.
    'com.example.app, premium_unlock',
    // What the buyer paid, then what lands in the account. No arrow and no
    // labels — the order says which is which and the currencies say it again.
    'KR, USD 4.99, KRW 6,500',
    // The id above the time, because the id is what gets copied into the Console
    // and the time is what gets glanced at.
    'GPA.1111-2222-3333-44444',
    '2026-08-19 08:40 GMT+9',
  ])
})

test('describe omits the sender label when it is blank', () => {
  const bare = describe(order(), { ...DEFAULTS, senderName: '' })
  assert.ok(bare.startsWith('Purchase'), bare)
  const tagged = describe(order(), { ...DEFAULTS, senderName: 'shop' })
  assert.ok(tagged.startsWith('[shop] Purchase'), tagged)
})

test('describe distinguishes refunds and subscriptions, without pictograms', () => {
  // A line of chat that leads with an emoji reads as an advertisement, and this
  // one is a record.
  assert.ok(describe(order({ state: 'refunded' }), DEFAULTS).startsWith('Refund'))
  assert.ok(describe(order({ subscription: true }), DEFAULTS).startsWith('New subscription'))
  assert.equal(pictogram(describe(order(), DEFAULTS)), false)
  assert.equal(pictogram(describe(order({ state: 'refunded' }), DEFAULTS)), false)
})

test('describe drops empty lines rather than printing blanks', () => {
  const sparse = describe(
    order({ country: '', total: null, payout: null, net: null, tax: null, beforeFee: null }),
    { ...DEFAULTS, showLocalTime: false, showUtcTime: false },
  )
  assert.ok(!sparse.includes('\n\n'), sparse)
  // No country and no figures, so the third line has nothing to say and goes
  // rather than printing a bare comma.
  assert.deepEqual(sparse.split('\n'), [
    'Purchase',
    'com.example.app, premium_unlock',
    order().id,
  ])
})

test('clampNumber falls back for blank input instead of clamping to the minimum', () => {
  // Number('') is 0 and finite; testing the parsed value alone silently turned a
  // cleared "check every" box into a 1-minute poll.
  assert.equal(clampNumber('', [1, 120], 10), 10)
  assert.equal(clampNumber('   ', [1, 120], 10), 10)
  assert.equal(clampNumber('abc', [1, 120], 10), 10)
  assert.equal(clampNumber(undefined, [1, 120], 10), 10)
  assert.equal(clampNumber('0', [1, 120], 10), 1)
  assert.equal(clampNumber('999', [1, 120], 10), 120)
  assert.equal(clampNumber('7', [1, 120], 10), 7)
})

test('a stored developer id round-trips through the URL field', () => {
  // An install predating the URL field would otherwise have its id wiped the
  // first time Save was pressed.
  const id = '9876543210987654321'
  assert.equal(developerIdFrom(consoleUrlFor(id)), id)
  assert.equal(consoleUrlFor(''), '')
  assert.equal(developerIdFrom(consoleUrlFor('')), '')
})

// plan() decides send order and what may be written off without being sent.
// These rules are easy to get subtly wrong and were, twice.
const orders = (n, over = {}) =>
  Array.from({ length: n }, (_, i) => order({ id: `GPA.0000-0000-0000-0000${i}`, ...over }))

test('plan sends oldest first within the batch', () => {
  // The API returns newest first; a burst should read in the order it happened.
  const page = orders(3)
  const { batch } = plan(page, [], DEFAULTS, 10)
  assert.deepEqual(batch.map((o) => o.id), [page[2].id, page[1].id, page[0].id])
})

test('plan separates the overflow tail from the batch instead of dropping it', () => {
  const page = orders(15)
  const { batch, overflow, freshCount } = plan(page, [], DEFAULTS, 10)
  assert.equal(batch.length, 10)
  assert.equal(overflow.length, 5)
  assert.equal(freshCount, 15)
  // Every fresh order is accounted for in exactly one bucket.
  const ids = new Set([...batch, ...overflow].map((o) => o.id))
  assert.equal(ids.size, 15)
})

test('plan puts filter-muted orders in muted, never in batch or overflow', () => {
  const page = [order({ id: 'GPA.0000-0000-0000-00001' }), order({ id: 'GPA.0000-0000-0000-00002', packageName: 'com.other' })]
  const { batch, overflow, muted, freshCount, unseenCount } = plan(
    page, [], { ...DEFAULTS, packages: 'com.example.app' }, 10,
  )
  assert.deepEqual(muted.map((o) => o.packageName), ['com.other'])
  assert.equal(batch.length, 1)
  assert.equal(overflow.length, 0)
  assert.equal(freshCount, 1)
  assert.equal(unseenCount, 2)
})

test('plan skips orders already recorded as seen', () => {
  const page = orders(3)
  const seen = [`${page[0].id}:charged`]
  const { batch, unseenCount } = plan(page, seen, DEFAULTS, 10)
  assert.equal(unseenCount, 2)
  assert.ok(!batch.some((o) => o.id === page[0].id))
})

test('plan treats a refund of a seen order as new', () => {
  // The dedupe key carries state, so a refund on an announced order re-fires.
  const charged = order({ id: 'GPA.0000-0000-0000-00009' })
  const refunded = order({ id: 'GPA.0000-0000-0000-00009', state: 'refunded' })
  const { batch } = plan([refunded], [`${charged.id}:charged`], DEFAULTS, 10)
  assert.equal(batch.length, 1)
  assert.equal(batch[0].state, 'refunded')
})

// This policy has been wrong in both directions across two review rounds, so it
// is pinned here rather than left to inspection.
test('shouldAlert stays quiet below the failure threshold', () => {
  const now = 1_000_000_000
  for (let f = 0; f < FAILS_BEFORE_ALERT; f++) assert.equal(shouldAlert(f, 0, now), false)
  assert.equal(shouldAlert(FAILS_BEFORE_ALERT, 0, now), true)
})

test('shouldAlert rate-limits a continuing outage to one alert per cooldown', () => {
  const sent = 500_000
  assert.equal(shouldAlert(4, sent, sent + 1000), false)
  assert.equal(shouldAlert(9, sent, sent + ALERT_COOLDOWN_MS), false)
  assert.equal(shouldAlert(4, sent, sent + ALERT_COOLDOWN_MS + 1), true)
})

test('shouldAlert still fires for a later outage the same day', () => {
  // Never clearing the cooldown once muted the second outage for 24 hours.
  const morning = 0
  assert.equal(shouldAlert(FAILS_BEFORE_ALERT, morning, ALERT_COOLDOWN_MS + 1), true)
})

test('shouldAlert cannot be re-armed by an intervening success', () => {
  // Clearing lastAlertAt on every success made the cooldown unreachable: a
  // flapping session then alerted every few polls, forever.
  const sent = 1_000_000
  const afterFlap = sent + 60_000 // fail,fail,fail -> success -> fail,fail,fail
  assert.equal(shouldAlert(FAILS_BEFORE_ALERT, sent, afterFlap), false)
})

test('the activity log keeps the newest entries when it overflows', () => {
  const entries = Array.from({ length: MAX_ENTRIES + 50 }, (_, i) => ({ at: i, key: 'logCheckNone' }))
  const kept = trim(entries)
  assert.equal(kept.length, MAX_ENTRIES)
  // Oldest dropped, newest retained — the log answers "what just happened".
  assert.equal(kept.at(-1).at, entries.at(-1).at)
  assert.equal(kept[0].at, 50)
})

test('trim leaves a short log untouched', () => {
  const entries = [{ at: 1 }, { at: 2 }]
  assert.deepEqual(trim(entries), entries)
  assert.deepEqual(trim([]), [])
})

test('feeRate is derived from the order, not assumed', () => {
  // Google takes 15% or 30% depending on the programme, so it has to be read
  // back out of the figures rather than hardcoded.
  assert.deepEqual(feeRate(order()), { percent: 15, derived: true })
  assert.deepEqual(
    feeRate(order({ beforeFee: { currency: 'USD', amount: 10 }, net: { currency: 'USD', amount: 7 } })),
    { percent: 30, derived: true },
  )
  assert.equal(feeRate(order({ beforeFee: null })), null)
  assert.equal(feeRate(order({ beforeFee: { currency: 'KRW', amount: 0 }, net: { currency: 'KRW', amount: 0 } })), null)
})

test('the price line is what was paid and what lands, in that order', () => {
  const line = (o) => describe(order(o), DEFAULTS).split('\n')[2]
  assert.equal(line(), 'KR, USD 4.99, KRW 6,500')
  // An unsettled order is estimated from the price, and reads exactly the same.
  // It used to carry "est. net, 15% fee assumed" — true, and read every day by
  // someone who already knew it. What makes losing it affordable is that the
  // estimate corrects itself: it is banked as a guess, and when Play settles,
  // the difference moves into the day and the chat is told.
  assert.equal(line({ payout: null, net: null }), 'KR, USD 4.99, USD 3.86')
  // A price with nothing to net off it is one figure, not a dangling comma.
  assert.equal(line({ payout: null, net: null, beforeFee: null, total: null }), 'KR')
})

test('the breakdown line appears only when asked for', () => {
  const off = describe(order(), { ...DEFAULTS, showBreakdown: false })
  assert.ok(!off.includes('fee 15%'), off)
  const on = describe(order(), { ...DEFAULTS, showBreakdown: true })
  // Tax and rate only. The net is on the price line above and is not repeated.
  assert.ok(on.includes('tax USD 0.45 · fee 15%'), on)
  assert.equal(on.split('\n').length, off.split('\n').length + 1, on)
})

test('an order with no tax figures still renders without an empty line', () => {
  const bare = describe(order({ tax: null, beforeFee: null, net: null }), {
    ...DEFAULTS,
    showBreakdown: true,
  })
  assert.ok(!bare.includes('\n\n'), bare)
})

test('a subscription renewal is not announced as a new subscription', () => {
  // Play appends "..N" to the base order id from the first renewal onwards, so
  // the charge number is readable off the id itself.
  assert.equal(cycleOf(order({ subscription: true })), 1)
  assert.equal(cycleOf(order({ subscription: true, id: 'GPA.1111-2222-3333-44444..0' })), 2)
  assert.equal(cycleOf(order({ subscription: true, id: 'GPA.1111-2222-3333-44444..11' })), 13)
  // A one-time purchase has no cycle at all, suffix or not.
  assert.equal(cycleOf(order({ id: 'GPA.1111-2222-3333-44444..0' })), null)

  const renewal = describe(order({ subscription: true, id: 'GPA.1111-2222-3333-44444..2' }), DEFAULTS)
  assert.ok(renewal.startsWith('Subscription #4'), renewal)
  assert.ok(describe(order({ subscription: true }), DEFAULTS).startsWith('New subscription\n'))
  // A refund stays a refund whatever charge it undoes.
  assert.ok(
    describe(order({ subscription: true, state: 'refunded', id: 'GPA.1..0' }), DEFAULTS)
      .startsWith('Refund'),
  )
})

test('an unsettled order still shows an estimated net', () => {
  // Play reports no net or payout until it settles, which used to drop the line
  // from one-time purchases entirely.
  const unsettled = { payout: null, net: null }
  assert.deepEqual(estimatedNet(order(unsettled)), { currency: 'USD', amount: 3.86 })
  // Without beforeFee the fee applies to the price with tax taken out.
  assert.deepEqual(estimatedNet(order({ ...unsettled, beforeFee: null })), {
    currency: 'USD',
    amount: 3.86,
  })
  // Tax that cannot be subtracted would leave a figure the breakdown beside it
  // contradicts, so nothing is printed rather than something that fails the check.
  assert.equal(
    estimatedNet(order({ ...unsettled, beforeFee: null, tax: { currency: 'KRW', amount: 600 } })),
    null,
  )
  // No tax at all means the charge already is the base.
  assert.deepEqual(estimatedNet(order({ ...unsettled, beforeFee: null, tax: null })), {
    currency: 'USD',
    amount: 4.24,
  })
  // Nothing to work from stays nothing rather than becoming a zero.
  assert.equal(estimatedNet(order({ ...unsettled, beforeFee: null, total: null })), null)

  assert.equal(describe(order(unsettled), DEFAULTS).split('\n')[2], 'KR, USD 4.99, USD 3.86')
})

test('the breakdown never restates an assumed fee as one read off the order', () => {
  const unsettled = { payout: null, net: null }
  assert.deepEqual(feeRate(order(unsettled)), { percent: 15, derived: false })

  // A tax figure is not what makes an estimate an estimate.
  const noTax = describe(order({ ...unsettled, tax: null, beforeFee: null }), DEFAULTS)
  assert.ok(noTax.includes('USD 4.24'), noTax)

  const on = describe(order(unsettled), { ...DEFAULTS, showBreakdown: true })
  assert.ok(on.includes('tax USD 0.45'), on)
  assert.ok(!on.includes('fee 15%'), on)
})
test('a refund always nets out negative, whatever sign Play put on it', () => {
  // The state is the reversal, so the direction comes from it and only the
  // magnitude is read out of the response. Play signing the payout either way
  // has to reach the same figure, or the running total depends on a convention
  // nothing here controls.
  assert.deepEqual(estimatedNet(order({ state: 'refunded' })), { currency: 'KRW', amount: -6500 })
  assert.deepEqual(
    estimatedNet(order({ state: 'refunded', payout: { currency: 'KRW', amount: -6500 } })),
    { currency: 'KRW', amount: -6500 },
  )
  // A reversal Play has not settled yet still has to leave the total, so it
  // reverses the same estimate the charge itself would have been given.
  const unsettled = { state: 'refunded', payout: null, net: null }
  assert.deepEqual(estimatedNet(order(unsettled)), { currency: 'USD', amount: -3.86 })
  const text = describe(order(unsettled), { ...DEFAULTS, showBreakdown: true })
  assert.ok(text.includes('KR, USD 4.99, USD -3.86'), text)
  // The fee is not restated: it was assumed rather than read off the order, and
  // the breakdown only prints a rate the order actually carries.
  assert.ok(!text.includes('15%'), text)
})

test('a reversal lands on exactly the figure it undoes', () => {
  // Rounding that always breaks upwards would leave a charge and its refund a
  // minor unit apart, and the residue would sit in the total for good.
  const half = { total: null, beforeFee: { currency: 'KRW', amount: 5903 }, tax: null, net: null, payout: null }
  const charge = estimatedNet(order(half))
  const back = estimatedNet(order({ ...half, state: 'refunded' }))
  assert.equal(charge.amount + back.amount, 0)
})

test('a reversal never prints a negative zero or a rate Google never charged', () => {
  // Both fall out of the sign: a zero-value test order is a documented case for
  // the minimum-payout setting, and 1 - (-3.86/4.54) is 185%.
  const free = {
    state: 'refunded', total: { currency: 'USD', amount: 0 },
    beforeFee: null, tax: null, net: null, payout: { currency: 'USD', amount: 0 },
  }
  assert.ok(Object.is(estimatedNet(order(free)).amount, 0))
  assert.ok(describe(order(free), DEFAULTS).includes('KR, USD 0, USD 0'), describe(order(free), DEFAULTS))
  const signed = order({ state: 'refunded', net: { currency: 'USD', amount: -3.86 } })
  assert.deepEqual(feeRate(signed), { percent: 15, derived: true })
})

test('a minimum payout hides small orders, not reversals', () => {
  // The minimum is about size. Comparing the signed figure put every negatively
  // signed refund below every positive threshold, muting the one order whose
  // whole job is to take money back out of the total.
  const settings = { ...DEFAULTS, minPayout: '1000' }
  assert.equal(matches(order({ payout: { currency: 'KRW', amount: 8500 } }), settings), true)
  assert.equal(
    matches(order({ state: 'refunded', payout: { currency: 'KRW', amount: -8500 } }), settings),
    true,
  )
  // A reversal of an order too small to announce stays too small to announce.
  assert.equal(
    matches(order({ state: 'refunded', payout: { currency: 'KRW', amount: -10 } }), settings),
    false,
  )
})

test('the breakdown states a derived rate even where no tax was withheld', () => {
  // With the net no longer repeated here, the rate is the only thing this line
  // still contributes — gating it on tax hid it in every tax-free jurisdiction.
  const noTax = describe(
    order({ tax: null, beforeFee: { currency: 'USD', amount: 4.99 }, net: { currency: 'USD', amount: 3.49 } }),
    { ...DEFAULTS, showBreakdown: true },
  )
  assert.ok(noTax.includes('fee 30%'), noTax)
  assert.ok(!noTax.includes('tax'), noTax)
  assert.ok(!noTax.includes('\n\n'), noTax)
})

test('an estimate is rounded to the currency it is quoted in', () => {
  // KRW and JPY have no minor unit, so a raw 0.85x lands on an amount that
  // cannot exist — and Korean developers are the ones who would see it most.
  const krw = estimatedNet(
    order({
      payout: null, net: null, beforeFee: null,
      total: { currency: 'KRW', amount: 5900 },
      tax: { currency: 'KRW', amount: 536 },
    }),
  )
  assert.deepEqual(krw, { currency: 'KRW', amount: 4559 })
  // Currencies that do have cents keep them.
  assert.deepEqual(estimatedNet(order({ payout: null, net: null })), {
    currency: 'USD',
    amount: 3.86,
  })
})

test('the product ID is what prints, not the name it is shown under', () => {
  // The name is editable in the Console; the ID is what every API and every
  // line of the developer's own code keys on — so the ID is what the line can
  // still be found by after someone renames the product. It also spared this
  // line a parenthesis inside a line that already had a comma in it.
  const line = (o) => describe(order(o), DEFAULTS).split('\n')[1]
  assert.equal(line(), 'com.example.app, premium_unlock')
  // The name is the fallback for a product that arrives without an ID, not a
  // second thing to print beside one.
  assert.equal(line({ sku: '' }), 'com.example.app, Premium')
  assert.equal(line({ product: '' }), 'com.example.app, premium_unlock')
  assert.equal(line({ sku: '', product: '' }), 'com.example.app')
})

test('the exchange rate is read off orders Play has already settled', () => {
  // Both figures ride on every settled order, so the rate is in hand without
  // calling anything — which an extension that promises nothing leaves the
  // browser could not do anyway.
  const settled = [
    { state: 'charged', at: 2, net: { currency: 'NOK', amount: 64.6 }, payout: { currency: 'KRW', amount: 9633 } },
    { state: 'charged', at: 1, net: { currency: 'USD', amount: 1.69 }, payout: { currency: 'KRW', amount: 2354 } },
    // Nothing to learn from these.
    { state: 'charged', at: 3, net: null, payout: { currency: 'KRW', amount: 10 } },
    { state: 'charged', at: 4, net: { currency: 'KRW', amount: 5 }, payout: { currency: 'KRW', amount: 5 } },
  ]
  const rates = ratesFrom(settled)
  assert.deepEqual(Object.keys(rates).sort(), ['NOK>KRW', 'USD>KRW'])
  assert.ok(Math.abs(rates['NOK>KRW'] - 9633 / 64.6) < 1e-9)
  assert.equal(rates['KRW>KRW'], undefined)

  assert.equal(payoutCurrency(settled), 'KRW')
  assert.equal(payoutCurrency([]), null)

  // Yesterday's rate survives a day when nothing settled in that currency.
  assert.deepEqual(merge({ 'JPY>KRW': 9 }, { 'USD>KRW': 1300 }), { 'JPY>KRW': 9, 'USD>KRW': 1300 })
  assert.deepEqual(merge({ 'USD>KRW': 1200 }, { 'USD>KRW': 1300 }), { 'USD>KRW': 1300 })
})

test('an unobserved currency pair is left alone rather than guessed at', () => {
  const rates = { 'USD>KRW': 1300 }
  assert.deepEqual(convert({ currency: 'USD', amount: 2 }, 'KRW', rates), {
    currency: 'KRW',
    amount: 2600,
  })
  // Already there.
  assert.deepEqual(convert({ currency: 'KRW', amount: 5 }, 'KRW', rates), { currency: 'KRW', amount: 5 })
  // Never seen: null, so the caller keeps the buyer-currency figure.
  assert.equal(convert({ currency: 'NOK', amount: 10 }, 'KRW', rates), null)
  assert.equal(convert(null, 'KRW', rates), null)
  assert.equal(convert({ currency: 'USD', amount: 2 }, null, rates), null)
})

test('an estimate is converted into the currency the developer is paid in', () => {
  // The whole complaint: a figure in the buyer's currency is not the number
  // anyone budgets in.
  const fx = { currency: 'KRW', rates: { 'USD>KRW': 1300 } }
  const unsettled = order({ payout: null, net: null })
  // 4.54 x 0.85 x 1300, rounded once at the end rather than twice.
  assert.deepEqual(estimatedNet(unsettled, fx), { currency: 'KRW', amount: 5017 })
  // Rounded to KRW's own unit, not carried at USD precision.
  assert.equal(Number.isInteger(estimatedNet(unsettled, fx).amount), true)

  assert.equal(describe(unsettled, DEFAULTS, fx).split('\n')[2], 'KR, USD 4.99, KRW 5,017')

  // No rate for the pair: the buyer-currency figure stands rather than a guess.
  assert.deepEqual(estimatedNet(unsettled, { currency: 'KRW', rates: {} }), {
    currency: 'USD',
    amount: 3.86,
  })
  // A settled order is Play's own payout and is never touched by any of this.
  assert.deepEqual(estimatedNet(order(), fx), { currency: 'KRW', amount: 6500 })
})

test('the newest settled order sets the rate, whatever order they arrive in', () => {
  // fetchOrders returns newest first, so keeping the last match would have kept
  // the oldest rate in the window — and re-learned it on every poll.
  const newest = { state: 'charged', at: 200, net: { currency: 'USD', amount: 1 }, payout: { currency: 'KRW', amount: 1400 } }
  const oldest = { state: 'charged', at: 100, net: { currency: 'USD', amount: 1 }, payout: { currency: 'KRW', amount: 1200 } }
  assert.equal(ratesFrom([newest, oldest])['USD>KRW'], 1400)
  assert.equal(ratesFrom([oldest, newest])['USD>KRW'], 1400)
})

test('a rate is never learned from a reversal or stored negative', () => {
  // Play's sign convention on a refund is not something to bet the whole
  // currency pair on: one mismatch would turn every later sale into money out.
  const refund = { state: 'refunded', at: 300, net: { currency: 'USD', amount: 3.86 }, payout: { currency: 'KRW', amount: -5300 } }
  assert.deepEqual(ratesFrom([refund]), {})
  const wrong = { state: 'charged', at: 300, net: { currency: 'USD', amount: 3.86 }, payout: { currency: 'KRW', amount: -5300 } }
  assert.deepEqual(ratesFrom([wrong]), {})
  // And a negative rate already in storage is refused on the way out.
  assert.equal(rateFor('USD', 'KRW', { 'USD>KRW': -1300 }), null)
  assert.equal(convert({ currency: 'USD', amount: 2 }, 'KRW', { 'USD>KRW': -1300 }), null)
})

test('a conversion states the rate it crossed at', () => {
  // Otherwise the breakdown cannot be reconciled with the price line, which is
  // the only reason the setting exists.
  const fx = { currency: 'KRW', rates: { 'USD>KRW': 1300 } }
  const text = describe(order({ payout: null, net: null }), { ...DEFAULTS, showBreakdown: true }, fx)
  assert.ok(text.includes('KR, USD 4.99, KRW 5,017'), text)
  assert.ok(text.includes('USD→KRW 1,300'), text)
  // Nothing crossed, nothing to disclose.
  const same = describe(order(), { ...DEFAULTS, showBreakdown: true }, fx)
  assert.ok(!same.includes('→KRW 1,300'), same)
})

test('one zone decides the day, and the fetch window for that day matches it', () => {
  // The tally counts in the zone the reader configured. What matters is not
  // which zone that is but that only one exists: a window fetched by one
  // calendar and filed by another is a day rebuilt from part of itself, which is
  // what a dated /recount was doing.
  const ms = Date.UTC(2026, 7, 18, 23, 40)
  assert.equal(T.dayKey(ms, 'Asia/Seoul'), '2026-08-19')
  assert.equal(T.dayKey(ms, 'UTC'), '2026-08-18')
  assert.equal(T.monthKey('2026-08-19'), '2026-08')

  // The zone is required, and refused loudly when missing. Intl reads an
  // undefined zone as the host's, so a forgotten argument would not fail — it
  // would file into the machine's own calendar, which is the second calendar
  // the argument exists to prevent.
  assert.throws(() => T.dayKey(ms, undefined), /time zone/)
  assert.throws(() => T.startOf('2026-08-19', ''), /time zone/)

  // The window /recount asks Play for is exactly one bucket, in every zone.
  for (const zone of ['Asia/Seoul', 'UTC', 'America/New_York', 'Asia/Kolkata', 'Pacific/Chatham']) {
    const day = '2026-08-19'
    const from = T.startOf(day, zone)
    const to = T.endOf(day, zone)
    assert.equal(T.dayKey(from, zone), day, zone)
    assert.equal(T.dayKey(to - 1, zone), day, zone)
    assert.equal(T.dayKey(to, zone), '2026-08-20', zone)
    // Half-open, so consecutive days meet exactly rather than overlapping.
    assert.equal(T.startOf('2026-08-20', zone), to, zone)
  }

  // Days are not all 24 hours long. Read at the wrong instant the offset is the
  // one either side of the change, and the day would start an hour off — on the
  // spring-forward day, inside an hour that does not exist.
  const ny = 'America/New_York'
  const hours = (day) => (T.endOf(day, ny) - T.startOf(day, ny)) / 3_600_000
  assert.equal(hours('2026-03-08'), 23)
  assert.equal(hours('2026-11-01'), 25)
  assert.equal(hours('2026-06-01'), 24)
  assert.equal(T.dayKey(T.startOf('2026-03-08', ny), ny), '2026-03-08')
})

test('totals sum a day and a month from the same buckets', () => {
  let b = {}
  const krw = (amount) => ({ currency: 'KRW', amount })
  b = T.record(b, '2026-08-19', { net: krw(5000), currency: 'KRW' })
  b = T.record(b, '2026-08-19', { net: krw(3000), currency: 'KRW' })
  b = T.record(b, '2026-08-20', { net: krw(1000), currency: 'KRW' })
  b = T.record(b, '2026-07-31', { net: krw(9999), currency: 'KRW' })

  // No buyer currency was handed in, so both charges are filed under the
  // unknown key rather than dropped — the split still accounts for every order.
  assert.deepEqual(T.sum(b, '2026-08-19'), {
    currency: 'KRW', amount: 8000, orders: 2, refunds: 0, refunded: 0, uncounted: 0,
    currencies: { '?': { amount: 8000, orders: 2, refunds: 0, refunded: 0, uncounted: 0 } },
    // The same money dealt a second way. No kind was handed in either, so both
    // splits file under the unknown key and both still add up to the day.
    kinds: { '?': { amount: 8000, orders: 2, refunds: 0, refunded: 0, uncounted: 0 } },
  })
  // Same function answers the month, so the two figures cannot drift apart.
  assert.equal(T.sum(b, '2026-08').amount, 9000)
  assert.equal(T.sum(b, '2026-08').orders, 3)
  assert.equal(T.sum(b, '2026-09').orders, 0)
})

test('a total never quietly absorbs money it could not convert', () => {
  // Adding NOK to a KRW total would produce a number that looks right and is
  // not, so it is counted apart and the line says so.
  let b = T.record({}, '2026-08-19', { net: { currency: 'NOK', amount: 64.6 }, currency: 'KRW', from: 'NOK' })
  assert.deepEqual(T.sum(b, '2026-08-19'), {
    currency: 'KRW', amount: 0, orders: 1, refunds: 0, refunded: 0, uncounted: 1,
    currencies: { NOK: { amount: 0, orders: 1, refunds: 0, refunded: 0, uncounted: 1 } },
    kinds: { '?': { amount: 0, orders: 1, refunds: 0, refunded: 0, uncounted: 1 } },
  })
  // A refund with no charge to take back out is left out of the amount the same
  // way, and disclosed the same way: the message above it printed a figure, so
  // the line has to say the amount does not carry it.
  // The reversal's own currency is still known even when its figure is not, so
  // the count lands under it rather than under the unknown key.
  b = T.record(b, '2026-08-19', { net: null, refund: true, currency: 'KRW', from: 'NOK' })
  assert.deepEqual(T.sum(b, '2026-08-19'), {
    currency: 'KRW', amount: 0, orders: 1, refunds: 1, refunded: 0, uncounted: 2,
    currencies: { NOK: { amount: 0, orders: 1, refunds: 1, refunded: 0, uncounted: 2 } },
    kinds: { '?': { amount: 0, orders: 1, refunds: 1, refunded: 0, uncounted: 2 } },
  })
})

test('a refund comes back out of the running total', () => {
  // The whole point of the sign: the day's figure has to fall when money is
  // handed back, not just carry a refund count beside an unchanged number.
  let b = T.record({}, '2026-08-19', { net: { currency: 'KRW', amount: 6500 }, currency: 'KRW' })
  b = T.record(b, '2026-08-19', { net: { currency: 'KRW', amount: -6500 }, refund: true, currency: 'KRW' })
  assert.deepEqual(T.sum(b, '2026-08-19'), {
    currency: 'KRW', amount: 0, orders: 1, refunds: 1, refunded: -6500, uncounted: 0,
    currencies: { '?': { amount: 0, orders: 1, refunds: 1, refunded: -6500, uncounted: 0 } },
    kinds: { '?': { amount: 0, orders: 1, refunds: 1, refunded: -6500, uncounted: 0 } },
  })
})

test('the charge ledger keeps what each charge added, and evicts the oldest', () => {
  // A reversal takes out exactly what its charge put in, so the amount is kept
  // beside the id — an unsettled reversal re-estimated at the default fee rate
  // would not cancel a charge counted from Play's reported payout.
  const krw = (amount) => ({ currency: 'KRW', amount })
  let led = []
  for (const [id, amount] of [['a', 10], ['b', 20], ['a', 99], ['c', 30]]) {
    led = T.remember(led, id, krw(amount), 3)
  }
  assert.deepEqual(led, [['a', 10, 'KRW'], ['b', 20, 'KRW'], ['c', 30, 'KRW']])
  assert.equal(T.amountFor(led, 'b', 'KRW'), 20)
  assert.equal(T.amountFor(led, 'zz', 'KRW'), null)
  // A figure counted in one payout currency is not taken out of a total kept in
  // another.
  assert.equal(T.amountFor(led, 'b', 'USD'), null)
  // Already present is a no-op, not a re-append that would push out a live entry
  // and overwrite the figure with a later estimate of the same order.
  assert.equal(T.remember(led, 'a', krw(99), 3), led)
  assert.deepEqual(T.remember(led, 'd', krw(40), 3), [['b', 20, 'KRW'], ['c', 30, 'KRW'], ['d', 40, 'KRW']])
})

test('a zero entry matches whatever currency the total is now kept in', () => {
  // First sync banks the history it adopted at zero, before any rate has been
  // learned and so before the payout currency is known. That entry still has to
  // match, or the refund of an adopted order falls through to an estimate of
  // money the totals never received.
  const led = T.remember([], 'a', { currency: null, amount: 0 })
  assert.equal(T.amountFor(led, 'a', 'KRW'), 0)
})

test('startedAt reads the day counting began off the buckets', () => {
  // The ledger shipped after the totals did, so this is what tells a refund of a
  // charge counted by the older build from a refund of history nothing counted.
  assert.equal(T.startedAt({}), null)
  assert.equal(
    T.startedAt({ '2026-08-19': {}, '2026-07-31': {}, '2026-08-01': {} }),
    Date.UTC(2026, 6, 31),
  )
})

test('a correction moves the amount and leaves the counts alone', () => {
  // It corrects money the tally got wrong, not an order it failed to see, so
  // inventing an order would make the count disagree with the messages sent.
  const day = { '2026-08-19': { currency: 'KRW', amount: 8000, orders: 2, refunds: 0, refunded: 0, uncounted: 0 } }
  const down = T.adjust({}, '2026-08-19', { currency: 'KRW', amount: -6500 })
  // A correction belongs to no buyer, so it adds nothing to the split.
  assert.deepEqual(T.sum(down, '2026-08-19'), {
    currency: 'KRW', amount: -6500, orders: 0, refunds: 0, refunded: 0, uncounted: 0,
    currencies: {}, kinds: {},
  })
  // Both directions, and read together with what was announced.
  const up = T.adjust(down, '2026-08-19', { currency: 'KRW', amount: 500 })
  const both = T.combine(T.sum(day, '2026-08-19'), T.sum(up, '2026-08-19'))
  assert.deepEqual(both, {
    currency: 'KRW', amount: 2000, orders: 2, refunds: 0, refunded: 0, uncounted: 0,
    currencies: {}, kinds: {},
  })
  // A correction in another currency is refused rather than added across.
  assert.equal(T.adjust(up, '2026-08-19', { currency: 'USD', amount: 5 }), null)
})

test('combine never adds a correction across currencies', () => {
  // Same rule the buckets already follow for orders: a figure that looks right
  // and is not is worse than one the line admits it could not use.
  const announced = { currency: 'KRW', amount: 8000, orders: 2, refunds: 0, refunded: 0, uncounted: 0 }
  const crossed = { currency: 'USD', amount: 5, orders: 0, refunds: 0, refunded: 0, uncounted: 0 }
  assert.deepEqual(T.combine(announced, crossed), { ...announced, uncounted: 1 })
  // Nothing to add is not a currency clash.
  const none = { currency: null, amount: 0, orders: 0, refunds: 0, refunded: 0, uncounted: 0 }
  assert.deepEqual(T.combine(announced, none), announced)
})

test('buckets are bounded so a year of history cannot grow without limit', () => {
  const many = Object.fromEntries(
    Array.from({ length: 5 }, (_, i) => [`2026-01-0${i + 1}`, { currency: 'KRW', amount: i, orders: 1, refunds: 0, refunded: 0, uncounted: 0 }]),
  )
  const kept = T.trim(many, 3)
  // Oldest dropped, newest kept — ISO keys sort chronologically, which is the
  // whole reason for that format.
  assert.deepEqual(Object.keys(kept), ['2026-01-03', '2026-01-04', '2026-01-05'])
  assert.deepEqual(T.trim(many, 5), many)
})

test('one formatter draws both the footer and the /today answer', () => {
  // Same function, same buckets, same prefix rules — so the figure the chat
  // volunteers under an order cannot disagree with the one it reports when
  // asked. Only the leading word differs.
  const totals = { currency: 'KRW', amount: 8000, orders: 2, refunds: 1, uncounted: 0 }
  assert.equal(totalLine('totalToday', totals), 'Today 2 orders · KRW 8,000 · 1 refund')
  assert.equal(totalLine('totalMonth', totals), 'This month 2 orders · KRW 8,000 · 1 refund')
  assert.equal(
    totalLine('totalToday', totals).replace('Today', ''),
    totalLine('totalMonth', totals).replace('This month', ''),
  )
  // Nothing yet is nothing to say under an order; the query path supplies its
  // own zero line instead.
  assert.equal(totalLine('totalToday', { currency: null, amount: 0, orders: 0, refunds: 0, uncounted: 0 }), null)
  // Unless a correction put an amount there with nothing announced behind it.
  assert.equal(
    totalLine('totalDay', { currency: 'KRW', amount: -6500, orders: 0, refunds: 0, uncounted: 0 }),
    '0 orders · KRW -6,500',
  )
  assert.equal(totalLine('totalToday', null), null)
  assert.ok(totalLine('totalToday', { ...totals, uncounted: 2 }).endsWith('2 not in the total'))
})

test('English counts read right at one, not "1 orders"', () => {
  // The default footer means the first order of every single day would have
  // shown it — chrome.i18n has no plural forms, so the singular is its own key.
  const one = { currency: 'KRW', amount: 5020, orders: 1, refunds: 1, uncounted: 0 }
  // With what the refund was worth, once the bucket carries it: a count on its
  // own cannot tell a test purchase from the month's biggest sale.
  assert.equal(
    totalLine('totalToday', { ...one, refunded: -6500 }),
    'Today 1 order · KRW 5,020 · 1 refund, KRW -6,500',
  )
  assert.equal(
    totalLine('totalToday', { ...one, refunds: 2, refunded: -11520 }),
    'Today 1 order · KRW 5,020 · 2 refunds, KRW -11,520',
  )
  // A bucket written before the field existed still reads, without an amount.
  assert.equal(totalLine('totalToday', one), 'Today 1 order · KRW 5,020 · 1 refund')
  assert.equal(totalLine('totalMonth', one), 'This month 1 order · KRW 5,020 · 1 refund')
})

test('a rate below 1 is disclosed as a number, not as zero', () => {
  // A developer paid in USD whose buyers pay in KRW: two decimal places would
  // print the rate as "0" on the line that exists to make the net checkable.
  const fx = { currency: 'USD', rates: { 'KRW>USD': 0.00073 } }
  const krw = order({
    payout: null, net: null, beforeFee: null, tax: null,
    total: { currency: 'KRW', amount: 12000 },
  })
  const text = describe(krw, { ...DEFAULTS, showBreakdown: true }, fx)
  assert.ok(text.includes('KRW→USD 0.00073'), text)
  assert.ok(text.includes('KR, KRW 12,000, USD 7.45'), text)
})

test('a net Play reported but has not converted still lands in the payout currency', () => {
  // Field 27 filled, field 28 not yet: without this the order printed — and was
  // totalled — in a currency the developer is never paid in.
  const fx = { currency: 'KRW', rates: { 'USD>KRW': 1300 } }
  const half = order({ payout: null })
  assert.deepEqual(estimatedNet(half, fx), { currency: 'KRW', amount: 5018 })
  // Play's own payout is already there and is left exactly as reported.
  assert.deepEqual(estimatedNet(order(), fx), { currency: 'KRW', amount: 6500 })
  // No rate for the pair: the reported figure stands rather than a guess.
  assert.deepEqual(estimatedNet(half, { currency: 'KRW', rates: {} }), {
    currency: 'USD',
    amount: 3.86,
  })
})

test('chats are recognised from both private messages and channel posts', () => {
  // Find chat ID has to keep working after a poll has acknowledged the update
  // that named the chat, so the poller banks chats in this same shape.
  const list = [
    { update_id: 1, message: { chat: { id: 111, first_name: 'Ada' }, text: '/today' } },
    { update_id: 2, channel_post: { chat: { id: -222, title: 'Sales' }, text: 'hi' } },
    // Same chat twice is one entry.
    { update_id: 3, message: { chat: { id: 111, first_name: 'Ada' }, text: 'hi' } },
    { update_id: 4 },
  ]
  assert.deepEqual(chatsIn(list), [
    { id: 111, name: 'Ada' },
    { id: -222, name: 'Sales' },
  ])
  assert.deepEqual(chatsIn([]), [])
})

test('a week starts on Sunday and can straddle a month', () => {
  // 2026-08-19 is a Wednesday; its week began Sunday the 16th.
  assert.equal(T.weekStart('2026-08-19'), '2026-08-16')
  // A Sunday is its own start, not the week before.
  assert.equal(T.weekStart('2026-08-16'), '2026-08-16')
  // Saturday is the last day of the same week.
  assert.equal(T.weekStart('2026-08-22'), '2026-08-16')
  // 2026-09-01 is a Tuesday, so its week reaches back into August.
  assert.equal(T.weekStart('2026-09-01'), '2026-08-30')
})

test('the week total spans a month boundary the month total cannot', () => {
  const krw = (amount) => ({ currency: 'KRW', amount })
  let b = {}
  b = T.record(b, '2026-08-30', { net: krw(1000), currency: 'KRW' })  // Sunday
  b = T.record(b, '2026-08-31', { net: krw(2000), currency: 'KRW' })
  b = T.record(b, '2026-09-01', { net: krw(4000), currency: 'KRW' })
  b = T.record(b, '2026-08-29', { net: krw(500), currency: 'KRW' })   // Saturday, week before
  b = T.record(b, '2026-09-06', { net: krw(800), currency: 'KRW' })   // week after

  const today = '2026-09-01'
  const week = T.sumRange(b, T.weekStart(today), today)
  assert.equal(week.amount, 7000)
  assert.equal(week.orders, 3)
  // Neither month figure is the week's: August stops before the week ends,
  // September starts after it began, and both reach past it in the other
  // direction. That is exactly why the week is a range and not a prefix.
  assert.equal(T.sum(b, '2026-08').amount, 3500)
  assert.equal(T.sum(b, '2026-09').amount, 4800)
})

test('the week reads the same sentence as the day and the month', () => {
  const totals = { currency: 'KRW', amount: 8000, orders: 2, refunds: 0, uncounted: 0 }
  assert.equal(totalLine('totalWeek', totals), 'This week 2 orders · KRW 8,000')
  assert.equal(totalLine('totalWeek', { ...totals, orders: 1 }), 'This week 1 order · KRW 8,000')
})

// ------------------------------------------- questions asked in plain words

// A tally with two selling days, a gap, and a correction on one of them.
const ledger = () => {
  const krw = (amount) => ({ currency: 'KRW', amount })
  let totals = {}
  totals = T.record(totals, '2026-08-20', { net: krw(1000), currency: 'KRW' })
  totals = T.record(totals, '2026-08-22', { net: krw(4000), currency: 'KRW' })
  const adjustments = T.adjust({}, '2026-08-22', { currency: 'KRW', amount: -500 })
  return { totals, adjustments }
}

test('the ledger read reports a day that sold nothing, not just the days that did', () => {
  const { totals, adjustments } = ledger()
  const out = rangeOf(totals, adjustments, { from: '2026-08-20', to: '2026-08-22' }, '2026-08-25')
  assert.deepEqual(
    out.days.map((d) => [d.day, d.amount ?? 0]),
    [
      ['2026-08-20', 1000],
      ['2026-08-21', 0],
      // The hand-entered correction is read together with the tally, exactly as
      // /today reads it. A model told 4,000 here would contradict the command.
      ['2026-08-22', 3500],
    ],
  )
})

test('the ledger read says nothing about days before the tally began', () => {
  const { totals, adjustments } = ledger()
  const out = rangeOf(totals, adjustments, { from: '2026-08-01', to: '2026-08-22' }, '2026-08-25')
  // Not zeroes: those days have no entry because nothing was counting yet, and
  // reporting them as zero would be reporting a drought that never happened.
  assert.equal(out.since, '2026-08-20')
  assert.equal(out.days[0].day, '2026-08-20')
  assert.equal(out.days.length, 3)
})

test('an empty tally is said to be empty rather than answered with zeroes', () => {
  const out = rangeOf({}, {}, { from: '2026-08-01', to: '2026-08-02' }, '2026-08-25')
  assert.deepEqual(out.days, [])
  assert.equal(out.since, null)
  assert.ok(out.note)
})

test('a range reaching into the future is trimmed to today, not refused', () => {
  const { totals, adjustments } = ledger()
  // "this week" ends on Saturday; the question is still about the days that have
  // happened, so the days that have not are simply not there.
  const out = rangeOf(totals, adjustments, { from: '2026-08-20', to: '2026-08-31' }, '2026-08-21')
  assert.equal(out.days.at(-1).day, '2026-08-21')
  // A range that is entirely in the future has nothing to trim to.
  assert.ok(rangeOf(totals, adjustments, { from: '2026-09-01', to: '2026-09-02' }, '2026-08-21').error)
})

test('an over-long range comes back as something the model can act on', () => {
  // A tally that really does hold a year: the floor moves nothing, so the cap is
  // what stands between one question and a year of rows.
  const old = T.record({}, '2026-01-01', { net: { currency: 'KRW', amount: 100 }, currency: 'KRW' })
  const out = rangeOf(old, {}, { from: '2026-01-01', to: '2026-12-31' }, '2026-12-31')
  assert.match(out.error, new RegExp(String(MAX_RANGE_DAYS)))
  assert.ok(!out.days)
  // A malformed date is refused the same way rather than throwing into the loop.
  assert.ok(rangeOf({}, {}, { from: 'last monday', to: '2026-08-22' }, '2026-08-25').error)
})

test('the cap counts the rows that would be emitted, not the years asked about', () => {
  // "How did this year go" against a days-old install is a handful of rows. The
  // refusal would cost a turn teaching the model a start date it does not name.
  const { totals, adjustments } = ledger()
  const out = rangeOf(totals, adjustments, { from: '2026-01-01', to: '2026-08-25' }, '2026-08-25')
  assert.ok(!out.error)
  assert.equal(out.days.length, 6)
  assert.ok(out.days.length <= MAX_RANGE_DAYS)
})

// One canned exchange per fetch, so a test says exactly how many turns it expects.
function stubApi(replies) {
  const sent = []
  globalThis.fetch = async (_url, init) => {
    sent.push(JSON.parse(init.body))
    const reply = replies.shift()
    if (!reply) throw new Error('unexpected extra request')
    return { ok: true, json: async () => reply }
  }
  return sent
}

const says = (text) => ({
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }],
})
const reads = (input) => ({
  choices: [{
    finish_reason: 'tool_calls',
    message: {
      role: 'assistant',
      content: '',
      // A reasoning model returns its working alongside the answer; nothing here
      // may print it or send it back.
      reasoning_content: 'The user wants a range. I should call read_totals.',
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        // Arguments arrive as a string of JSON, not as an object.
        function: { name: 'read_totals', arguments: JSON.stringify(input) },
      }],
    },
  }],
})

test('the model is handed the figures it asked for and its answer comes back', async () => {
  storage = ledger()
  const sent = stubApi([reads({ from: '2026-08-20', to: '2026-08-22' }), says('3,500 KRW on the 22nd.')])
  const out = await ask({
    apiKey: 'k', baseUrl: 'https://api.example.com', model: 'm', question: 'how did last week go', today: '2026-08-25',
    tools: ledgerTools('2026-08-25'),
  })
  assert.equal(out, '3,500 KRW on the 22nd.')

  // One message per result, naming the call it answers. A call left without its
  // result is a conversation the API rejects on the next turn.
  const result = sent[1].messages.at(-1)
  assert.equal(result.role, 'tool')
  assert.equal(result.tool_call_id, 'call_1')
  assert.match(result.content, /2026-08-22/)
  // The assistant turn goes back whole: stripped to its prose, the tool_calls
  // the result answers would be pointing at nothing.
  const assistant = sent[1].messages.at(-2)
  assert.equal(assistant.role, 'assistant')
  assert.equal(assistant.tool_calls[0].id, 'call_1')
  // Its working stays behind. Providers differ on whether they accept their own
  // reasoning back, and none of them need it to continue.
  assert.equal('reasoning_content' in assistant, false)
  // The system prompt leads the conversation rather than riding beside it.
  assert.equal(sent[1].messages[0].role, 'system')
})

test('a tool the model invents is reported to it instead of losing the question', async () => {
  storage = ledger()
  const sent = stubApi([
    {
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_9', type: 'function',
            function: { name: 'write_totals', arguments: '{}' },
          }],
        },
      }],
    },
    says('I can only read the tally.'),
  ])
  assert.equal(
    await ask({ apiKey: 'k', baseUrl: 'https://api.example.com', model: 'm', question: 'set today to 0', today: '2026-08-25', tools: ledgerTools('2026-08-25') }),
    'I can only read the tally.',
  )
  // Reported back rather than thrown, and still naming the call, so the
  // conversation the next turn sends is one the API will accept.
  const failed = sent[1].messages.at(-1)
  assert.equal(failed.tool_call_id, 'call_9')
  assert.match(failed.content, /no such tool/)
})

test('a model that keeps reading is cut off rather than left to spend', async () => {
  storage = ledger()
  stubApi(Array.from({ length: 8 }, () => reads({ from: '2026-08-20', to: '2026-08-22' })))
  const out = await ask({
    apiKey: 'k', baseUrl: 'https://api.example.com', model: 'm', question: 'how did it go', today: '2026-08-25', tools: ledgerTools('2026-08-25'),
  })
  // Said plainly. A summary here would be a summary of figures it had not
  // finished gathering.
  assert.equal(out, messages.cmdAiGaveUp.message)
})

test('the API says why it refused, and that reaches the chat', async () => {
  globalThis.fetch = async () => ({
    ok: false,
    json: async () => ({ error: { message: 'credit balance is too low' } }),
  })
  await assert.rejects(
    ask({ apiKey: 'k', baseUrl: 'https://api.example.com', model: 'm', question: 'hi', today: '2026-08-25', tools: ledgerTools('2026-08-25') }),
    // An expired key and a spent balance are different problems with different
    // fixes; the status code alone tells the reader neither.
    /credit balance is too low/,
  )
})

test('a body that fails to arrive is a failure, not an empty answer', async () => {
  // The timeout firing mid-body leaves an ok response whose json() rejects.
  // Reported as nothing-came-back, it would send the reader off to ask again
  // rather than to look at their network.
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => {
      throw new Error('The operation was aborted due to timeout')
    },
  })
  await assert.rejects(
    ask({ apiKey: 'k', baseUrl: 'https://api.example.com', model: 'm', question: 'hi', today: '2026-08-25', tools: ledgerTools('2026-08-25') }),
    /aborted due to timeout/,
  )
  // A refusal is still allowed a body this cannot read: the status says enough.
  globalThis.fetch = async () => ({
    ok: false,
    status: 529,
    json: async () => {
      throw new Error('not json')
    },
  })
  await assert.rejects(
    ask({ apiKey: 'k', baseUrl: 'https://api.example.com', model: 'm', question: 'hi', today: '2026-08-25', tools: ledgerTools('2026-08-25') }),
    /529/,
  )
})

test('only the prose is answered with, never the working beside it', () => {
  // A chat that printed reasoning_content would be showing the reader a draft
  // they never asked for.
  assert.equal(
    textOf({ content: ' 3,500 KRW ', reasoning_content: 'let me think about August' }),
    '3,500 KRW',
  )
  assert.equal(textOf({ content: '' }), '')
  assert.equal(textOf(undefined), '')
})

test('a correction earlier than the first announced order is not clipped out', () => {
  const { totals } = ledger()
  // /adjust takes any past day, so a correction can predate everything the bot
  // announced. /today, /week and /month all count it; a floor read off the
  // announced days alone would leave the model contradicting them.
  const adjustments = T.adjust({}, '2026-08-10', { currency: 'KRW', amount: 9000 })
  const out = rangeOf(totals, adjustments, { from: '2026-08-01', to: '2026-08-22' }, '2026-08-25')
  assert.equal(out.since, '2026-08-10')
  assert.equal(out.days[0].day, '2026-08-10')
  assert.equal(out.days[0].amount, 9000)

  // The sharp case: a tally with nothing announced at all still has the
  // correction to report, and saying it has no days would contradict /today.
  const only = rangeOf({}, adjustments, { from: '2026-08-01', to: '2026-08-10' }, '2026-08-25')
  assert.deepEqual(only.days, [{ day: '2026-08-10', currency: 'KRW', amount: 9000, orders: 0 }])
})

test('a day that never happened is refused, not walked past', () => {
  const { totals, adjustments } = ledger()
  // 2026-04-31 is shape-perfect and parses as May 1st, so walking from it would
  // report a day that never existed and step straight over the one that did.
  assert.ok(rangeOf(totals, adjustments, { from: '2026-04-31', to: '2026-05-05' }, '2026-08-25').error)
  // Month 13 and day 32 do not parse at all; the answer is the same refusal
  // rather than a RangeError thrown into the loop.
  assert.ok(rangeOf(totals, adjustments, { from: '2026-13-01', to: '2026-05-05' }, '2026-08-25').error)
  assert.ok(rangeOf(totals, adjustments, { from: '2026-05-32', to: '2026-06-05' }, '2026-08-25').error)
  // A real leap day is not turned away with them.
  assert.ok(!rangeOf(totals, adjustments, { from: '2024-02-29', to: '2024-03-01' }, '2026-08-25').error)
})

test('a bucket key that does not parse cannot take every question down', () => {
  // /adjust validates the shape of a day, not that it exists, so "2026-00-15"
  // can reach storage. startedAt reads NaN off it and new Date(NaN) throws —
  // which would make every question fail while /today, /week and /month,
  // which match by prefix, kept looking healthy.
  const { totals } = ledger()
  const adjustments = T.adjust({}, '2026-00-15', { currency: 'KRW', amount: 5000 })
  const out = rangeOf(totals, adjustments, { from: '2026-08-20', to: '2026-08-22' }, '2026-08-25')
  assert.equal(out.since, '2026-08-20')
  assert.equal(out.days.length, 3)
})

test('a range written backwards is told so, not told the days are in the future', () => {
  const { totals, adjustments } = ledger()
  const back = rangeOf(totals, adjustments, { from: '2026-08-22', to: '2026-08-20' }, '2026-08-25')
  // Told the days had not happened yet, the model's only move is to reach
  // further back — which fails the same way until the turns run out.
  assert.match(back.error, /on or before/)
})

test('one day reads the same whether /today or the model asks for it', () => {
  const { totals, adjustments } = ledger()
  // The whole point of the shared fold: two answers about the same date cannot
  // come from two expressions that could drift apart.
  const row = rangeOf(totals, adjustments, { from: '2026-08-22', to: '2026-08-22' }, '2026-08-25').days[0]
  assert.equal(row.amount, T.dayOf(totals, adjustments, '2026-08-22').amount)
})

test('an earlier exchange is replayed so a follow-up has something to follow', async () => {
  storage = ledger()
  const sent = stubApi([says('8월은 3,500원입니다.')])
  await ask({
    apiKey: 'k', baseUrl: 'https://api.example.com', model: 'm', question: '그럼 지난달은?', today: '2026-08-25',
    history: [{ q: '이번 달 얼마야', a: '이번 달 4,500원입니다.' }],
    tools: ledgerTools('2026-08-25'),
  })
  assert.equal(sent[0].messages[0].role, 'system')
  assert.deepEqual(
    sent[0].messages.slice(1),
    [
      { role: 'user', content: '이번 달 얼마야' },
      { role: 'assistant', content: '이번 달 4,500원입니다.' },
      { role: 'user', content: '그럼 지난달은?' },
    ],
  )
})

test('a remembered turn carries the sentences, never the tool blocks', async () => {
  storage = ledger()
  // A tool_use resent without the result that answered it is a request the API
  // rejects outright, and a service-worker teardown between the two is exactly
  // how the pair gets broken.
  const sent = stubApi([reads({ from: '2026-08-20', to: '2026-08-22' }), says('3,500 KRW.')])
  await ask({
    apiKey: 'k', baseUrl: 'https://api.example.com', model: 'm', question: 'how did it go', today: '2026-08-25',
    history: [{ q: 'and before that', a: 'nothing recorded.' }],
    tools: ledgerTools('2026-08-25'),
  })
  for (const m of sent[0].messages) {
    assert.equal(typeof m.content, 'string')
    assert.equal('tool_calls' in m, false)
  }
})

test('history is optional, so a first question is a first question', async () => {
  storage = ledger()
  const sent = stubApi([says('hi')])
  await ask({ apiKey: 'k', baseUrl: 'https://api.example.com', model: 'm', question: 'hi', today: '2026-08-25', tools: ledgerTools('2026-08-25') })
  assert.equal(sent[0].messages.length, 2)
  assert.deepEqual(sent[0].messages[1], { role: 'user', content: 'hi' })
})

test('a command is not a question, and neither is a sticker', () => {
  assert.equal(isQuestion('지난주 얼마야'), true)
  // Anything with a slash on the front is a command. One this does not know is a
  // typo the user is about to correct, and answering it would be paid for.
  assert.equal(isQuestion('/today'), false)
  assert.equal(isQuestion('/todya'), false)
  // A photo, a sticker or a join notice arrives with no text at all.
  assert.equal(isQuestion(''), false)
  assert.equal(isQuestion('   '), false)
})

test('a conversation lapses after the window, but not while it is being had', () => {
  const now = 1_800_000_000_000
  const fresh = { at: now - 60_000, turns: [{ q: 'a', a: 'b' }] }
  assert.deepEqual(freshTurns(fresh, now), [{ q: 'a', a: 'b' }])
  // Half an hour on, the next question is a new subject; carrying the old one in
  // would have the model answer about days nobody asked about, and pay to reread
  // them.
  assert.deepEqual(freshTurns({ ...fresh, at: now - HISTORY_TTL_MS - 1 }, now), [])
  assert.deepEqual(freshTurns(null, now), [])

  // Stamped at the last turn, so a conversation still going does not lapse
  // however long it has been going.
  const carried = nextTurns(fresh, now, 'c', 'd')
  assert.equal(carried.at, now)
  assert.deepEqual(carried.turns, [{ q: 'a', a: 'b' }, { q: 'c', a: 'd' }])
  // A lapsed one starts over rather than resuming.
  assert.deepEqual(nextTurns({ ...fresh, at: now - HISTORY_TTL_MS - 1 }, now, 'c', 'd').turns, [
    { q: 'c', a: 'd' },
  ])
})

test('only the last few exchanges are kept, because each one is resent', () => {
  const now = 1_800_000_000_000
  let stored = null
  for (let i = 0; i < MAX_TURNS_KEPT + 3; i += 1) stored = nextTurns(stored, now, `q${i}`, `a${i}`)
  assert.equal(stored.turns.length, MAX_TURNS_KEPT)
  assert.equal(stored.turns[0].q, `q${3}`)
  assert.equal(stored.turns.at(-1).q, `q${MAX_TURNS_KEPT + 2}`)
})

test('an inherited property name is a question, not a command', () => {
  // "constructor" and "toString" answer truthy from a bare object lookup. With
  // every non-command now going to the model, a sentence starting with one of
  // them would be swallowed by the totals branch and silently never answered.
  const SPANS = { '/today': 'totalToday', '/week': 'totalWeek', '/month': 'totalMonth' }
  for (const word of ['constructor', 'tostring', 'valueof', '__proto__']) {
    assert.equal(Object.hasOwn(SPANS, word), false, word)
  }
  assert.equal(Object.hasOwn(SPANS, '/today'), true)
  // And they are questions, so they must reach the model rather than nothing.
  assert.equal(isQuestion('constructor 관련 매출 알려줘'), true)
})

test('one clock for both ends of a call, so a live conversation cannot collapse', () => {
  const now = 1_800_000_000_000
  // Read at the start and again at the end, a conversation 29m58s old when the
  // question went out is judged lapsed when the answer comes back, and the
  // history it was answered from is thrown away mid-sentence.
  const stored = { at: now - HISTORY_TTL_MS + 2_000, turns: [{ q: 'a', a: 'b' }] }
  assert.equal(freshTurns(stored, now).length, 1)
  assert.equal(nextTurns(stored, now, 'c', 'd').turns.length, 2)
  // The collapse the shared clock avoids, shown with the clock read again later.
  assert.equal(nextTurns(stored, now + 5_000, 'c', 'd').turns.length, 1)
})

test('compacting keeps the thread as a recap rather than dropping it', async () => {
  const now = 1_800_000_000_000
  const live = [
    { q: '지난주 어땠어?', a: '8월 19일 12,000원, 20일 0원, 21일 45,500원입니다.' },
    { q: '그럼 INR 은?', a: 'INR 로는 전체 4,600 KRW 입니다.' },
  ]
  const sent = stubApi([says('지난주 일별 수익(19일 12,000원 등)과 INR 전체 4,600 KRW 를 확인했다.')])
  const summary = await summarize({ apiKey: 'k', baseUrl: 'https://api.example.com', model: 'm' }, live)
  assert.match(summary, /INR/)

  // No tools offered. A model that went back to the ledger here would pay to
  // re-read days in order to describe a conversation about them — and could
  // contradict the answer the reader was actually given.
  assert.equal('tools' in sent[0], false)
  // The turns go up as themselves and the instruction comes last, so what is
  // being summarised is the exchange rather than a description of one.
  assert.deepEqual(sent[0].messages.slice(0, 4).map((m) => m.role), [
    'user', 'assistant', 'user', 'assistant',
  ])
  assert.equal(sent[0].messages.at(-1).role, 'user')
  assert.match(sent[0].messages.at(-1).content, /compacting/)

  // Stored as an ordinary turn, so ask() replays it with no special case and a
  // compacted conversation can be compacted again.
  const kept = compacted(summary, now)
  assert.equal(kept.at, now)
  assert.deepEqual(freshTurns(kept, now), [{ q: RECAP, a: summary }])
  // And the clock restarts with it: the thread is live for another window, not
  // summarised into one that is already half spent.
  assert.deepEqual(freshTurns(kept, now + HISTORY_TTL_MS + 1), [])
  assert.equal(nextTurns(kept, now, 'c', 'd').turns.length, 2)
})

test('a pasted URL reaches the same endpoint with or without its trailing slash', () => {
  // Some gateways route a double slash and others answer it with a 404, and a
  // pasted URL is as likely to carry one as not.
  assert.equal(endpointFor('https://api.deepseek.com'), 'https://api.deepseek.com/chat/completions')
  assert.equal(endpointFor('https://api.deepseek.com/'), 'https://api.deepseek.com/chat/completions')
  assert.equal(endpointFor('https://api.openai.com/v1//'), 'https://api.openai.com/v1/chat/completions')
})

test('the tools go out in the shape this API names them', async () => {
  storage = ledger()
  const sent = stubApi([says('ok')])
  await ask({
    apiKey: 'k', baseUrl: 'https://api.example.com', model: 'm',
    question: 'hi', today: '2026-08-25', tools: ledgerTools('2026-08-25'),
  })
  const [tool] = sent[0].tools
  assert.equal(tool.type, 'function')
  assert.equal(tool.function.name, 'read_totals')
  // Named parameters here, not input_schema — the ledger's own field has to
  // match or the model is handed a tool it cannot call.
  assert.equal(tool.function.parameters.required.join(), 'from,to')
  assert.equal(sent[0].model, 'm')
})

test('a refusal with no readable body still names where it came from', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 402, json: async () => ({}) })
  await assert.rejects(
    ask({
      apiKey: 'k', baseUrl: 'https://api.example.com', model: 'm',
      question: 'hi', today: '2026-08-25', tools: ledgerTools('2026-08-25'),
    }),
    // Which host refused matters once the host is something the user chose.
    /api\.example\.com 402/,
  )
})


// "INR 통화 전체 수익을 알려줘" — a question about one currency, over the whole
// history. Neither half of it is answerable from the daily rows alone: they
// carry the developer's own currency and nothing about who paid, and the whole
// history is longer than one read of them is allowed to be.
const mixed = () => {
  let totals = {}
  const add = (day, amount, from, over = {}) =>
    T.record(totals, day, { net: { currency: 'KRW', amount }, currency: 'KRW', from, ...over })
  totals = add('2026-06-01', 12000, 'INR')
  totals = add('2026-07-15', 8000, 'INR')
  totals = add('2026-08-20', 30000, 'USD')
  totals = add('2026-08-22', 5000, 'INR')
  // A reversal of one of the Indian sales: filed under INR, and taking money
  // back out of the INR figure rather than out of a lump nobody can attribute.
  totals = T.record(totals, '2026-08-22', {
    net: { currency: 'KRW', amount: -5000 }, refund: true, currency: 'KRW', from: 'INR',
  })
  return { totals, adjustments: T.adjust({}, '2026-08-22', { currency: 'KRW', amount: -700 }) }
}

test('one currency is answerable over the whole history, in one read', () => {
  const { totals, adjustments } = mixed()
  // Both ends omitted: the common question is "all of it", and making the model
  // guess an install date it has not been told costs a turn and gets it wrong.
  const out = byCurrency(totals, adjustments, {}, '2026-08-25')
  assert.equal(out.since, '2026-06-01')
  assert.equal(out.from, '2026-06-01')
  assert.equal(out.to, '2026-08-25')
  // Eighty-five days — well past what the daily read will hand over at once,
  // which is the whole reason this one has no such ceiling.
  assert.ok(85 > MAX_RANGE_DAYS)
  // Biggest first: a question about currencies is a question about which ones
  // matter.
  assert.deepEqual(out.currencies.map((c) => c.currency), ['USD', 'INR'])
  const inr = out.currencies.find((c) => c.currency === 'INR')
  // 12000 + 8000 + 5000, less the 5000 handed back. The refund is already off
  // the figure, which is what the tool description promises.
  assert.equal(inr.amount, 20000)
  assert.equal(inr.orders, 3)
  assert.equal(inr.refunds, 1)
  assert.equal(inr.refunded, -5000)
  // In the developer's own currency, not the buyer's — the row's currency only
  // says who paid.
  assert.equal(out.payoutCurrency, 'KRW')
  // A hand-entered correction belongs to no buyer, so it is named apart rather
  // than quietly inflating one of the rows.
  assert.equal(out.corrections, -700)
})

test('the split adds back up to the days it was split from', () => {
  // The one invariant that matters: these are the daily figures dealt into
  // piles, not a second conversion of them. If the two could disagree, the same
  // question asked two ways would get two answers.
  const { totals, adjustments } = mixed()
  const split = byCurrency(totals, adjustments, {}, '2026-08-25')
  const daily = rangeOf(totals, adjustments, { from: '2026-06-25', to: '2026-08-25' }, '2026-08-25')
  const rows = split.currencies.reduce((n, c) => n + c.amount, 0)
  const sameSpan = byCurrency(totals, adjustments, { from: '2026-06-25' }, '2026-08-25')
  assert.equal(
    sameSpan.currencies.reduce((n, c) => n + c.amount, 0) + (sameSpan.corrections ?? 0),
    daily.days.reduce((n, d) => n + (d.amount ?? 0), 0),
  )
  assert.equal(rows, 12000 + 8000 + 5000 - 5000 + 30000)
})

test('a range narrows the split without narrowing what it claims to cover', () => {
  const { totals, adjustments } = mixed()
  const august = byCurrency(totals, adjustments, { from: '2026-08-01', to: '2026-08-31' }, '2026-08-25')
  // Trimmed to today rather than refused, the same way the daily read trims it.
  assert.equal(august.to, '2026-08-25')
  assert.deepEqual(august.currencies.map((c) => [c.currency, c.amount]), [['USD', 30000], ['INR', 0]])
  // Clamped to the day counting began, so a question about last year does not
  // come back with a drought that was really an install date.
  assert.equal(byCurrency(totals, adjustments, { from: '2020-01-01' }, '2026-08-25').from, '2026-06-01')
})

test('days recorded before the split say so rather than reading as a quiet month', () => {
  // An install that was counting before this shipped has buckets with no split
  // in them. Their money is in the daily totals and in none of the rows, so a
  // figure quoted from here without saying so would read as a currency that
  // sold nothing.
  const { totals } = mixed()
  const old = { ...totals, '2026-06-01': { currency: 'KRW', amount: 12000, orders: 1, refunds: 0, refunded: 0, uncounted: 0 } }
  const out = byCurrency(old, {}, {}, '2026-08-25')
  assert.equal(out.daysNotSplit, 1)
  assert.match(out.note, /before/)
  // And a tally that has been split throughout says nothing, rather than
  // hedging an answer that is whole.
  assert.equal(byCurrency(totals, {}, {}, '2026-08-25').daysNotSplit, undefined)
})

test('the currency read refuses the same things the daily one does', () => {
  const { totals, adjustments } = mixed()
  // Shape is not existence here either: April has thirty days.
  assert.ok(byCurrency(totals, adjustments, { from: '2026-04-31' }, '2026-08-25').error)
  assert.ok(byCurrency(totals, adjustments, { to: 'last june' }, '2026-08-25').error)
  assert.match(
    byCurrency(totals, adjustments, { from: '2026-08-22', to: '2026-08-20' }, '2026-08-25').error,
    /on or before/,
  )
  // With no "to" supplied there is no ordering the caller got wrong, so this is
  // the future rather than a range written backwards.
  assert.match(
    byCurrency(totals, adjustments, { from: '2026-09-01' }, '2026-08-25').error,
    /nothing has happened/,
  )
  // Nothing recorded is not zero revenue, and the two must not read alike.
  const empty = byCurrency({}, {}, {}, '2026-08-25')
  assert.equal(empty.since, null)
  assert.deepEqual(empty.currencies, [])
  assert.match(empty.note, /no days recorded/)
})

test('an order whose buyer currency Play did not report is filed, not dropped', () => {
  // Under a key of its own, so the rows still account for every order — and so
  // a bucket written by this version always has at least one entry, which is
  // what tells it apart from one written before the split existed.
  let totals = T.record({}, '2026-08-20', { net: { currency: 'KRW', amount: 900 }, currency: 'KRW' })
  const out = byCurrency(totals, {}, {}, '2026-08-25')
  assert.deepEqual(out.currencies, [{ currency: '?', amount: 900, orders: 1 }])
  assert.equal(out.daysNotSplit, undefined)
})

test('how many renewals, and what they were worth, is one read', () => {
  // The question this split exists for. Answered from the same figures the daily
  // totals are made of, so a renewal's revenue and the days it came out of can
  // never disagree — and answerable over a month without a row per day.
  const sale = (kind, amount, from, refund = false) => ({
    net: { currency: 'KRW', amount: refund ? -amount : amount },
    currency: 'KRW', from, kind, refund,
  })
  let b = T.record({}, '2026-08-02', sale(T.KIND_RENEWAL, 4600, 'INR'))
  b = T.record(b, '2026-08-02', sale(T.KIND_SUB, 17800, 'CAD'))
  b = T.record(b, '2026-08-19', sale(T.KIND_RENEWAL, 4600, 'INR'))
  b = T.record(b, '2026-08-19', sale(T.KIND_BUY, 5020, 'USD'))
  // A renewal handed back. It stays in the renewal row, because that is where
  // the money it is taking out went in.
  b = T.record(b, '2026-08-20', sale(T.KIND_RENEWAL, 4600, 'INR', true))

  const out = byKind(b, {}, { from: '2026-08-01', to: '2026-08-31' }, '2026-08-28')
  assert.deepEqual(out.kinds, [
    { kind: 'sub', amount: 17800, orders: 1 },
    { kind: 'buy', amount: 5020, orders: 1 },
    // Two charges and one reversal: the count is the charges, the amount already
    // has the reversal out of it.
    { kind: 'renewal', amount: 4600, orders: 2, refunds: 1, refunded: -4600 },
  ])
  // Biggest first, and the whole split still adds back up to the days it came
  // from — which is the property that makes quoting one row honest.
  assert.equal(
    out.kinds.reduce((n, k) => n + k.amount, 0),
    T.sumRange(b, '2026-08-01', '2026-08-31').amount,
  )
  // Both splits are the same money dealt two ways, so they agree on the total.
  const money = byCurrency(b, {}, { from: '2026-08-01', to: '2026-08-31' }, '2026-08-28')
  assert.equal(
    money.currencies.reduce((n, c) => n + c.amount, 0),
    out.kinds.reduce((n, k) => n + k.amount, 0),
  )

  // A day written before the split existed is money in the daily totals and in
  // none of the rows. Saying so is what keeps a quoted row from reading as a
  // kind that sold nothing rather than one this cannot account for.
  const older = { ...b, '2026-08-05': { currency: 'KRW', amount: 9000, orders: 2, refunds: 0, refunded: 0, uncounted: 0 } }
  const gap = byKind(older, {}, { from: '2026-08-01', to: '2026-08-31' }, '2026-08-28')
  assert.equal(gap.daysNotSplit, 1)
  assert.match(gap.note, /recount/)
  // And the currency split reports the same day as its own gap, not this one's.
  assert.equal(byCurrency(older, {}, { from: '2026-08-01', to: '2026-08-31' }, '2026-08-28').daysNotSplit, 1)
})

test('the model is offered both splits alongside the daily read', () => {
  const tools = ledgerTools('2026-08-25')
  assert.deepEqual(tools.map((x) => x.spec.name), ['read_totals', 'read_by_currency', 'read_by_kind'])
  for (const { spec } of tools.slice(1)) {
    // Both ends optional, or an all-time question costs a turn spent asking when
    // the tally began.
    assert.deepEqual(spec.parameters.required, [], spec.name)
    // The amounts are in the developer's currency, not the row's. A model that
    // reads the row label as the unit reports INR sales in rupees.
    assert.match(spec.description, /payoutCurrency/)
  }
  // The kinds are named in the description, because "renewal" is only the right
  // row to read if the model knows that is what the string will be.
  const kinds = tools[2].spec.description
  for (const kind of ['renewal', 'sub', 'buy']) assert.match(kinds, new RegExp(`"${kind}"`))
  // And that a renewal's "orders" is the count being asked for. Told only that
  // it counts charges, a model asked "how many renewals" reaches for read_totals
  // and adds up days.
  assert.match(kinds, /number of renewals/)
})


test('a period can leave off the parts today already answers', () => {
  // The day someone wants to fetch again is nearly always in the month they are
  // standing in, so the short forms are the ones worth having.
  const today = '2026-08-26'
  const p = (text) => T.periodOf(text, today)
  // Bare is the whole lot: that is what someone typing a command called "fetch
  // it again" is asking for. Today is one tap away as the day of the month.
  assert.deepEqual(p(''), { all: true, to: today })
  assert.deepEqual(p('today'), { from: today, to: today })
  assert.deepEqual(p('오늘'), { from: today, to: today })
  assert.deepEqual(p('26'), { from: today, to: today })
  assert.deepEqual(p('20'), { from: '2026-08-20', to: '2026-08-20' })
  assert.deepEqual(p('7'), { from: '2026-08-07', to: '2026-08-07' })
  assert.deepEqual(p('06-20'), { from: '2026-06-20', to: '2026-06-20' })
  assert.deepEqual(p('2025-12-31'), { from: '2025-12-31', to: '2025-12-31' })
  // Four digits is a year, one or two is a day. Nothing here has two readings,
  // which is why a month has to be written with its year.
  assert.deepEqual(p('2026-06'), { from: '2026-06-01', to: '2026-06-30' })
  assert.deepEqual(p('2025'), { from: '2025-01-01', to: '2025-12-31' })
  // February in a leap year, worked out rather than looked up in a table.
  assert.deepEqual(p('2024-02'), { from: '2024-02-01', to: '2024-02-29' })
  // A month that has not started is not a period to fetch again.
  assert.equal(p('2026-12'), null)
})

test('a period still running is trimmed to the part of it that has happened', () => {
  const today = '2026-08-26'
  // Asking for this month in August means the twenty-six days there are, not a
  // refusal about the five that have not come yet.
  assert.deepEqual(T.periodOf('2026-08', today), { from: '2026-08-01', to: today })
  assert.deepEqual(T.periodOf('2026', today), { from: '2026-01-01', to: today })
  // A day that has not happened cannot be fetched again at all.
  assert.equal(T.periodOf('2026-08-31', today), null)
  assert.equal(T.periodOf('2027', today), null)
})

test('a period that is not one is refused rather than guessed at', () => {
  const today = '2026-08-26'
  // Shape is not existence here either.
  assert.equal(T.periodOf('2026-02-30', today), null)
  assert.equal(T.periodOf('2026-13', today), null)
  assert.equal(T.periodOf('2026-00-15', today), null)
  // A year is written in full wherever it appears, or "26-08-20" would be read
  // as the first century and fail much later with a message about Play.
  assert.equal(T.periodOf('26-08-20', today), null)
  assert.equal(T.periodOf('last week', today), null)
  assert.equal(T.periodOf('2026/08/20', today), null)
  assert.equal(T.periodOf('-5000', today), null)
})

test('the whole history is asked for by name, not by writing out a range', () => {
  const today = '2026-08-26'
  // Left to the caller to turn into a first day, because how far back is worth
  // going depends on what the tally still holds — which this does not know.
  for (const word of ['all', '전체', '*', 'ALL', '', '   ']) {
    assert.deepEqual(T.periodOf(word, today), { all: true, to: today })
  }
})

test('a menu that gained a command reaches installs that already had one', () => {
  // The registration is remembered so a save that changes nothing does not
  // re-send it. Remembered against the bot and the chat alone, /recount would
  // stay invisible forever to everyone who set the bot up before it shipped —
  // so what the menu says is part of the key.
  const one = [{ command: 'today', description: 'a' }]
  assert.equal(menuFingerprint({ en: one }), menuFingerprint({ en: one }))
  assert.notEqual(
    menuFingerprint({ en: one }),
    menuFingerprint({ en: [...one, { command: 'recount', description: 'b' }] }),
  )
  // A reworded description counts too: the menu is what the reader sees.
  assert.notEqual(menuFingerprint({ en: one }), menuFingerprint({ en: [{ command: 'today', description: 'b' }] }))
  // And the shipped menu advertises every command the bot actually answers — a
  // command that exists only for whoever read the source is one nobody has.
  const answered = ['today', 'week', 'month', 'recount', 'adjust', 'compact', 'help', 'start']
  // Read off the dispatcher rather than trusted to this list alone. The list is
  // written by hand and the menu is written by hand, so the two agreeing proves
  // only that the same person typed both — /compact is advertised because the
  // source answers "/compact", not because it appears twice in this file.
  const dispatcher = fs.readFileSync(path.join(EXT, 'background.js'), 'utf8')
  for (const cmd of answered) assert.ok(dispatcher.includes(`'/${cmd}'`), `unhandled: /${cmd}`)
  for (const list of Object.values(MENU)) {
    assert.deepEqual(list.map((c) => c.command).sort(), [...answered].sort())
  }
})

test('an order Play has not settled is banked as a guess, and says so', () => {
  // The distinction is the whole point: a guess has to be revisited when Play
  // fills the real number in, and a reported figure does not.
  const charged = order({ net: null, payout: null, total: { currency: 'KRW', amount: 400 } })
  assert.equal(isSettled(charged), false)
  assert.equal(isSettled(order({ payout: { currency: 'KRW', amount: 2500 } })), true)
  // Play reporting the buyer-currency net but not the payout still counts: that
  // figure is Play's, not this module's arithmetic on the price.
  assert.equal(isSettled(order({ payout: null, net: { currency: 'USD', amount: 3 } })), true)

  let led = T.remember([], 'a', { currency: 'KRW', amount: 340, estimated: true })
  led = T.remember(led, 'b', { currency: 'KRW', amount: 8000 })
  assert.equal(T.isEstimate(led, 'a'), true)
  assert.equal(T.isEstimate(led, 'b'), false)
  // An entry written before the flag existed reads as settled and is left to
  // /recount rather than corrected on a guess about how it was counted.
  assert.equal(T.isEstimate([['c', 500, 'KRW']], 'c'), false)
  // The flag does not disturb what a reversal takes back out.
  assert.equal(T.amountFor(led, 'a', 'KRW'), 340)
})

test('a figure Play settles later moves the day without counting the order again', () => {
  // 당근벨: the buyer is charged 400 because Google funds the discount, and the
  // developer banks 2,500. Counted at announce time from the 400, the tally
  // would carry that for good — nothing re-announces an order Play merely
  // settled, so nothing else would ever revisit it.
  let buckets = T.record({}, '2026-08-23', {
    net: { currency: 'KRW', amount: 340 }, currency: 'KRW', from: 'KRW',
  })
  const before = T.sum(buckets, '2026-08-23')
  assert.equal(before.amount, 340)

  buckets = T.resettle(buckets, '2026-08-23', { currency: 'KRW' }, 2500 - 340)
  const after = T.sum(buckets, '2026-08-23')
  assert.equal(after.amount, 2500)
  // One order, still. Nothing new happened; the same order turned out to be
  // worth a different figure.
  assert.equal(after.orders, before.orders)
  assert.equal(after.refunds, before.refunds)
  // And the split moves with it, or it stops adding up to the day it came from.
  assert.equal(after.currencies.KRW.amount, 2500)
  assert.equal(
    Object.values(after.currencies).reduce((n, c) => n + c.amount, 0),
    after.amount,
  )

  // Confirmed in the ledger, so a refund takes out what was actually counted —
  // 2,500, not the 340 the tally first guessed at.
  let led = T.remember([], 'a', { currency: 'KRW', amount: 340, estimated: true })
  led = T.confirm(led, 'a', 2500)
  assert.equal(T.amountFor(led, 'a', 'KRW'), 2500)
  // And it stops being a guess, so a settled figure that merely wobbles with the
  // exchange rate is not "corrected" every poll for the rest of its life.
  assert.equal(T.isEstimate(led, 'a'), false)
})

test('a settlement keeps the split adding up, or leaves it visibly absent', () => {
  // A day that has a split but no row for this currency gets one, or moving the
  // amount and not the split would have the two disagree.
  let split = T.record({}, '2026-08-23', { net: { currency: 'KRW', amount: 900 }, currency: 'KRW', from: 'USD' })
  split = T.resettle(split, '2026-08-23', { currency: 'JPY' }, 2160)
  const both = T.sum(split, '2026-08-23')
  assert.equal(both.amount, 3060)
  assert.equal(Object.values(both.currencies).reduce((n, c) => n + c.amount, 0), both.amount)
  // No order invented for it: the count belongs to the day, which has it.
  assert.equal(both.currencies.JPY.orders, 0)

  // A bucket from before the split existed gets no row at all. One here could
  // only hold this correction and not the money it corrects, and the day would
  // stop being reported as unsplit while still being short by everything else.
  // A gap that says it is a gap beats one that has been papered over.
  const before = { '2026-08-23': { currency: 'KRW', amount: 340, orders: 1, refunds: 0, refunded: 0, uncounted: 0 } }
  const put = T.resettle(before, '2026-08-23', { currency: 'KRW' }, 2160)
  assert.equal(T.sum(put, '2026-08-23').amount, 2500)
  assert.equal(T.hasBreakdown(put['2026-08-23']), false)
})

test('a day the bucket window has dropped is not resurrected by a settlement', () => {
  // Putting it back would stand a single order up as if it were the whole day's
  // takings, on a day the tally has already stopped answering for.
  assert.deepEqual(T.resettle({}, '2024-01-01', { currency: 'KRW' }, 2160), {})
  // And a settlement that moved nothing leaves the object identical, so the
  // caller can tell "nothing happened" from "something did".
  const one = T.record({}, '2026-08-23', { net: { currency: 'KRW', amount: 340 }, currency: 'KRW' })
  assert.equal(T.resettle(one, '2026-08-23', { currency: 'KRW' }, 0), one)
})

test('a rebuild counts a refunded order as the charge and the reversal it was', () => {
  // Play returns an order once, under the state it is in now, so a refunded one
  // arrives as the reversal alone. The charge happened too, and the tally files
  // a reversal under the day of the order rather than the day of the refund —
  // so both belong to the same day. Counting only the minus leaves the day short
  // by a charge it did receive, and disagreeing with what /today said at the
  // time is the one thing a recount must not do.
  const day = '2026-08-22'
  const krw = (amount) => ({ currency: 'KRW', amount })

  // What the live tally did: announced the charge, then announced the reversal.
  let live = T.record({}, day, { net: krw(6500), currency: 'KRW', from: 'KRW' })
  live = T.record(live, day, { net: krw(-6500), refund: true, currency: 'KRW', from: 'KRW' })

  // What the rebuild sees: one order, refunded, worth -6500.
  const paid = krw(-6500)
  const gross = { currency: paid.currency, amount: -paid.amount }
  let built = T.record({}, day, { net: gross, currency: 'KRW', from: 'KRW' })
  built = T.record(built, day, { net: paid, refund: true, currency: 'KRW', from: 'KRW' })

  assert.deepEqual(T.sum(built, day), T.sum(live, day))
  const figures = T.sum(built, day)
  assert.equal(figures.amount, 0)
  assert.equal(figures.orders, 1)
  assert.equal(figures.refunds, 1)
  assert.equal(figures.refunded, -6500)
  // And the split says the same, so a currency question about that day agrees
  // with the day itself.
  assert.equal(figures.currencies.KRW.amount, 0)
})

test('a rebuilt charge is banked at what the rebuild counted', () => {
  // History adopted at first sync was banked at zero on purpose. Once a recount
  // has taken it into the books, a reversal of one of those orders has to take
  // out what is now there — refunding it for nothing would leave the money in
  // the total for good.
  const adopted = T.remember([], 'GPA.1', { currency: 'KRW', amount: 0 })
  assert.equal(T.amountFor(adopted, 'GPA.1', 'KRW'), 0)

  const rebuilt = T.remember(
    adopted.filter(([id]) => id !== 'GPA.1'),
    'GPA.1',
    { currency: 'KRW', amount: 6500, estimated: false },
  )
  assert.equal(T.amountFor(rebuilt, 'GPA.1', 'KRW'), 6500)
  // remember refuses an id it already holds, which is why the rebuild drops the
  // old entry first — replacing it is the whole point.
  assert.equal(T.remember(adopted, 'GPA.1', { currency: 'KRW', amount: 6500 }), adopted)
})
