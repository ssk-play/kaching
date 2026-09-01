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
// Faithful enough to be worth testing against: get honours the keys it was
// asked for, so a module that reads one month's chunk cannot accidentally be
// handed every other key in storage and pass on that.
const local = {
  get: async (want) => {
    if (want == null) return { ...storage }
    const out = {}
    for (const [key, fallback] of Object.entries(want)) {
      out[key] = key in storage ? storage[key] : fallback
    }
    return out
  },
  set: async (patch) => {
    storage = { ...storage, ...patch }
  },
  remove: async (keys) => {
    for (const key of [keys].flat()) delete storage[key]
  },
}
globalThis.chrome = {
  storage: { local },
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
  deliveryDue, windowStart, anchorMinutes, normalizeAnchor, DELIVERY_PRESETS, HOUR_MS,
} = await load('settings.js')
const { matches, plan } = await load('filters.js')
const { times, describe, feeRate, cycleOf, estimatedNet, isSettled } = await load('format.js')
const { shouldAlert, FAILS_BEFORE_ALERT, ALERT_COOLDOWN_MS } = await load('health.js')
const { ratesFrom, merge, payoutCurrency, convert, rateFor } = await load('fx.js')
const T = await load('totals.js')
const { chatsIn, menuFingerprint, MENU, send: tgSend, BURST } = await load('telegram.js')
const O = await load('orders.js')
const { totalLine } = await load('format.js')
const { trim, MAX_ENTRIES } = await load('log.js')
const { rangeOf, byCurrency, byKind, MAX_ROWS, tools: ledgerTools } = await load('ledger.js')
const S = await load('subs.js')
const {
  ask, textOf, isQuestion, freshTurns, nextTurns, endpointFor, MAX_TURNS_KEPT, HISTORY_TTL_MS,
  summarize, compacted, RECAP, probe, CARRIES_BOTH, DROPS_TOOLS, DROPS_SYSTEM,
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

test('every field the options page saves has an input and a default', () => {
  // The id scan above only sees $('literal'). Four lists — checkboxes, texts,
  // numbers, selects — are walked with $(id) instead, so a field added to one of
  // them and not to the HTML slips past it and blanks the page on load, which is
  // exactly the shape of the mistake the scan exists to catch.
  const js = fs.readFileSync(path.join(EXT, 'options.js'), 'utf8')
  const html = fs.readFileSync(path.join(EXT, 'options.html'), 'utf8')
  const present = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]))

  const listed = (name) => {
    const at = js.indexOf(`const ${name} = `)
    assert.ok(at !== -1, `options.js has no ${name}`)
    const open = js.indexOf(name === 'NUMBERS' ? '{' : '[', at)
    const shut = js.indexOf(name === 'NUMBERS' ? '}' : ']', open)
    return [...js.slice(open, shut).matchAll(/'([^']+)'|^\s*(\w+):/gm)].map((m) => m[1] ?? m[2])
  }

  const fields = ['CHECKBOXES', 'TEXTS', 'PICKS', 'NUMBERS'].flatMap(listed)
  assert.ok(fields.length > 15, 'the field scan found nothing, so it is checking nothing')
  for (const id of fields) {
    assert.ok(present.has(id), `options.html has no #${id}`)
    // And a field with no default reads back as undefined, which saves as
    // undefined and is then read as undefined everywhere it is used.
    assert.ok(id in DEFAULTS, `settings.js has no default for ${id}`)
  }
})

test('the recovery notice is off unless it is asked for', () => {
  // The only message here that reports nothing happening. The outage notice
  // earns its interruption because silence looks exactly like a quiet sales
  // day; "it works again" is read by someone who has already seen the orders
  // start arriving.
  assert.equal(DEFAULTS.sayRecovered, false)
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
  const { batch } = plan(page, [], DEFAULTS)
  assert.deepEqual(batch.map((o) => o.id), [page[2].id, page[1].id, page[0].id])
})

test('plan announces every fresh order rather than standing a tail down', () => {
  // A batch used to stop at ten and replace the rest with "…and 5 more", which
  // reported money without saying whose. Nothing is held back now.
  const page = orders(15)
  const { batch, freshCount } = plan(page, [], DEFAULTS)
  assert.equal(batch.length, 15)
  assert.equal(freshCount, 15)
  assert.equal(new Set(batch.map((o) => o.id)).size, 15)
})

test('plan puts filter-muted orders in muted, never in the batch', () => {
  const page = [order({ id: 'GPA.0000-0000-0000-00001' }), order({ id: 'GPA.0000-0000-0000-00002', packageName: 'com.other' })]
  const { batch, muted, freshCount, unseenCount } = plan(
    page, [], { ...DEFAULTS, packages: 'com.example.app' },
  )
  assert.deepEqual(muted.map((o) => o.packageName), ['com.other'])
  assert.equal(batch.length, 1)
  assert.equal(freshCount, 1)
  assert.equal(unseenCount, 2)
})

test('plan skips orders already recorded as seen', () => {
  const page = orders(3)
  const seen = [`${page[0].id}:charged`]
  const { batch, unseenCount } = plan(page, seen, DEFAULTS)
  assert.equal(unseenCount, 2)
  assert.ok(!batch.some((o) => o.id === page[0].id))
})

test('plan treats a refund of a seen order as new', () => {
  // The dedupe key carries state, so a refund on an announced order re-fires.
  const charged = order({ id: 'GPA.0000-0000-0000-00009' })
  const refunded = order({ id: 'GPA.0000-0000-0000-00009', state: 'refunded' })
  const { batch } = plan([refunded], [`${charged.id}:charged`], DEFAULTS)
  assert.equal(batch.length, 1)
  assert.equal(batch[0].state, 'refunded')
})

test('delivery is immediate until someone switches a schedule on', () => {
  // The default has to be the behaviour the extension already had: an install
  // that never opens this section must not start batching. The hours and the
  // time beside them are what the switch turns on, not what decides whether it
  // is on — so they hold a usable schedule while it is off.
  assert.equal(DEFAULTS.deliveryScheduled, false)
  assert.equal(DEFAULTS.deliveryPaused, false)
  assert.ok(DEFAULTS.deliveryHours > 0)
  assert.equal(deliveryDue(DEFAULTS, 4_999, 5_000), true)
  assert.equal(deliveryDue({ ...DEFAULTS, deliveryHours: 24 }, 4_999, 5_000), true)
})

// The windows are counted from midnight, so these tests name wall-clock times
// rather than offsets from an arbitrary instant — which is the whole point of
// what they are checking.
const utc = (day, hh, mm = 0) => Date.parse(`${day}T00:00:00Z`) + (hh * 60 + mm) * 60_000

test('windows are counted from midnight, not from the last delivery', () => {
  const s = { deliveryScheduled: true, deliveryHours: 3, timeZone: 'UTC' }
  const day = '2026-08-30'
  // A batch that went out at 09:40 spends the 09:00 window and no other.
  assert.equal(windowStart(s, utc(day, 9, 40)), utc(day, 9))
  assert.equal(windowStart(s, utc(day, 11, 59)), utc(day, 9))
  assert.equal(windowStart(s, utc(day, 12)), utc(day, 12))
  // And the first window of a day starts at midnight itself.
  assert.equal(windowStart(s, utc(day, 0, 1)), utc(day, 0))
})

test('one batch per window, at the first check that has something to say', () => {
  const s = { deliveryScheduled: true, deliveryHours: 3, timeZone: 'UTC' }
  const day = '2026-08-30'
  const sent = utc(day, 9, 40)
  // Same window: already spent, whatever arrives now waits.
  assert.equal(deliveryDue(s, sent, utc(day, 11, 59)), false)
  // The next boundary opens it again — and a check that lands at 12:20 rather
  // than 12:00 still delivers, because nobody can arrange when Chrome is awake.
  assert.equal(deliveryDue(s, sent, utc(day, 12)), true)
  assert.equal(deliveryDue(s, sent, utc(day, 12, 20)), true)
})

test('a twelve-hour window lands at midnight and noon, every day', () => {
  const s = { deliveryScheduled: true, deliveryHours: 12, timeZone: 'UTC' }
  assert.equal(windowStart(s, utc('2026-08-30', 11, 59)), utc('2026-08-30', 0))
  assert.equal(windowStart(s, utc('2026-08-30', 12)), utc('2026-08-30', 12))
  // A batch sent late in the morning does not push the afternoon one to 23:00.
  assert.equal(deliveryDue(s, utc('2026-08-30', 11, 30), utc('2026-08-30', 12)), true)
  // And the day rolls over into a fresh window rather than a rolling one.
  assert.equal(deliveryDue(s, utc('2026-08-30', 12, 5), utc('2026-08-31', 0)), true)
})

