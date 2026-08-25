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
const { DEFAULTS, developerIdFrom, packageList, isConfigured, consoleUrlFor, clampNumber } =
  await load('settings.js')
const { matches, plan } = await load('filters.js')
const { times, describe, feeRate, cycleOf, estimatedNet } = await load('format.js')
const { shouldAlert, FAILS_BEFORE_ALERT, ALERT_COOLDOWN_MS } = await load('health.js')
const { ratesFrom, merge, payoutCurrency, convert, rateFor } = await load('fx.js')
const T = await load('totals.js')
const { chatsIn } = await load('telegram.js')
const { totalLine } = await load('format.js')
const { trim, MAX_ENTRIES } = await load('log.js')
const { rangeOf, MAX_RANGE_DAYS, tools: ledgerTools } = await load('ledger.js')
const { ask, textOf, isQuestion, freshTurns, nextTurns, MAX_TURNS_KEPT, HISTORY_TTL_MS } =
  await load('llm.js')

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

test('time toggles select zones independently', () => {
  const at = Date.UTC(2026, 7, 18, 23, 40)
  assert.equal(times(at, { showLocalTime: false, showUtcTime: true }), '2026-08-18 23:40 UTC')
  assert.match(times(at, { showLocalTime: true, showUtcTime: false }), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
  assert.match(times(at, { showLocalTime: true, showUtcTime: true }), / \/ 2026-08-18 23:40 UTC$/)
  // Both off is a choice, not an error: the line disappears.
  assert.equal(times(at, { showLocalTime: false, showUtcTime: false }), '')
})

test('describe omits the sender label when it is blank', () => {
  const bare = describe(order(), { ...DEFAULTS, senderName: '' })
  assert.ok(bare.startsWith('🔔 New order'), bare)
  const tagged = describe(order(), { ...DEFAULTS, senderName: 'shop' })
  assert.ok(tagged.startsWith('[shop] 🔔 New order'), tagged)
})

test('describe distinguishes refunds and subscriptions', () => {
  assert.ok(describe(order({ state: 'refunded' }), DEFAULTS).startsWith('↩️ Refund'))
  assert.ok(describe(order({ subscription: true }), DEFAULTS).startsWith('🔔 New subscription'))
})

test('describe drops empty lines rather than printing blanks', () => {
  const sparse = describe(
    order({ country: '', total: null, payout: null, net: null, tax: null, beforeFee: null }),
    { ...DEFAULTS, showLocalTime: false, showUtcTime: false },
  )
  assert.ok(!sparse.includes('\n\n'), sparse)
  assert.deepEqual(sparse.split('\n'), ['🔔 New order', 'Premium · premium_unlock', 'com.example.app', order().id])
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

test('the payout line says what the second figure is', () => {
  // It used to read "USD 4.99 -> KRW 6,500" with nothing naming the second
  // number, which left the net indistinguishable from the charge.
  const line = describe(order(), DEFAULTS).split('\n').find((l) => l.includes('→'))
  assert.match(line, /USD 4\.99 → KRW 6,500 est\. net$/)
})

test('the breakdown line appears only when asked for', () => {
  const off = describe(order(), { ...DEFAULTS, showBreakdown: false })
  assert.ok(!off.includes('fee 15%'), off)
  const on = describe(order(), { ...DEFAULTS, showBreakdown: true })
  // Tax and rate only: repeating the net would print the same label twice, once
  // per currency, with nothing saying which was the payout.
  assert.ok(on.includes('tax USD 0.45 · fee 15%'), on)
  assert.equal(on.match(/est\. net/g).length, 1, on)
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
  assert.ok(renewal.startsWith('🔁 Subscription renewal · charge #4'), renewal)
  assert.ok(describe(order({ subscription: true }), DEFAULTS).startsWith('🔔 New subscription'))
  // A refund stays a refund whatever charge it undoes.
  assert.ok(
    describe(order({ subscription: true, state: 'refunded', id: 'GPA.1..0' }), DEFAULTS)
      .startsWith('↩️ Refund'),
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

  const line = describe(order(unsettled), DEFAULTS).split('\n').find((l) => l.includes('→'))
  assert.match(line, /USD 4\.99 → USD 3\.86 est\. net · 15% fee assumed$/)
})

test('an estimated net says on its own line that the rate was assumed', () => {
  const unsettled = { payout: null, net: null }
  assert.deepEqual(feeRate(order(unsettled)), { percent: 15, derived: false })

  // The breakdown is off by default, so the disclaimer has to survive DEFAULTS:
  // a guess that reads like a settled payout is the failure that matters.
  const plain = describe(order(unsettled), DEFAULTS)
  assert.ok(plain.includes('USD 3.86 est. net · 15% fee assumed'), plain)
  // A tax figure is not what makes an estimate an estimate.
  const noTax = describe(order({ ...unsettled, tax: null, beforeFee: null }), DEFAULTS)
  assert.ok(noTax.includes('USD 4.24 est. net · 15% fee assumed'), noTax)

  // A settled figure is Play's own and carries no such qualifier.
  assert.ok(!describe(order(), DEFAULTS).includes('assumed'), describe(order(), DEFAULTS))

  // The breakdown never restates an assumed rate as if it were read off the order.
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
  assert.ok(text.includes('USD -3.86'), text)
  assert.ok(text.includes('15%'), text)
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
  assert.ok(describe(order(free), DEFAULTS).includes('USD 0 est. net'), describe(order(free), DEFAULTS))
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

test('the product ID rides along with the display name', () => {
  // The name is editable in the Console; the ID is what every API and every
  // line of the developer's own code keys on.
  assert.ok(describe(order(), DEFAULTS).includes('Premium · premium_unlock'))
  // Nothing to add is not the same as something to repeat.
  assert.ok(describe(order({ sku: 'Premium' }), DEFAULTS).includes('\nPremium\n'))
  assert.ok(describe(order({ sku: '' }), DEFAULTS).includes('\nPremium\n'))
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

  const line = describe(unsettled, DEFAULTS, fx).split('\n').find((l) => l.includes('→'))
  assert.match(line, /USD 4\.99 → KRW 5,017 est\. net · 15% fee assumed$/)

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
  assert.ok(text.includes('KRW 5,017 est. net'), text)
  assert.ok(text.includes('USD→KRW 1,300'), text)
  // Nothing crossed, nothing to disclose.
  const same = describe(order(), { ...DEFAULTS, showBreakdown: true }, fx)
  assert.ok(!same.includes('→KRW 1,300'), same)
})

test('a day is the developer\'s day, not UTC', () => {
  // A sale at 08:40 in Seoul belongs to that morning. A UTC key would file it
  // against the day before and make the footer disagree with the timestamp
  // printed directly above it.
  const ms = Date.UTC(2026, 7, 18, 23, 40)
  assert.equal(T.dayKey(ms, 'Asia/Seoul'), '2026-08-19')
  assert.equal(T.dayKey(ms, 'UTC'), '2026-08-18')
  assert.equal(T.monthKey('2026-08-19'), '2026-08')
})

test('totals sum a day and a month from the same buckets', () => {
  let b = {}
  const krw = (amount) => ({ currency: 'KRW', amount })
  b = T.record(b, '2026-08-19', { net: krw(5000), currency: 'KRW' })
  b = T.record(b, '2026-08-19', { net: krw(3000), currency: 'KRW' })
  b = T.record(b, '2026-08-20', { net: krw(1000), currency: 'KRW' })
  b = T.record(b, '2026-07-31', { net: krw(9999), currency: 'KRW' })

  assert.deepEqual(T.sum(b, '2026-08-19'), { currency: 'KRW', amount: 8000, orders: 2, refunds: 0, refunded: 0, uncounted: 0 })
  // Same function answers the month, so the two figures cannot drift apart.
  assert.equal(T.sum(b, '2026-08').amount, 9000)
  assert.equal(T.sum(b, '2026-08').orders, 3)
  assert.equal(T.sum(b, '2026-09').orders, 0)
})

test('a total never quietly absorbs money it could not convert', () => {
  // Adding NOK to a KRW total would produce a number that looks right and is
  // not, so it is counted apart and the line says so.
  let b = T.record({}, '2026-08-19', { net: { currency: 'NOK', amount: 64.6 }, currency: 'KRW' })
  assert.deepEqual(T.sum(b, '2026-08-19'), { currency: 'KRW', amount: 0, orders: 1, refunds: 0, refunded: 0, uncounted: 1 })
  // A refund with no charge to take back out is left out of the amount the same
  // way, and disclosed the same way: the message above it printed a figure, so
  // the line has to say the amount does not carry it.
  b = T.record(b, '2026-08-19', { net: null, refund: true, currency: 'KRW' })
  assert.deepEqual(T.sum(b, '2026-08-19'), { currency: 'KRW', amount: 0, orders: 1, refunds: 1, refunded: 0, uncounted: 2 })
})

test('a refund comes back out of the running total', () => {
  // The whole point of the sign: the day's figure has to fall when money is
  // handed back, not just carry a refund count beside an unchanged number.
  let b = T.record({}, '2026-08-19', { net: { currency: 'KRW', amount: 6500 }, currency: 'KRW' })
  b = T.record(b, '2026-08-19', { net: { currency: 'KRW', amount: -6500 }, refund: true, currency: 'KRW' })
  assert.deepEqual(T.sum(b, '2026-08-19'), { currency: 'KRW', amount: 0, orders: 1, refunds: 1, refunded: -6500, uncounted: 0 })
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
  assert.deepEqual(T.sum(down, '2026-08-19'), { currency: 'KRW', amount: -6500, orders: 0, refunds: 0, refunded: 0, uncounted: 0 })
  // Both directions, and read together with what was announced.
  const up = T.adjust(down, '2026-08-19', { currency: 'KRW', amount: 500 })
  const both = T.combine(T.sum(day, '2026-08-19'), T.sum(up, '2026-08-19'))
  assert.deepEqual(both, { currency: 'KRW', amount: 2000, orders: 2, refunds: 0, refunded: 0, uncounted: 0 })
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
  assert.equal(totalLine('totalToday', totals), 'Today KRW 8,000 · 2 orders · 1 refund')
  assert.equal(totalLine('totalMonth', totals), 'This month KRW 8,000 · 2 orders · 1 refund')
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
    'KRW -6,500 · 0 orders',
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
    'Today KRW 5,020 · 1 order · 1 refund, KRW -6,500',
  )
  assert.equal(
    totalLine('totalToday', { ...one, refunds: 2, refunded: -11520 }),
    'Today KRW 5,020 · 1 order · 2 refunds, KRW -11,520',
  )
  // A bucket written before the field existed still reads, without an amount.
  assert.equal(totalLine('totalToday', one), 'Today KRW 5,020 · 1 order · 1 refund')
  assert.equal(totalLine('totalToday', one), 'Today KRW 5,020 · 1 order · 1 refund')
  assert.equal(totalLine('totalMonth', one), 'This month KRW 5,020 · 1 order · 1 refund')
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
  assert.ok(text.includes('USD 7.45 est. net'), text)
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
  assert.equal(totalLine('totalWeek', totals), 'This week KRW 8,000 · 2 orders')
  assert.equal(totalLine('totalWeek', { ...totals, orders: 1 }), 'This week KRW 8,000 · 1 order')
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

const says = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] })
const reads = (input) => ({
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: 'tu_1', name: 'read_totals', input }],
})

test('the model is handed the figures it asked for and its answer comes back', async () => {
  storage = ledger()
  const sent = stubApi([reads({ from: '2026-08-20', to: '2026-08-22' }), says('3,500 KRW on the 22nd.')])
  const out = await ask({
    apiKey: 'k', question: 'how did last week go', today: '2026-08-25',
    tools: ledgerTools('2026-08-25'),
  })
  assert.equal(out, '3,500 KRW on the 22nd.')

  // Every tool result rides in one user message. Split across several, the model
  // learns to stop asking for more than one thing at a time.
  const results = sent[1].messages.at(-1)
  assert.equal(results.role, 'user')
  assert.equal(results.content.length, 1)
  assert.equal(results.content[0].tool_use_id, 'tu_1')
  assert.match(results.content[0].content, /2026-08-22/)
  // The assistant turn goes back whole: stripped to its prose, the tool_use
  // block the result answers would be pointing at nothing.
  assert.equal(sent[1].messages[1].content[0].type, 'tool_use')
})

test('a tool the model invents is reported to it instead of losing the question', async () => {
  storage = ledger()
  const sent = stubApi([
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_9', name: 'write_totals', input: {} }] },
    says('I can only read the tally.'),
  ])
  assert.equal(
    await ask({ apiKey: 'k', question: 'set today to 0', today: '2026-08-25', tools: ledgerTools('2026-08-25') }),
    'I can only read the tally.',
  )
  assert.equal(sent[1].messages.at(-1).content[0].is_error, true)
})

test('a model that keeps reading is cut off rather than left to spend', async () => {
  storage = ledger()
  stubApi(Array.from({ length: 8 }, () => reads({ from: '2026-08-20', to: '2026-08-22' })))
  const out = await ask({
    apiKey: 'k', question: 'how did it go', today: '2026-08-25', tools: ledgerTools('2026-08-25'),
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
    ask({ apiKey: 'k', question: 'hi', today: '2026-08-25', tools: ledgerTools('2026-08-25') }),
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
    ask({ apiKey: 'k', question: 'hi', today: '2026-08-25', tools: ledgerTools('2026-08-25') }),
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
    ask({ apiKey: 'k', question: 'hi', today: '2026-08-25', tools: ledgerTools('2026-08-25') }),
    /529/,
  )
})

test('only the prose is answered with, and an empty reply is not silence', () => {
  assert.equal(
    textOf([{ type: 'tool_use', id: 'x' }, { type: 'text', text: ' 3,500 KRW ' }]),
    '3,500 KRW',
  )
  assert.equal(textOf([]), '')
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
    apiKey: 'k', question: '그럼 지난달은?', today: '2026-08-25',
    history: [{ q: '이번 달 얼마야', a: '이번 달 4,500원입니다.' }],
    tools: ledgerTools('2026-08-25'),
  })
  assert.deepEqual(
    sent[0].messages,
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
    apiKey: 'k', question: 'how did it go', today: '2026-08-25',
    history: [{ q: 'and before that', a: 'nothing recorded.' }],
    tools: ledgerTools('2026-08-25'),
  })
  for (const m of sent[0].messages) assert.equal(typeof m.content, 'string')
})

test('history is optional, so a first question is a first question', async () => {
  storage = ledger()
  const sent = stubApi([says('hi')])
  await ask({ apiKey: 'k', question: 'hi', today: '2026-08-25', tools: ledgerTools('2026-08-25') })
  assert.deepEqual(sent[0].messages, [{ role: 'user', content: 'hi' }])
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