test('the windows are the configured zone\'s, not the browser\'s', () => {
  // Midnight in Seoul is not midnight in UTC, and the day the tally is counted
  // in is the one the boundaries have to follow.
  const day = '2026-08-30'
  const seoul = { deliveryScheduled: true, deliveryHours: 6, timeZone: 'Asia/Seoul' }
  // 2026-08-30 00:00 KST is 2026-08-29 15:00 UTC.
  const kstMidnight = Date.parse('2026-08-29T15:00:00Z')
  assert.equal(windowStart(seoul, kstMidnight + 60_000), kstMidnight)
  assert.equal(windowStart(seoul, kstMidnight + 7 * HOUR_MS), kstMidnight + 6 * HOUR_MS)
  // The same instant under UTC falls in a different window entirely.
  assert.equal(windowStart({ ...seoul, timeZone: 'UTC' }, kstMidnight + 60_000),
    utc('2026-08-29', 12))
})

test('a daily window at 05:00 delivers once a day, at five', () => {
  // The case the setting exists for: 24 hours counted from 05:00.
  const s = { deliveryScheduled: true, deliveryHours: 24, deliveryAnchor: '05:00', timeZone: 'UTC' }
  const day = '2026-08-30'
  assert.equal(windowStart(s, utc(day, 5)), utc(day, 5))
  assert.equal(windowStart(s, utc(day, 23, 59)), utc(day, 5))
  // Before five, the window running is yesterday's — not one that has yet to
  // open, and not midnight.
  assert.equal(windowStart(s, utc(day, 4, 59)), utc('2026-08-29', 5))
  assert.equal(windowStart(s, utc('2026-08-31', 0, 30)), utc(day, 5))

  // Sent at 05:10, nothing more goes out until five the next morning.
  const sent = utc(day, 5, 10)
  assert.equal(deliveryDue(s, sent, utc(day, 23, 59)), false)
  assert.equal(deliveryDue(s, sent, utc('2026-08-31', 4, 59)), false)
  assert.equal(deliveryDue(s, sent, utc('2026-08-31', 5)), true)
})

test('an anchor moves every boundary, not just the first', () => {
  const s = { deliveryScheduled: true, deliveryHours: 6, deliveryAnchor: '05:00', timeZone: 'UTC' }
  const day = '2026-08-30'
  for (const [hh, start] of [[5, 5], [10, 5], [11, 11], [17, 17], [23, 23]]) {
    assert.equal(windowStart(s, utc(day, hh)), utc(day, start), `${hh}:00`)
  }
  // 23:00 + 6 h lands at 05:00 the next day, which is the anchor again.
  assert.equal(windowStart(s, utc('2026-08-31', 4)), utc(day, 23))
  assert.equal(windowStart(s, utc('2026-08-31', 5)), utc('2026-08-31', 5))
})

test('an anchor is a wall clock in the configured zone', () => {
  // 05:00 means five in the morning where the tally lives, not five in UTC.
  const s = { deliveryScheduled: true, deliveryHours: 24, deliveryAnchor: '05:00', timeZone: 'Asia/Seoul' }
  // 2026-08-30 05:00 KST is 2026-08-29 20:00 UTC.
  assert.equal(windowStart(s, Date.parse('2026-08-29T20:00:00Z')), Date.parse('2026-08-29T20:00:00Z'))
  assert.equal(windowStart(s, Date.parse('2026-08-29T19:59:00Z')), Date.parse('2026-08-28T20:00:00Z'))
})

test('an unreadable anchor is midnight, not a delivery time nobody can explain', () => {
  assert.equal(anchorMinutes('05:00'), 300)
  assert.equal(anchorMinutes('5:07'), 307)
  assert.equal(anchorMinutes('00:00'), 0)
  for (const bad of ['', null, undefined, 'noon', '24:00', '05:60', '5', '05:00:00']) {
    assert.equal(anchorMinutes(bad), 0, String(bad))
  }
  // And what the form stores is always the shape every reader parses.
  assert.equal(normalizeAnchor('5:07'), '05:07')
  assert.equal(normalizeAnchor(''), '00:00')
  assert.equal(normalizeAnchor('23:30'), '23:30')
  assert.equal(DEFAULTS.deliveryAnchor, '00:00')
})

test('the first batch after switching a window on is not held', () => {
  // Nothing has been delivered, so there is no window to have spent. Starting
  // the clock on a poll instead would swallow the order that proves it works.
  assert.equal(deliveryDue({ deliveryScheduled: true, deliveryHours: 12, timeZone: 'UTC' }, 0, 1), true)
})

test('a pause outranks every window, including no window at all', () => {
  const day = '2026-08-30'
  const now = utc(day, 9, 30)
  assert.equal(deliveryDue({ deliveryPaused: true, deliveryScheduled: false, timeZone: 'UTC' }, 0, now), false)
  assert.equal(
    deliveryDue({ deliveryPaused: true, deliveryScheduled: true, deliveryHours: 3, timeZone: 'UTC' }, 1, now), false,
  )
  // A pause does not move the boundaries: unpausing after a long quiet lets the
  // backlog out at the first check of a window that has not been served.
  assert.equal(
    deliveryDue({ deliveryPaused: false, deliveryScheduled: true, deliveryHours: 3, timeZone: 'UTC' }, 1, now), true,
  )
})

test('a typed delivery interval is clamped, not refused', () => {
  // The presets are a convenience; the field is a number and takes 4 as readily
  // as 3. What it must not take is a zero — that is the switch's answer, not an
  // interval — or a week-long one.
  assert.ok(!DELIVERY_PRESETS.includes(0), 'immediate is the switch, not an hours value')
  assert.equal(clampNumber('4', [1, 24], DEFAULTS.deliveryHours), 4)
  assert.equal(clampNumber('0', [1, 24], DEFAULTS.deliveryHours), 1)
  assert.equal(clampNumber('999', [1, 24], DEFAULTS.deliveryHours), 24)
  assert.equal(clampNumber('', [1, 24], DEFAULTS.deliveryHours), DEFAULTS.deliveryHours)
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
    // And a third, for how often the money comes back. Nothing said, so '?'.
    periods: { '?': { amount: 8000, orders: 2, refunds: 0, refunded: 0, uncounted: 0 } },
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
    periods: { '?': { amount: 0, orders: 1, refunds: 0, refunded: 0, uncounted: 1 } },
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
    periods: { '?': { amount: 0, orders: 1, refunds: 1, refunded: 0, uncounted: 2 } },
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
    periods: { '?': { amount: 0, orders: 1, refunds: 1, refunded: -6500, uncounted: 0 } },
  })
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
  // A correction belongs to no buyer, no kind of sale and no billing period, so
  // it adds nothing to any of the three splits.
  assert.deepEqual(T.sum(down, '2026-08-19'), {
    currency: 'KRW', amount: -6500, orders: 0, refunds: 0, refunded: 0, uncounted: 0,
    currencies: {}, kinds: {}, periods: {},
  })
  // Both directions, and read together with what was announced.
  const up = T.adjust(down, '2026-08-19', { currency: 'KRW', amount: 500 })
  const both = T.combine(T.sum(day, '2026-08-19'), T.sum(up, '2026-08-19'))
  assert.deepEqual(both, {
    currency: 'KRW', amount: 2000, orders: 2, refunds: 0, refunded: 0, uncounted: 0,
    currencies: {}, kinds: {}, periods: {},
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
    out.rows.map((d) => [d.day, d.amount ?? 0]),
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
  assert.equal(out.rows[0].day, '2026-08-20')
  assert.equal(out.rows.length, 3)
})

test('an empty tally is said to be empty rather than answered with zeroes', () => {
  const out = rangeOf({}, {}, { from: '2026-08-01', to: '2026-08-02' }, '2026-08-25')
  assert.deepEqual(out.rows, [])
  assert.equal(out.since, null)
  assert.ok(out.note)
})

test('a range reaching into the future is trimmed to today, not refused', () => {
  const { totals, adjustments } = ledger()
  // "this week" ends on Saturday; the question is still about the days that have
  // happened, so the days that have not are simply not there.
  const out = rangeOf(totals, adjustments, { from: '2026-08-20', to: '2026-08-31' }, '2026-08-21')
  assert.equal(out.rows.at(-1).day, '2026-08-21')
  // A range that is entirely in the future has nothing to trim to.
  assert.ok(rangeOf(totals, adjustments, { from: '2026-09-01', to: '2026-09-02' }, '2026-08-21').error)
})

test('a range too wide for its grain is widened, never refused', () => {
  // A tally that really does hold a year: the floor moves nothing, so this is a
  // year of days being asked for. Refused, the model's only move is to ask again
  // for less — and it has four turns to spend on the whole question.
  const old = T.record({}, '2026-01-01', { net: { currency: 'KRW', amount: 100 }, currency: 'KRW' })
  const out = rangeOf(old, {}, { from: '2026-01-01', to: '2026-12-31' }, '2026-12-31')
  assert.ok(!out.error)
  // Days would be 365 rows, weeks 53, so weeks is where it lands.
  assert.equal(out.groupedBy, 'week')
  assert.ok(out.rows.length <= MAX_ROWS)
  // And it says so, because a week quoted as a day is a wrong answer that reads
  // like a right one.
  assert.equal(out.rows[0].day, undefined)
  assert.ok(out.rows[0].from && out.rows[0].to)
  // A malformed date is still refused rather than thrown into the loop.
  assert.ok(rangeOf({}, {}, { from: 'last monday', to: '2026-08-22' }, '2026-08-25').error)
  assert.ok(rangeOf({}, {}, { from: '2026-08-01', to: '2026-08-22', groupBy: 'fortnight' }, '2026-08-25').error)
})

test('the grain follows the rows that would be emitted, not the years asked about', () => {
  // "How did this year go" against a days-old install is a handful of rows, so
  // it stays by day rather than being rounded up to weeks nobody asked for.
  const { totals, adjustments } = ledger()
  const out = rangeOf(totals, adjustments, { from: '2026-01-01', to: '2026-08-25' }, '2026-08-25')
  assert.ok(!out.error)
  assert.equal(out.groupedBy, 'day')
  assert.equal(out.rows.length, 6)
  assert.ok(out.rows.length <= MAX_ROWS)
})

test('a week is added up here, not by the model', () => {
  // The whole reason this exists: asked for eight weeks, gpt-5-4-mini read the
  // days and summed them itself, and three of the eight came out wrong — 5% off
  // over the range. A wrong figure stated confidently is worse than a refusal,
  // and neither is necessary when the addition happens in JS.
  let totals = {}
  for (let d = 1; d <= 28; d += 1) {
    const day = `2026-08-${String(d).padStart(2, '0')}`
    totals = T.record(totals, day, { net: { currency: 'KRW', amount: 1000 }, currency: 'KRW' })
  }
  const out = rangeOf(totals, {}, { from: '2026-08-01', to: '2026-08-28', groupBy: 'week' }, '2026-08-28')
  assert.equal(out.groupedBy, 'week')
  // Weeks start on Sunday, and 2026-08-01 is a Saturday — so the first row is
  // that one day, clipped to the range rather than reported as a whole week.
  assert.deepEqual(out.rows[0], { from: '2026-08-01', to: '2026-08-01', currency: 'KRW', amount: 1000, orders: 1 })
  assert.equal(out.rows[1].from, '2026-08-02')
  assert.equal(out.rows[1].to, '2026-08-08')
  assert.equal(out.rows[1].amount, 7000)
  assert.equal(out.rows[1].orders, 7)
  // Nothing is lost or double counted at the seams.
  assert.equal(out.rows.reduce((sum, r) => sum + r.amount, 0), 28000)
  const byMonth = rangeOf(totals, {}, { from: '2026-08-01', to: '2026-08-28', groupBy: 'month' }, '2026-08-28')
  assert.equal(byMonth.rows.length, 1)
  assert.equal(byMonth.rows[0].amount, 28000)
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

test('an endpoint that carries the question is told from one that does not', async () => {
  // The failure this exists for is invisible in the answer. A gateway that
  // forwards only the last user message still returns 200 with fluent prose in
  // it, so the settings test went green while the chat could not read a figure —
  // and the only way anyone found out was by arguing with the bot about the
  // stock market.
  const calls = (name) => ({
    choices: [{
      finish_reason: 'tool_calls',
      message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: '{"word":"KACHING-OK"}' } }] },
    }],
  })
  const where = { apiKey: 'k', baseUrl: 'https://api.example.com', model: 'm' }

  // The ping came back as a tool call, which takes both the system prompt and
  // the tool list to have arrived.
  stubApi([calls('ping')])
  assert.equal(await probe(where), CARRIES_BOTH)

  // The word alone: the instruction landed, so the system message is getting
  // through and the tool list is not.
  stubApi([says('KACHING-OK')])
  assert.equal(await probe(where), DROPS_TOOLS)

  // Neither. The observed shape of a gateway that flattens the request down to
  // its last user message, which answers a question about a sales tally with a
  // question about which stock you meant.
  stubApi([says('어떤 자산의 최근 8주 주간 수익률을 말씀하시나요?')])
  assert.equal(await probe(where), DROPS_SYSTEM)

  // A tool call, but not the one that was asked for, is not proof the ping
  // arrived — a model calling something else may never have seen it.
  stubApi([calls('read_totals')])
  assert.equal(await probe(where), DROPS_SYSTEM)
})

test('the probe asks for the one tool it checks for, under a system message', async () => {
  // Sent as the real thing rather than as a ping to a health endpoint: a key
  // that authenticates against a service which cannot call a tool looks fine to
  // anything less.
  const sent = stubApi([calls_ok()])
  await probe({ apiKey: 'k', baseUrl: 'https://api.example.com', model: 'm' })
  const [body] = sent
  assert.equal(body.messages[0].role, 'system')
  assert.equal(body.tools.length, 1)
  assert.equal(body.tools[0].function.name, 'ping')
  // No tool_choice: forcing the call would prove the endpoint can be made to
  // send one, not that it forwarded the instruction that asked for it.
  assert.equal(body.tool_choice, undefined)
})

function calls_ok() {
  return {
    choices: [{
      finish_reason: 'tool_calls',
      message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ping', arguments: '{"word":"KACHING-OK"}' } }] },
    }],
  }
}

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
  assert.equal(out.rows[0].day, '2026-08-10')
  assert.equal(out.rows[0].amount, 9000)

  // The sharp case: a tally with nothing announced at all still has the
  // correction to report, and saying it has no days would contradict /today.
  const only = rangeOf({}, adjustments, { from: '2026-08-01', to: '2026-08-10' }, '2026-08-25')
  assert.deepEqual(only.rows, [{ day: '2026-08-10', currency: 'KRW', amount: 9000, orders: 0 }])
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
  assert.equal(out.rows.length, 3)
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
  const row = rangeOf(totals, adjustments, { from: '2026-08-22', to: '2026-08-22' }, '2026-08-25').rows[0]
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
  // Eighty-five days — more rows than the daily read will hand over at once, so
  // that one would answer this by the week and this one answers it in a line.
  assert.ok(85 > MAX_ROWS)
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
    daily.rows.reduce((n, d) => n + (d.amount ?? 0), 0),
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

  // There is no "these days predate the split" gap to report any more. A day is
  // folded out of the orders on the way to being read, so every day this can see
  // carries every split — which is the point of keeping the orders rather than a
  // running total.
  assert.equal('daysNotSplit' in out, false)
  assert.equal('note' in out, false)
})

test('the model is offered the splits, the projection and no writer by default', () => {
  const tools = ledgerTools('2026-08-25')
  assert.deepEqual(
    tools.map((x) => x.spec.name),
    ['read_totals', 'read_by_currency', 'read_by_kind', 'read_expected'],
  )
  const spec = (name) => tools.find((x) => x.spec.name === name).spec
  // Looked up by name rather than by position: a tool inserted in the middle
  // would otherwise move these assertions quietly onto a different one.
  for (const { spec: split } of tools.filter((x) => /^read_by_/.test(x.spec.name))) {
    // Both ends optional, or an all-time question costs a turn spent asking when
    // the tally began.
    assert.deepEqual(split.parameters.required, [], split.name)
    // The amounts are in the developer's currency, not the row's. A model that
    // reads the row label as the unit reports INR sales in rupees.
    assert.match(split.description, /payoutCurrency/)
  }
  // The kinds are named in the description, because "renewal" is only the right
  // row to read if the model knows that is what the string will be.
  const kinds = spec('read_by_kind').description
  for (const kind of ['renewal', 'sub', 'buy']) assert.match(kinds, new RegExp(`"${kind}"`))
  // And that a renewal's "orders" is the count being asked for. Told only that
  // it counts charges, a model asked "how many renewals" reaches for read_totals
  // and adds up days.
  assert.match(kinds, /number of renewals/)
  // The same money split a third way, and named as such — a model told only that
  // "periods" exists cannot know that "monthly" is the string to look for.
  for (const period of ['monthly', 'weekly', 'yearly']) assert.match(kinds, new RegExp(period))

  // The projection is the one tool that answers about days that have not
  // happened, so its ceiling has to be in the description the model reads rather
  // than only in the field it might skip.
  const ahead = spec('read_expected')
  assert.deepEqual(ahead.parameters.required, ['from', 'to'])
  assert.match(ahead.description, /ceiling and not a forecast/)
  assert.match(ahead.description, /cancellations/)
})

test('the writing tool is offered only when there is something to run it', () => {
  // The options-page test button asks its question with no recount to give. A
  // tool the model can call and the caller cannot run is worse than one it never
  // sees: the model spends a turn on it and gets an error back.
  assert.ok(!ledgerTools('2026-08-25').some((x) => x.spec.name === 'run_recount'))

  const asked = []
  const withWrite = ledgerTools('2026-08-25', { recount: (p) => (asked.push(p), 'done') })
  const run = withWrite.find((x) => x.spec.name === 'run_recount')
  assert.ok(run, 'run_recount is missing when a recount was handed in')
  assert.equal(run.run({ period: '2026-06' }), 'done')
  assert.deepEqual(asked, ['2026-06'])
  // Idempotence is the reason this is allowed to write at all, so the model has
  // to be told it — one that thinks a second run doubles the tally will refuse a
  // retry the developer asked for.
  assert.match(run.spec.description, /removes nothing/)
  // And that a year is too long to hold a chat open for.
  assert.match(run.spec.description, /\/recount/)
})


// One subscription's charges, as Play numbers them: the first has no suffix and
// every automatic renewal carries "..N" on the same base id.
const sub = (base, n, at, amount = 5000) => ({
  id: n == null ? base : `${base}..${n}`,
  at: Date.parse(at),
  state: 'charged',
  subscription: true,
  packageName: 'com.example.app',
  sku: 'premium',
  total: { currency: 'KRW', amount },
  net: { currency: 'KRW', amount },
  beforeFee: { currency: 'KRW', amount },
})

test('a billing period is measured from the run, not read off one order', () => {
  // Play sends no plan with an order — playconsole.js reads a subscription flag
  // and nothing else. What it does send is an id that repeats across renewals,
  // so the gap between two charges of the same base id IS the period.
  const monthly = [sub('GPA.M', null, '2026-06-10T00:00:00Z'), sub('GPA.M', 0, '2026-07-10T00:00:00Z')]
  const yearly = [sub('GPA.Y', null, '2025-03-01T00:00:00Z'), sub('GPA.Y', 0, '2026-03-01T00:00:00Z')]
  const weekly = [sub('GPA.W', null, '2026-08-01T00:00:00Z'), sub('GPA.W', 0, '2026-08-08T00:00:00Z')]
  const found = S.subscriptions([...monthly, ...yearly, ...weekly])
  assert.equal(found.get('GPA.M').period, T.PERIOD_MONTHLY)
  assert.equal(found.get('GPA.Y').period, T.PERIOD_YEARLY)
  assert.equal(found.get('GPA.W').period, T.PERIOD_WEEKLY)

  // Seen once, so there is no gap to measure. Answered as unknown rather than as
  // the likeliest plan: a guess here becomes a figure in a revenue projection.
  const once = S.subscriptions([sub('GPA.N', null, '2026-08-01T00:00:00Z')])
  assert.equal(once.get('GPA.N').period, T.UNKNOWN_PERIOD)

  // A gap that matches no plan stays unknown rather than rounding to the nearest.
  assert.equal(S.periodForGap(60), T.UNKNOWN_PERIOD)
  assert.equal(S.periodForGap(1), T.UNKNOWN_PERIOD)

  // The most recent gap, not an average: a plan that moved from monthly to
  // yearly bills yearly next, and averaging the two would say quarterly.
  const moved = S.subscriptions([
    sub('GPA.C', null, '2025-01-05T00:00:00Z'),
    sub('GPA.C', 0, '2025-02-05T00:00:00Z'),
    sub('GPA.C', 1, '2026-02-05T00:00:00Z'),
  ])
  assert.equal(moved.get('GPA.C').period, T.PERIOD_YEARLY)

  // A one-off purchase has no run and no period at all.
  assert.equal(S.periodLookup([{ id: 'GPA.B', at: 0, state: 'charged' }])({ id: 'GPA.B' }), null)
})

test('the periods split reaches the model, and adds back up to the days', () => {
  // End to end: orders in, folded to days, read back out as the model sees it.
  // The period cannot be read off one order, so this is really a test that the
  // fold works out the runs first and hands the answer down to every day.
  const zone = 'Asia/Seoul'
  const fx = { currency: 'KRW', rates: {} }
  const orders = [
    sub('GPA.M', null, '2026-08-01T00:00:00Z'), sub('GPA.M', 0, '2026-08-31T00:00:00Z'),
    { id: 'GPA.B', at: Date.parse('2026-08-05T00:00:00Z'), state: 'charged',
      total: { currency: 'KRW', amount: 3000 }, net: { currency: 'KRW', amount: 3000 } },
  ]
  const totals = O.foldDays(orders, zone, fx)
  const out = byKind(totals, {}, { from: '2026-08-01', to: '2026-08-31' }, '2026-09-02')

  const by = Object.fromEntries(out.periods.map((r) => [r.period, r]))
  assert.equal(by.monthly.orders, 2)
  assert.equal(by.monthly.amount, 10000)
  // A one-off purchase is filed under its own key rather than left out, so the
  // split is a total and not a total-for-subscriptions.
  assert.equal(by.none.orders, 1)
  assert.equal(by.none.amount, 3000)

  // The three splits are the same money dealt three ways, so they add up to each
  // other. A period row that drifted from the kind rows would be a second
  // reading of the orders rather than a re-filing of the day.
  const sumOf = (rows) => rows.reduce((n, r) => n + r.amount, 0)
  assert.equal(sumOf(out.periods), sumOf(out.kinds))
  assert.equal(sumOf(out.periods), 13000)
})

test('the month ahead is a ceiling, and says so', () => {
  const zone = 'Asia/Seoul'
  const fx = { currency: 'KRW', rates: {} }
  const orders = [
    // Monthly, last charged 12 August — due again 12 September.
    sub('GPA.M', null, '2026-07-12T00:00:00Z'), sub('GPA.M', 0, '2026-08-12T00:00:00Z'),
    // Yearly, last charged 1 March — not due in September.
    sub('GPA.Y', null, '2025-03-01T00:00:00Z'), sub('GPA.Y', 0, '2026-03-01T00:00:00Z'),
    // Monthly, but the last charge was handed back. Projecting the next one from
    // it would forecast revenue from a buyer who was just made whole.
    sub('GPA.R', null, '2026-07-20T00:00:00Z'),
    { ...sub('GPA.R', 0, '2026-08-20T00:00:00Z'), state: 'refunded' },
    // Seen once, so no period and no projection — but counted as a gap in the
    // answer rather than passed over in silence.
    sub('GPA.N', null, '2026-08-25T00:00:00Z'),
  ]
  const out = S.expected(orders, { from: '2026-09-01', to: '2026-09-30' }, zone, fx, '2026-09-02')
  assert.deepEqual(out.periods, [
    // The settled net of the last charge, not a fee estimate off its price:
    // Play already told us what that renewal was worth, and the next one is
    // projected at the same figure.
    { period: T.PERIOD_MONTHLY, charges: 1, subscriptions: 1, amount: 5000, uncounted: 0 },
  ])
  assert.equal(out.subscriptionsWithUnknownPeriod, 1)
  assert.match(out.assumes, /ceiling/)
  assert.equal(out.payoutCurrency, 'KRW')

  // Asked for one plan, only that plan is projected.
  const yearly = S.expected(orders, { from: '2026-09-01', to: '2026-09-30', period: T.PERIOD_YEARLY }, zone, fx, '2026-09-02')
  assert.deepEqual(yearly.periods, [])

  // A due date that has already passed is not expected revenue: nothing will
  // ever settle against a day that has been and gone.
  const behind = S.expected(orders, { from: '2026-09-01', to: '2026-09-30' }, zone, fx, '2026-09-20')
  assert.deepEqual(behind.periods, [])
})

test('every charge due in the range is projected, not just the next one', () => {
  // The bug this exists for: projecting one period forward and stopping. A
  // weekly plan bills four times in a month, so a month asked about came back at
  // a quarter of its real figure — and it was labelled a ceiling, so the model
  // reported a quarter of the answer as an upper bound.
  const zone = 'Asia/Seoul'
  const fx = { currency: 'KRW', rates: {} }
  const weekly = [sub('GPA.W', null, '2026-08-23T00:00:00Z'), sub('GPA.W', 0, '2026-08-30T00:00:00Z')]
  const out = S.expected(weekly, { from: '2026-09-01', to: '2026-09-30' }, zone, fx, '2026-09-02')
  // 6th, 13th, 20th and 27th of September.
  assert.deepEqual(out.periods, [
    { period: T.PERIOD_WEEKLY, charges: 4, subscriptions: 1, amount: 20000, uncounted: 0 },
  ])

  // And the other half of the same bug: a range further out than one period.
  // Every monthly subscription was last charged in August, so a question about
  // October used to project into September, match nothing, and answer "nothing
  // is due" — the opposite of the truth, for the question the tool exists for.
  const monthly = [sub('GPA.M', null, '2026-07-28T00:00:00Z'), sub('GPA.M', 0, '2026-08-28T00:00:00Z')]
  const october = S.expected(monthly, { from: '2026-10-01', to: '2026-10-31' }, zone, fx, '2026-09-02')
  assert.deepEqual(october.periods, [
    { period: T.PERIOD_MONTHLY, charges: 1, subscriptions: 1, amount: 5000, uncounted: 0 },
  ])
})

test('a projection says which currency it is in, or counts nothing', () => {
  // Before a payout has ever been observed there is no developer currency to
  // report in. Taking one from whichever subscription came first would name a
  // buyer's currency as the payout currency and file every other one as
  // unconvertible — and disagree with read_by_kind about the same store.
  const zone = 'Asia/Seoul'
  const orders = [
    sub('GPA.K', null, '2026-07-12T00:00:00Z'), sub('GPA.K', 0, '2026-08-12T00:00:00Z'),
  ]
  const out = S.expected(orders, { from: '2026-09-01', to: '2026-09-30' }, zone, { currency: null, rates: {} }, '2026-09-02')
  assert.equal(out.payoutCurrency, null)
  assert.equal(out.periods[0].amount, 0)
  assert.equal(out.periods[0].uncounted, 1)
})

test('a subscription that stopped is not reported as a gap in the projection', () => {
  // The caveat has to be worth reading. Counted over the whole store, a tally
  // holding hundreds of long-dead single-charge subscriptions told the model a
  // one-week figure was "short by 500 subscriptions", which teaches the reader
  // to skip caveats — including the one that matters.
  const zone = 'Asia/Seoul'
  const fx = { currency: 'KRW', rates: {} }
  const orders = [
    sub('GPA.OLD', null, '2024-01-05T00:00:00Z'),
    sub('GPA.NEW', null, '2026-08-25T00:00:00Z'),
  ]
  const out = S.expected(orders, { from: '2026-09-01', to: '2026-09-30' }, zone, fx, '2026-09-02')
  // Only the recent one. Past the longest plan Play sells, a subscription that
  // never billed a second time is not going to.
  assert.equal(out.subscriptionsWithUnknownPeriod, 1)
})

test('the projection refuses a period it does not sell', () => {
  const zone = 'Asia/Seoul'
  const run = ledgerTools('2026-09-02').find((x) => x.spec.name === 'read_expected').run
  void zone
  return run({ from: '2026-09-01', to: '2026-09-30', period: 'Monthly' }).then((out) => {
    // Filtered on rather than refused, an off-list value matches no plan and the
    // answer comes back empty — which the model reports as "nothing is due".
    assert.match(out.error, /period must be one of/)
  })
})

test('only subscriptions actually due in the range are counted in it', () => {
  // The count and the money have to describe the same set. Counting every
  // subscription of a plan that reached the row — including ones due next March
  // — reported four yearly renewals against one charge's worth of money, and
  // gave a different count depending on the order the store happened to be in.
  const zone = 'Asia/Seoul'
  const fx = { currency: 'KRW', rates: {} }
  // Last charged a year before, so both are due again a year after that: GPA.A
  // on 2026-09-20 and GPA.B on 2027-02-01.
  const due = [sub('GPA.A', null, '2024-09-20T00:00:00Z', 40000), sub('GPA.A', 0, '2025-09-20T00:00:00Z', 40000)]
  const notDue = [sub('GPA.B', null, '2025-02-01T00:00:00Z', 40000), sub('GPA.B', 0, '2026-02-01T00:00:00Z', 40000)]
  const out = S.expected([...due, ...notDue], { from: '2026-09-25', to: '2026-10-31' }, zone, fx, '2026-09-02')
  // GPA.A renewed on the 20th, before this range opens; GPA.B is due in
  // February. Neither is due here, so the answer is empty rather than a count of
  // the subscriptions that happen to exist.
  assert.deepEqual(out.periods, [])

  // And the order of the store cannot change the answer.
  const forwards = S.expected([...due, ...notDue], { from: '2026-09-01', to: '2026-09-30' }, zone, fx, '2026-09-02')
  const backwards = S.expected([...notDue, ...due], { from: '2026-09-01', to: '2026-09-30' }, zone, fx, '2026-09-02')
  assert.deepEqual(forwards.periods, backwards.periods)
  assert.deepEqual(forwards.periods, [
    { period: T.PERIOD_YEARLY, charges: 1, subscriptions: 1, amount: 40000, uncounted: 0 },
  ])
})

test('what the projection had to leave out is named, never silently dropped', () => {
  const zone = 'Asia/Seoul'
  const fx = { currency: 'KRW', rates: {} }
  const range = { from: '2026-09-03', to: '2026-09-30' }

  // A chargeback batch would otherwise shrink the figure with nothing to say so.
  const reversed = [
    sub('GPA.R', null, '2026-07-10T00:00:00Z'),
    { ...sub('GPA.R', 0, '2026-08-10T00:00:00Z'), state: 'refunded' },
  ]
  assert.equal(S.expected(reversed, range, zone, fx, '2026-09-02').subscriptionsSkippedAfterRefund, 1)

  // A subscription whose only charge lands after the range was not missing from
  // it — it did not exist yet, so it is no caveat either.
  const later = [sub('GPA.L', null, '2026-08-25T00:00:00Z')]
  const past = S.expected(later, { from: '2026-01-01', to: '2026-01-31' }, zone, fx, '2026-09-02')
  assert.equal(past.subscriptionsWithUnknownPeriod, undefined)
  assert.deepEqual(past.periods, [])

  // A range so wide the walk stops short of it says so, because a truncated
  // figure and a complete one are the same number otherwise.
  const weekly = [sub('GPA.W', null, '2026-08-23T00:00:00Z'), sub('GPA.W', 0, '2026-08-30T00:00:00Z')]
  const far = S.expected(weekly, { from: '2026-09-01', to: '2099-12-31' }, zone, fx, '2026-09-02')
  assert.equal(far.truncated, true)
  const near = S.expected(weekly, { from: '2026-09-01', to: '2026-09-30' }, zone, fx, '2026-09-02')
  assert.equal(near.truncated, undefined)
})

test('a range that straddles the last charge, or reaches years past it, still projects', () => {
  // Two questions, one measure, and it answered neither. Judging staleness
  // against the range start dropped every subscription whose last charge came
  // after the range opened — so "August through October" reported nothing due,
  // while "September 3rd through October" reported it correctly. Judging it
  // against the range end instead called every live subscription stale as soon
  // as the range reached far enough ahead.
  const zone = 'UTC'
  const fx = { currency: 'KRW', rates: {} }
  const monthly = [
    sub('GPA.M', null, '2026-07-02T00:00:00Z'),
    sub('GPA.M', 0, '2026-08-02T00:00:00Z'),
    sub('GPA.M', 1, '2026-09-02T00:00:00Z'),
  ]
  const today = '2026-09-02'
  // Opens the day before the last charge.
  const straddling = S.expected(monthly, { from: '2026-09-01', to: '2026-10-31' }, zone, fx, today)
  assert.equal(straddling.periods[0].charges, 1)
  // Opens years before the tally did.
  const wide = S.expected(monthly, { from: '2020-01-01', to: '2026-12-31' }, zone, fx, today)
  assert.equal(wide.periods[0].charges, 3)
  // Reaches years past the last charge.
  const yearly = [sub('GPA.Y', null, '2025-09-02T00:00:00Z'), sub('GPA.Y', 0, '2026-09-02T00:00:00Z')]
  const far = S.expected(yearly, { from: '2028-01-01', to: '2028-12-31' }, zone, fx, today)
  assert.equal(far.periods[0].charges, 1)
})

test('a caveat is scoped to the plan the question named', () => {
  // A monthly reversal is no caveat on an answer about yearly plans.
  const zone = 'UTC'
  const fx = { currency: 'KRW', rates: {} }
  const reversed = [
    sub('GPA.R', null, '2026-08-02T00:00:00Z'),
    { ...sub('GPA.R', 0, '2026-09-02T00:00:00Z'), state: 'refunded' },
  ]
  const range = { from: '2026-09-03', to: '2026-10-31' }
  assert.equal(S.expected(reversed, range, zone, fx, '2026-09-02').subscriptionsSkippedAfterRefund, 1)
  assert.equal(
    S.expected(reversed, { ...range, period: T.PERIOD_YEARLY }, zone, fx, '2026-09-02')
      .subscriptionsSkippedAfterRefund,
    undefined,
  )
})

test('a monthly plan due on the 31st does not fall off a short month', () => {
  // Play pulls the charge back to the last day the month has and returns to the
  // 31st after it. Thirty days added blindly would drift the plan by five days a
  // year and put a renewal in the wrong month twice a year.
  assert.equal(S.nextDue('2026-01-31', T.PERIOD_MONTHLY), '2026-02-28')
  assert.equal(S.nextDue('2024-01-31', T.PERIOD_MONTHLY), '2024-02-29')
  assert.equal(S.nextDue('2026-12-15', T.PERIOD_MONTHLY), '2027-01-15')
  assert.equal(S.nextDue('2026-03-01', T.PERIOD_YEARLY), '2027-03-01')
  assert.equal(S.nextDue('2026-08-01', T.PERIOD_WEEKLY), '2026-08-08')
  assert.equal(S.nextDue('2026-08-01', T.UNKNOWN_PERIOD), null)
})

test('a period can leave off the parts today already answers', () => {
  // The day someone wants to fetch again is nearly always in the month they are
  // standing in, so the short forms are the ones worth having.
  const today = '2026-08-26'
  const p = (text) => T.periodOf(text, today)
  // Bare is the whole lot: that is what someone typing a command called "fetch
  // it again" is asking for.
  assert.deepEqual(p(''), { all: true, to: today })
  assert.deepEqual(p('today'), { from: today, to: today })
  assert.deepEqual(p('오늘'), { from: today, to: today })
  // What is left off is filled in from the left, so a lone number is a month —
  // which is the span a recount is actually asked for. A day is one keystroke
  // longer, and still there.
  assert.deepEqual(p('6'), { from: '2026-06-01', to: '2026-06-30' })
  assert.deepEqual(p('06'), { from: '2026-06-01', to: '2026-06-30' })
  assert.deepEqual(p('6월'), { from: '2026-06-01', to: '2026-06-30' })
  assert.deepEqual(p('06-20'), { from: '2026-06-20', to: '2026-06-20' })
  assert.deepEqual(p('2025-12-31'), { from: '2025-12-31', to: '2025-12-31' })
  // A number that is no month is refused rather than read as something else.
  // Before this it was the 20th of the month someone was standing in, so the
  // refusal has to be a refusal — quietly answering for June the 20th, or for
  // 2020, is how a recount lands on a span nobody asked for.
  assert.equal(p('20'), null)
  assert.equal(p('13'), null)
  // Four digits is a year. A month may still be written with one.
  assert.deepEqual(p('2026-06'), { from: '2026-06-01', to: '2026-06-30' })
  assert.deepEqual(p('2025'), { from: '2025-01-01', to: '2025-12-31' })
  // February in a leap year, worked out rather than looked up in a table.
  assert.deepEqual(p('2024-02'), { from: '2024-02-01', to: '2024-02-29' })
  // The month being stood in is trimmed to the part of it that has happened.
  assert.deepEqual(p('8'), { from: '2026-08-01', to: today })
  // A month that has not started is not a period to fetch again.
  assert.equal(p('2026-12'), null)
  assert.equal(p('12'), null)
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

test('a settled order is told apart from one whose figure is a guess', () => {
  // The distinction is what makes the store self-correcting: a guess is stored
  // as the order Play gave, and when Play fills the real figure in, the same
  // order is stored again and the day is folded from it. Nothing has to remember
  // that the old figure was a guess, but the line still has to know.
  const charged = order({ net: null, payout: null, total: { currency: 'KRW', amount: 400 } })
  assert.equal(isSettled(charged), false)
  assert.equal(isSettled(order({ payout: { currency: 'KRW', amount: 2500 } })), true)
  // Play reporting the buyer-currency net but not the payout still counts: that
  // figure is Play's, not this module's arithmetic on the price.
  assert.equal(isSettled(order({ payout: null, net: { currency: 'USD', amount: 3 } })), true)
})

const KRW = { currency: 'KRW', rates: { 'USD>KRW': 1300 } }
const stored = (x) => ({
  id: 'GPA.1', state: 'charged', subscription: false, product: '', sku: 'p',
  packageName: 'com.example.app', country: 'KR', at: Date.UTC(2026, 7, 22, 3, 0),
  total: { currency: 'KRW', amount: 6500 }, beforeFee: null, tax: null,
  net: null, payout: { currency: 'KRW', amount: 6500 }, ...x,
})

test('the same order stored twice is one order, at whichever version came last', () => {
  // Play returns an order under the state it is in now and fills its payout in
  // days later, so the same id comes back changed. Merging on the id rather than
  // appending is what makes storing an order idempotent — which is what lets a
  // poll and a /recount overlap without either counting anything twice.
  const guess = stored({ payout: null, net: null, total: { currency: 'KRW', amount: 400 } })
  const settled = stored({ payout: { currency: 'KRW', amount: 2500 } })
  const kept = O.merge([guess], [settled])
  assert.equal(kept.length, 1)
  assert.equal(kept[0].payout.amount, 2500)
  // Order does not matter for identity, only for which version wins.
  assert.equal(O.merge([settled], [guess])[0].payout, null)
  // A pending order is not stored at all, or it would sit in the tally as a sale
  // that has not happened.
  assert.deepEqual(O.merge([], [stored({ state: 'pending' })]), [])
})

test('a figure Play settles later moves the day, and nothing else does', () => {
  // 당근벨: the buyer is charged 400 because Google funds the discount, and the
  // developer banks 2,500. Counted from the price at announce time, the day
  // carried 340 — and nothing re-announces an order Play merely settled, so it
  // would have carried it for good.
  //
  // This used to take a ledger of what each charge had added, a flag marking
  // which figures were guesses, and a pass that moved the difference into the
  // bucket by hand. Now the settled order replaces the guess in the store and
  // the day is folded again.
  const guess = stored({ payout: null, net: null, total: { currency: 'KRW', amount: 400 } })
  const before = O.foldDays([guess], 'UTC', KRW)
  assert.equal(T.sum(before, '2026-08-22').amount, 340)

  const after = O.foldDays(O.merge([guess], [stored({ payout: { currency: 'KRW', amount: 2500 } })]), 'UTC', KRW)
  const day = T.sum(after, '2026-08-22')
  assert.equal(day.amount, 2500)
  // One order, still. Nothing new happened; the same order turned out to be
  // worth a different figure.
  assert.equal(day.orders, 1)
  assert.equal(day.refunds, 0)
  // And every split moves with it, because every split is folded from the same
  // order rather than patched afterwards.
  assert.equal(day.currencies['?'].amount, 2500)
  assert.equal(day.kinds.buy.amount, 2500)
})

test('an order survives the poll that fetched it, and is read back by day', async () => {
  storage = {}
  const at = (iso) => Date.parse(iso)
  const seoul = 'Asia/Seoul'
  // Two orders on the same Seoul day, either side of UTC midnight — so one of
  // them lands in the July chunk while both belong to the August 1st bucket.
  const july = stored({ id: 'a', at: at('2026-07-31T16:00:00Z') })
  const august = stored({ id: 'b', at: at('2026-08-01T05:00:00Z') })
  await O.write([july, august], seoul)
  assert.deepEqual(Object.keys(storage).sort(), ['orders:2026-08'])

  // Both come back for the day they actually fall on, whichever chunk holds
  // them: the range is in the reader's zone and the chunk boundary is not.
  const day = await O.read('2026-08-01', '2026-08-01', seoul)
  assert.deepEqual(day.map((o) => o.id), ['a', 'b'])
  // And under UTC they are two different days, from the same stored bytes.
  assert.deepEqual((await O.read('2026-07-31', '2026-07-31', 'UTC')).map((o) => o.id), ['a'])

  // Change the zone and the same order now belongs in a different month. It must
  // not end up in both: merge() dedupes inside a chunk, so a second home would
  // be a second copy that every read unions and every fold counts twice, for
  // good. The write takes it out of the chunk it used to live in.
  await O.write([july], 'UTC')
  assert.deepEqual(Object.keys(storage).sort(), ['orders:2026-07', 'orders:2026-08'])
  assert.deepEqual(storage['orders:2026-08'].map((o) => o.id), ['b'])
  assert.deepEqual((await O.read('2026-07-31', '2026-08-01', 'UTC')).map((o) => o.id), ['a', 'b'])
  // And a store that already holds both copies — written before this repaired
  // itself — is still read as one order, favouring the chunk the order belongs
  // in now, because that is where the newest write went.
  storage['orders:2026-08'] = [july, ...storage['orders:2026-08']]
  assert.deepEqual((await O.read('2026-08-01', '2026-08-01', seoul)).map((o) => o.id), ['a', 'b'])
  assert.deepEqual((await O.readAll(seoul)).map((o) => o.id), ['a', 'b'])
  await O.write([july, august], seoul)

  // Storing the same order again replaces it rather than doubling the day.
  await O.write([{ ...august, payout: { currency: 'KRW', amount: 9000 } }], seoul)
  const again = await O.read('2026-08-01', '2026-08-01', seoul)
  assert.equal(again.length, 2)
  assert.equal(again.find((o) => o.id === 'b').payout.amount, 9000)
  assert.equal(T.sum(O.foldDays(again, seoul, KRW), '2026-08-01').orders, 2)

  // A month past the window is dropped whole; the months still in it are not.
  storage['orders:2019-01'] = [stored({ id: 'old', at: at('2019-01-05T00:00:00Z') })]
  assert.deepEqual(await O.forget('2026-08-28'), ['orders:2019-01'])
  assert.ok('orders:2026-08' in storage)
  // And it looks once a day. Listing every key reads the whole store back, which
  // is megabytes on a poll that runs every ten minutes to delete something that
  // can only go stale at midnight.
  storage['orders:2019-02'] = []
  assert.deepEqual(await O.forget('2026-08-28'), [])
  assert.ok('orders:2019-02' in storage)
  assert.deepEqual(await O.forget('2026-08-29'), ['orders:2019-02'])
  storage = {}
})

test('a refunded order folds to the charge and the reversal it was', () => {
  // Play returns an order once, under the state it is in now, so a refunded one
  // arrives as the reversal alone. The charge happened too, and a reversal is
  // filed under the day of the order rather than the day of the refund — so both
  // belong to the same day. Counting only the minus leaves the day short by a
  // charge it did receive.
  const back = O.foldDays([stored({ state: 'refunded' })], 'UTC', KRW)
  const day = T.sum(back, '2026-08-22')
  assert.equal(day.amount, 0)
  assert.equal(day.orders, 1)
  assert.equal(day.refunds, 1)
  assert.equal(day.refunded, -6500)
  // A day that netted to zero must not read as one that never sold anything,
  // and the splits have to say the same or a currency question about that day
  // disagrees with the day itself.
  assert.equal(day.currencies['?'].refunded, -6500)
  assert.equal(day.kinds.buy.orders, 1)

  // The refund takes out exactly what the charge put in, because it is the same
  // order read twice rather than two figures estimated apart.
  const charge = T.sum(O.foldDays([stored({})], 'UTC', KRW), '2026-08-22')
  assert.equal(charge.amount + day.refunded, 0)
})

test('folding the whole history stays linear in the number of orders', () => {
  // Every question the model asks folds the entire store, so this runs on a
  // read, not on a write. record() copies the map of days on every call, which
  // over three years of orders against three and a half thousand days is forty
  // million entry copies — four seconds inside a service worker, for a figure
  // that should be instant. recordInto writes into one accumulator instead.
  //
  // Measured as a ratio rather than against a clock: what matters is that
  // tripling the orders roughly triples the work instead of squaring it, and a
  // wall-clock threshold would only be a test that fails on a slow machine.
  // Spread thin, three to a day, because the cost being measured is orders times
  // distinct days: nine thousand orders piled onto one week would copy a map of
  // seven keys and look linear however it was written.
  const build = (n) =>
    Array.from({ length: n }, (_, i) => stored({
      id: `GPA.${i}`,
      at: Date.UTC(2020, 0, 1) + i * 28_800_000,
      payout: { currency: 'KRW', amount: 5000 },
    }))
  const time = (orders) => {
    const at = process.hrtime.bigint()
    O.foldDays(orders, 'UTC', KRW)
    return Number(process.hrtime.bigint() - at)
  }
  const small = build(1_000)
  const large = build(9_000)
  // Warm, so the first run's compilation is not the thing being measured.
  time(small)
  time(large)
  const ratio = time(large) / Math.max(time(small), 1)
  // Nine times the orders. Linear is about 9; the quadratic version was 80-odd.
  assert.ok(ratio < 30, `folding got superlinear: 9x the orders cost ${ratio.toFixed(1)}x`)

  // And it is still the same fold: one accumulator, every order counted once.
  const days = O.foldDays(build(24), 'UTC', KRW)
  assert.equal(T.sum(days, '2020-01-01').orders, 3)
  assert.equal(T.sum(days, '2020-01').orders, 24)
  assert.equal(T.sum(days, '2020-01').amount, 24 * 5000)
})

// ---------------------------------------------------------------- the poll itself
//
// background.js has never been exercised here: it registers listeners on import
// and talks to Play and Telegram, so testing it meant stubbing the browser. The
// stub below is worth it now that a poll is what writes the tally — the fold, the
// announcement and the store all have to agree, and no test of any one of them
// catches the case where a run stores an order and then fails to send it.
async function pollHarness({ orders, failSends = 0 }) {
  const sent = []
  const now = Date.now()
  const play = orders.map((o) => ({
    '1': o.id, '33': o.state === 'refunded' ? 4 : 2, '12': o.sub ? 3 : 1,
    '11': { '1': 'Pro', '2': 'pro' }, '13': 'com.example.app', '14': { '2': 'KR' },
    '15': { '1': 'KRW', '2': String(o.total ?? o.net) },
    '27': o.net == null ? undefined : { '1': 'KRW', '2': String(o.net) },
    '28': o.net == null ? undefined : { '1': 'KRW', '2': String(o.net) },
    '9': String(o.at), '7': [],
  }))
  let left = failSends
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('sendMessage')) {
      if (left > 0) {
        left -= 1
        return { ok: false, status: 500, json: async () => ({ ok: false, description: 'boom' }) }
      }
      sent.push(JSON.parse(init.body).text)
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) }
    }
    const body = JSON.parse(init.body)
    const from = Number(body['4']['1']['1']) * 1000
    const to = Number(body['4']['2']['1']) * 1000
    return {
      ok: true, status: 200,
      json: async () => ({ '1': play.filter((_, i) => orders[i].at >= from && orders[i].at < to) }),
    }
  }
  await background.poll().catch(() => {})
  return { sent, now }
}

const noop = () => {}
globalThis.chrome.alarms = { create: noop, clear: noop, getAll: async () => [], onAlarm: { addListener: noop } }
globalThis.chrome.runtime = {
  getURL: (x) => `chrome-extension://kaching/${x}`,
  onInstalled: { addListener: noop }, onStartup: { addListener: noop },
  onMessage: { addListener: noop }, openOptionsPage: noop,
}
globalThis.chrome.action = {
  onClicked: { addListener: noop }, setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {},
}
globalThis.chrome.cookies = { get: async () => ({ value: 'SAPISID' }) }
globalThis.chrome.permissions = { contains: async () => true }
const background = await load('background.js')

test('a stalled window costs its own days, not the whole recount', async () => {
  // A recount walks the span newest-first over many requests and can run for two
  // minutes. When one window stalls, the orders the earlier windows already
  // returned are the expensive part — throwing unwinds the walk and drops every
  // one of them, and the reader is told only that something timed out.
  //
  // A stall is also not a window Play refused for being too wide: halving it
  // spends six more twenty-second waits on the same dead connection.
  const zone = 'UTC'
  storage = {
    botToken: 'b', chatId: '1', developerId: '1', timeZone: zone, days: 30,
    bootstrapped: true, seen: [], delivered: [], payoutCurrency: 'KRW', rates: {},
    consoleUrl: 'https://play.google.com/console/u/0/developers/1/orders',
  }
  const today = T.dayKey(Date.now(), zone)
  const recent = Date.now() - 2 * 86_400_000
  const asPlay = (id, at) => ({
    '1': id, '33': 2, '12': 1, '11': { '1': 'Pro', '2': 'pro' }, '13': 'com.example.app',
    '14': { '2': 'KR' }, '15': { '1': 'KRW', '2': '5000' }, '27': { '1': 'KRW', '2': '5000' },
    '28': { '1': 'KRW', '2': '5000' }, '9': String(at), '7': [],
  })

  let windows = 0
  const stalled = []
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('sendMessage')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) }
    }
    const body = JSON.parse(init.body)
    const from = Number(body['4']['1']['1']) * 1000
    windows += 1
    // The newest window answers; every older one stalls the way a dead
    // connection does, which is what AbortSignal.timeout produces.
    void from
    if (windows > 1) {
      stalled.push(windows)
      const err = new Error('signal timed out')
      err.name = 'TimeoutError'
      throw err
    }
    return { ok: true, status: 200, json: async () => ({ '1': [asPlay('KEPT', recent)] }) }
  }

  const reply = await background.recount(await load('settings.js').then((m) => m.load()), 'all')
  assert.ok(typeof reply === 'string' && reply.length > 0)

  // The order the reachable window returned is stored, not lost with the stall.
  const kept = await O.readAll(zone)
  assert.deepEqual(kept.map((o) => o.id), ['KEPT'])

  // And the walk gave up rather than spending its whole budget twenty seconds at
  // a time: far fewer requests than the ceiling, and no halving of the dead
  // window into fourteen more of the same.
  assert.ok(windows < 20, `walked ${windows} windows`)
  assert.ok(stalled.length <= 4, `stalled ${stalled.length} times`)
  void today
})

test('an order stored by a run that could not send it is announced once, and counted once', async () => {
  const zone = 'UTC'
  storage = {
    botToken: 'b', chatId: '1', developerId: '1', timeZone: zone, days: 30,
    bootstrapped: true, seen: [], delivered: [], payoutCurrency: 'KRW', rates: {},
    consoleUrl: 'https://play.google.com/console/u/0/developers/1/orders',
  }
  const at = Date.now() - 3_600_000
  const orders = [{ id: 'A', at, net: 5000 }, { id: 'B', at: at + 60_000, net: 3000 }]

  // The send fails, so nothing is announced — but the orders are already stored,
  // because storing is what counting is now.
  const first = await pollHarness({ orders, failSends: 1 })
  assert.deepEqual(first.sent, [])
  assert.equal((await O.readAll(zone)).length, 2)

  // The next run announces both, exactly once each. The footer is the day so far
  // including the order it hangs under — so it has to count each order once, not
  // once for already being in the store and again for being announced.
  const second = await pollHarness({ orders })
  const footers = second.sent.map((text) => text.split('\n').at(-1))
  assert.deepEqual(footers, ['Today 1 order · KRW 3,000', 'Today 2 orders · KRW 8,000'])

  const today = T.dayKey(Date.now(), zone)
  const day = T.sum(O.foldDays(await O.readAll(zone), zone, { currency: 'KRW', rates: {} }), today)
  assert.equal(day.amount, 8000)
  assert.equal(day.orders, 2)

  // And a third run announces nothing and changes nothing.
  const third = await pollHarness({ orders })
  assert.deepEqual(third.sent, [])
  assert.equal(T.sum(O.foldDays(await O.readAll(zone), zone, { currency: 'KRW', rates: {} }), today).amount, 8000)
  storage = {}
})

test('a payout Play settles later moves the day, with nothing re-announced', async () => {
  const zone = 'UTC'
  storage = {
    botToken: 'b', chatId: '1', developerId: '1', timeZone: zone, days: 30,
    bootstrapped: true, seen: [], delivered: [], payoutCurrency: 'KRW', rates: {},
    consoleUrl: 'https://play.google.com/console/u/0/developers/1/orders',
  }
  const at = Date.now() - 3_600_000
  const today = T.dayKey(Date.now(), zone)
  const amount = () =>
    T.sum(O.foldDays(storage['orders:' + today.slice(0, 7)] ?? [], zone, { currency: 'KRW', rates: {} }), today).amount

  // 당근벨: the buyer is charged 400 because Google funds the discount, so the
  // day is counted at 340 — the price less the standard cut.
  await pollHarness({ orders: [{ id: 'A', at, total: 400, net: null }] })
  assert.equal(amount(), 340)

  // Play fills the real figure in. Nothing re-announces the order, so this used
  // to need a ledger of what each charge had added and a pass to move the
  // difference by hand. Now the order is stored again and the day is refolded.
  const settled = await pollHarness({ orders: [{ id: 'A', at, total: 400, net: 2500 }] })
  assert.equal(amount(), 2500)
  // Said once, because a day's figure that jumps with nothing to explain it is
  // worse than a line nobody needed.
  assert.equal(settled.sent.length, 1)
  assert.match(settled.sent[0], /settled 1 order.*\+2160/)
  storage = {}
})

test('the store is read and written one month at a time', () => {
  assert.equal(O.chunkFor('2026-08-22'), 'orders:2026-08')
  assert.deepEqual(O.chunksBetween('2026-11-30', '2027-02-01'), [
    'orders:2026-11', 'orders:2026-12', 'orders:2027-01', 'orders:2027-02',
  ])
  assert.deepEqual(O.chunksBetween('2026-08-01', '2026-08-31'), ['orders:2026-08'])

  // Months past the window the tally reaches at all. Whole months, because a
  // chunk is the unit of storage and half a month deleted out of one leaves a
  // fold reporting a partial day as a quiet one.
  const keys = ['orders:2020-01', 'orders:2026-08', 'seen', 'totals', 'adjustments']
  const gone = O.expired(keys, '2026-08-28')
  assert.deepEqual(gone, ['orders:2020-01'])
  // Only order chunks. A key that merely sorts low is not a month.
  assert.ok(!gone.includes('adjustments'))
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


// The delivery pace, exercised through a real poll rather than through
// deliveryDue alone: what it has to get right is not the arithmetic but which
// half of a run it gates — the tally goes on, the messages wait.
const PACED = () => ({
  botToken: 'b', chatId: '1', developerId: '1', timeZone: 'UTC', days: 30,
  bootstrapped: true, seen: [], delivered: [], payoutCurrency: 'KRW', rates: {},
  consoleUrl: 'https://play.google.com/console/u/0/developers/1/orders',
})

// What the day stands at, folded from the store rather than from anything the
// poll returned: the whole point of holding a message is that the tally is not
// waiting on it.
const dayNow = async (zone = 'UTC') =>
  T.sum(O.foldDays(await O.readAll(zone), zone, { currency: 'KRW', rates: {} }),
    T.dayKey(Date.now(), zone))

test('a held run counts the orders and announces them when the window opens', async () => {
  const zone = 'UTC'
  storage = { ...PACED(), deliveryScheduled: true, deliveryHours: 3, lastDeliveryAt: Date.now() }
  const at = Date.now() - 3_600_000
  const orders = [{ id: 'A', at, net: 5000 }]

  // Inside the window: nothing is sent, and the day already knows about it.
  assert.deepEqual((await pollHarness({ orders })).sent, [])
  assert.equal((await dayNow(zone)).amount, 5000)
  assert.equal((await dayNow(zone)).orders, 1)

  // A second order arrives while the first is still waiting. Both wait.
  orders.push({ id: 'B', at: at + 60_000, net: 3000 })
  assert.deepEqual((await pollHarness({ orders })).sent, [])

  // The window opens: both go out in one batch, and the footer counts each order
  // once rather than once for being stored and again for being announced.
  storage.lastDeliveryAt = Date.now() - 4 * HOUR_MS
  const out = await pollHarness({ orders })
  assert.deepEqual(
    out.sent.map((text) => text.split('\n').at(-1)),
    ['Today 1 order · KRW 3,000', 'Today 2 orders · KRW 8,000'],
  )
  assert.equal((await dayNow(zone)).amount, 8000)
  assert.equal((await dayNow(zone)).orders, 2)

  // And a run that is allowed to send has nothing left to say.
  storage.lastDeliveryAt = Date.now() - 4 * HOUR_MS
  assert.deepEqual((await pollHarness({ orders })).sent, [])
  storage = {}
})

test('a pause stops the messages and not the tally', async () => {
  const zone = 'UTC'
  storage = { ...PACED(), deliveryPaused: true }
  const at = Date.now() - 3_600_000
  const orders = [{ id: 'A', at, net: 5000 }]

  assert.deepEqual((await pollHarness({ orders })).sent, [])
  assert.equal((await dayNow(zone)).amount, 5000)

  // Switched off, the backlog goes out on the very next check — and once.
  storage.deliveryPaused = false
  assert.equal((await pollHarness({ orders })).sent.length, 1)
  assert.deepEqual((await pollHarness({ orders })).sent, [])
  assert.equal((await dayNow(zone)).amount, 5000)
  storage = {}
})

test('a backlog is delivered in full, not summarised as a count', async () => {
  // The batch cap was the one place this tool answered "there was money" without
  // saying whose. A long hold is now a long batch.
  const zone = 'UTC'
  storage = { ...PACED(), deliveryScheduled: true, deliveryHours: 3, lastDeliveryAt: Date.now() }
  const at = Date.now() - 6 * 3_600_000
  const orders = Array.from({ length: BURST + 3 }, (_, i) => ({
    id: `GPA.0000-0000-0000-1000${i}`, at: at + i * 60_000, net: 1000,
  }))

  assert.deepEqual((await pollHarness({ orders })).sent, [])
  storage.lastDeliveryAt = Date.now() - 4 * HOUR_MS
  const out = await pollHarness({ orders })
  assert.equal(out.sent.length, orders.length)
  // Every order named once, and none of them replaced by a tally of the rest.
  for (const o of orders) {
    assert.equal(out.sent.filter((text) => text.includes(o.id)).length, 1, o.id)
  }
  // Counted off the store rather than off today, since a six-hour backlog can
  // straddle midnight — which is the point of the store being the tally.
  assert.equal((await O.readAll(zone)).length, orders.length)

  storage.lastDeliveryAt = Date.now() - 4 * HOUR_MS
  assert.deepEqual((await pollHarness({ orders })).sent, [])
  storage = {}
})

test('a rate-limited send waits the time Telegram names and delivers', async () => {
  // The throw would have ended the run with orders still in hand, and the next
  // poll would have opened with the same burst.
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return calls === 1
      ? {
        ok: false, status: 429,
        json: async () => ({ ok: false, description: 'Too Many Requests', parameters: { retry_after: 1 } }),
      }
      : { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 7 } }) }
  }
  assert.equal(await tgSend('b', '1', 'hello'), 7)
  assert.equal(calls, 2)
})

test('a rate limit longer than the worker lives is a failure, not a wait', async () => {
  // Sleeping through it would be a hang Chrome kills mid-way, with nothing
  // logged. Refused instead, so the failure is recorded and the next poll tries.
  globalThis.fetch = async () => ({
    ok: false, status: 429,
    json: async () => ({ ok: false, description: 'Too Many Requests', parameters: { retry_after: 3600 } }),
  })
  await assert.rejects(tgSend('b', '1', 'hello'), /429/)
})
