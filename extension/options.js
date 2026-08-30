import {
  DEFAULTS, load, developerIdFrom, isConfigured, consoleUrlFor, clampNumber, DELIVERY_PRESETS,
  normalizeAnchor,
} from './settings.js'
import { describe, totalLine } from './format.js'
import { read as readLog, MAX_ENTRIES } from './log.js'
import { t } from './i18n.js'

const $ = (id) => document.getElementById(id)
const log = $('log')

const say = (text, cls = '') => {
  log.textContent = text
  log.className = cls
}

// A button halfway up the page answers beside the field it is about. Sent to the
// page footer instead, what it said would appear somewhere the reader is not
// looking — and the chat search in particular answers with a list of chats to
// choose between, which is no use out of sight of the box it fills in.
const beside = (id) => (text, cls = '') => {
  const out = $(id)
  out.textContent = text
  out.className = cls
}

const sayAi = beside('aiLog')
const sayChat = beside('chatLog')

// ------------------------------------------------------------------------ i18n

document.title = t('optTitle')
for (const el of document.querySelectorAll('[data-i18n]')) {
  el.textContent = t(el.dataset.i18n)
}
// A placeholder that shows the very question an empty box will ask, rather than
// an example of one. Set from here because the catalogue is the only place that
// text exists — written into the HTML it would be one locale's, and would drift
// from what the button actually sends the first time either is reworded.
for (const el of document.querySelectorAll('[data-i18n-placeholder]')) {
  el.placeholder = t(el.dataset.i18nPlaceholder)
}

// ------------------------------------------------------------------- form <-> storage

// The zone that decides which day an order is counted under. A list rather than
// a text field: the name has to be one Intl accepts, and a typo here would be a
// tally filed into days nothing else agrees about.
//
// The browser's own zone leads, named, so the default is a choice the reader can
// see rather than a blank. UTC is next because it is what the Play Console
// reports and so what someone reconciling against it would want.
function fillZones() {
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone
  const all = Intl.supportedValuesOf?.('timeZone') ?? [here, 'UTC']
  const rest = all.filter((z) => z !== here && z !== 'UTC')
  const option = (value, text) => {
    const el = document.createElement('option')
    el.value = value
    el.textContent = text
    return el
  }
  $('timeZone').append(
    option('', t('lblZoneAuto', here)),
    option('UTC', 'UTC'),
    ...rest.map((z) => option(z, z)),
  )
}
fillZones()

// The pace the collected orders are allowed out at, offered as a list of the
// hours anyone actually asks for. A datalist rather than a select, because the
// field stays a number: 4 is a perfectly reasonable answer and nobody should
// have to wait for it to be added here.
$('deliveryPresets').append(
  ...DELIVERY_PRESETS.map((h) => new Option(t('dlvHours', h), String(h))),
)

const CHECKBOXES = [
  'notifyCharged', 'notifyRefunded', 'showLocalTime', 'showUtcTime', 'showBreakdown',
  'showDailyTotal', 'deliveryScheduled', 'deliveryPaused', 'verbose',
]
const NUMBERS = {
  intervalMinutes: [1, 120],
  days: [1, 30],
  deliveryHours: [1, 24],
  minPayout: [0, Number.MAX_SAFE_INTEGER],
}
const TEXTS = [
  'botToken', 'chatId', 'senderName', 'consoleUrl', 'packages', 'aiKey', 'aiBaseUrl', 'aiModel',
  'aiProbe',
]
// Not trimmed or typed into: a select can only hold what fillZones put in it.
const PICKS = ['timeZone']

function fill(settings) {
  for (const id of TEXTS) $(id).value = settings[id]
  // A stored zone a later browser has dropped would select nothing and read back
  // as "", quietly moving every future day. Kept visible instead.
  for (const id of PICKS) {
    if (settings[id] && !$(id).querySelector(`option[value="${CSS.escape(settings[id])}"]`)) {
      $(id).append(new Option(settings[id], settings[id]))
    }
    $(id).value = settings[id]
  }
  // Older installs stored developerId with no consoleUrl. Showing the URL it
  // implies keeps Save from wiping an id the form cannot otherwise see.
  $('consoleUrl').value = settings.consoleUrl || consoleUrlFor(settings.developerId)
  for (const id of Object.keys(NUMBERS)) $(id).value = settings[id]
  for (const id of CHECKBOXES) $(id).checked = settings[id]
  $('deliveryAnchor').value = normalizeAnchor(settings.deliveryAnchor)
  showSchedule()
  $('setup').hidden = isConfigured(settings)
}

// The switch above them says whether they apply at all, so with it off they are
// two answers to a question nobody asked. The switch is right there to bring
// them back, which is what makes hiding them fair rather than a disappearance.
function showSchedule() {
  $('deliveryWhen').hidden = !$('deliveryScheduled').checked
}
$('deliveryScheduled').addEventListener('change', showSchedule)

function read() {
  const out = {}
  for (const id of TEXTS) out[id] = $(id).value.trim()
  for (const id of PICKS) out[id] = $(id).value
  for (const [id, range] of Object.entries(NUMBERS)) {
    out[id] = clampNumber($(id).value, range, DEFAULTS[id])
  }
  for (const id of CHECKBOXES) out[id] = $(id).checked
  // Read through the same normaliser the form is filled from, so a browser that
  // hands back "5:00" — or nothing at all — stores what every other reader of
  // this field expects to parse.
  out.deliveryAnchor = normalizeAnchor($('deliveryAnchor').value)
  // Stored alongside the URL it came from so the service worker never has to
  // parse a user-entered string at poll time.
  out.developerId = developerIdFrom(out.consoleUrl)
  return out
}

const settings = await load()
fill(settings)

// --------------------------------------------------------------------- preview

// One order per kind of message the bot sends, because the differences between
// them are exactly what a preview is for: a renewal has to be tellable from a
// first subscription at a glance, and neither from a one-off purchase.
//
// A settled purchase and two unsettled subscriptions, which is also the real
// mix: Play reports the payout on the first and leaves the others to be
// estimated from the price.
const SAMPLES = {
  sampleBuy: {
    id: 'GPA.1234-5678-9012-34567',
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
    payout: { currency: 'KRW', amount: 5020 },
    at: Date.now(),
  },
  sampleSub: {
    id: 'GPA.2345-6789-0123-45678',
    state: 'charged',
    subscription: true,
    product: 'Premium Yearly',
    sku: 'premium_yearly',
    packageName: 'com.example.app',
    country: 'CA',
    total: { currency: 'CAD', amount: 23.93 },
    tax: { currency: 'CAD', amount: 2.94 },
    at: Date.now(),
  },
  // Play appends "..N" to the id once a subscription starts renewing, and "..1"
  // is the third charge. The suffix is the only thing that says so, which is why
  // the heading is worth previewing.
  sampleRenewal: {
    id: 'GPA.2345-6789-0123-45678..1',
    state: 'charged',
    subscription: true,
    product: 'Premium Yearly',
    sku: 'premium_yearly',
    packageName: 'com.example.app',
    country: 'CA',
    total: { currency: 'CAD', amount: 23.93 },
    tax: { currency: 'CAD', amount: 2.94 },
    at: Date.now(),
  },
}

// Enough of a rate table for the unsettled samples to show a payout figure at
// all — without one they would preview a line the reader never sees, missing the
// second half of its price.
const SAMPLE_FX = { currency: 'KRW', rates: { 'CAD>KRW': 998.18 } }

for (const key of Object.keys(SAMPLES)) {
  $('sample').append(new Option(t(key), key))
}

// A day already under way, so the footer shows what it will actually look like
// rather than the single-order case.
const SAMPLE_DAY = {
  currency: 'KRW', amount: 12240, orders: 3, refunds: 1, refunded: -6500, uncounted: 0,
}

const renderPreview = () => {
  const s = read()
  const footer = s.showDailyTotal ? totalLine('totalToday', SAMPLE_DAY) : null
  const order = SAMPLES[$('sample').value] ?? SAMPLES.sampleBuy
  $('preview').textContent = [describe(order, s, SAMPLE_FX), footer].filter(Boolean).join('\n')
}
for (const id of [
  'sample', 'senderName', 'timeZone', 'showLocalTime', 'showUtcTime', 'showBreakdown',
  'showDailyTotal',
]) {
  $(id).addEventListener('input', renderPreview)
}
renderPreview()

// -------------------------------------------------------------------- messaging

// sendMessage resolves undefined when nothing answers — most often because the
// extension was reloaded under a page that is still open, which invalidates this
// context. Turn that into an instruction instead of a TypeError.
const ask = async (type, extra = {}) => {
  try {
    return (await chrome.runtime.sendMessage({ type, ...extra })) ?? {
      ok: false,
      error: t('msgNoBackground'),
    }
  } catch {
    return { ok: false, error: t('msgNoBackground') }
  }
}

// ---------------------------------------------------------------------- actions

// The default host is in the manifest, so the common case never prompts. Any
// other one has to be asked for: a manifest broad enough to cover every
// OpenAI-compatible endpoint in advance would be asking for the whole web at
// install time, to reach one host the user has not chosen yet.
//
// Called before anything is awaited. Chrome grants this only during a user
// gesture, and an await ahead of it spends the click.
function grantFor(baseUrl) {
  let origin
  try {
    origin = `${new URL(baseUrl).origin}/*`
  } catch {
    return null
  }
  return chrome.permissions.request({ origins: [origin] })
}

$('save').addEventListener('click', async () => {
  const values = read()
  if (values.consoleUrl && !values.developerId) return say(t('msgBadUrl'), 'err')
  if (values.botToken && !/^\d+:[\w-]{30,}$/.test(values.botToken)) {
    return say(t('msgBadToken'), 'err')
  }
  // Only worth asking for when there is a key to use it with. Someone who never
  // fills that field is never prompted about a host they will not reach.
  if (values.aiKey) {
    if (!/^https:\/\//.test(values.aiBaseUrl)) return say(t('msgBadAiUrl'), 'err')
    if (!values.aiModel) return say(t('msgNeedAiModel'), 'err')
    if (!(await grantFor(values.aiBaseUrl))) return say(t('msgNeedAiHost'), 'err')
  }
  await chrome.storage.local.set(values)
  await ask('rearm')
  fill(await load())
  renderPreview()
  say(t('msgSaved'), 'ok')
})

$('findChat').addEventListener('click', async () => {
  const botToken = $('botToken').value.trim()
  if (!botToken) return sayChat(t('msgNeedToken'), 'err')
  if (!/^\d+:[\w-]{30,}$/.test(botToken)) return sayChat(t('msgBadToken'), 'err')

  sayChat(t('msgSearching'))
  const res = await ask('findChatId', { botToken })
  if (!res.ok) {
    return sayChat(res.error + (/401|Unauthorized/.test(res.error) ? t('msgUnauthorized') : ''), 'err')
  }
  if (!res.result.length) return sayChat(t('msgNoChat'), 'err')

  $('chatId').value = res.result[0].id
  sayChat(t('msgChatFilled', res.result.map((c) => `${c.id} ${c.name}`).join('\n')), 'ok')
})

$('test').addEventListener('click', async () => {
  say(t('msgChecking'))
  const res = await ask('test')
  say(res.ok ? t('msgTestSent') : res.error, res.ok ? 'ok' : 'err')
})

// Asks the model a real question over the real path, rather than pinging the
// host: a key that authenticates against a model that does not exist, or a
// service that authenticates but cannot call a tool, both look fine to a ping
// and answer nothing in the chat.
//
// Reads what was saved, not what is typed. The permission for a non-default host
// is granted on save, so a URL that has not been saved is one this could not
// reach anyway — and saying "save first" is clearer than a fetch that fails.
$('testAi').addEventListener('click', async () => {
  const saved = await load()
  if (!saved.aiKey) return sayAi(t('msgNeedAiKey'), 'err')
  if (saved.aiKey !== $('aiKey').value.trim()
    || saved.aiBaseUrl !== $('aiBaseUrl').value.trim()
    || saved.aiModel !== $('aiModel').value.trim()) {
    return sayAi(t('msgSaveAiFirst'), 'err')
  }
  // Checked here rather than left to the fetch, which fails with a network error
  // that says nothing about which of the two things went wrong.
  const origin = `${new URL(saved.aiBaseUrl).origin}/*`
  if (!(await chrome.permissions.contains({ origins: [origin] }))) {
    return sayAi(t('msgNeedAiHost'), 'err')
  }

  // Taken from the box as it stands, not from what was saved. The key, the host
  // and the model have to be saved because the worker reads them from storage
  // and the host permission is granted on save; the question does not — and
  // making someone save before every attempt would turn trying three phrasings
  // into three round trips through the form.
  //
  // An empty box asks what the placeholder shows, resolved here rather than in
  // the worker: a box cleared without saving would otherwise send nothing and
  // fall back to the saved question, which is not the one the reader is looking
  // at.
  sayAi(t('msgAsking', saved.aiModel))
  const res = await ask('testAi', { question: $('aiProbe').value.trim() || t('cmdAiProbe') })
  sayAi(res.ok ? t('msgAiAnswered', res.result) : res.error, res.ok ? 'ok' : 'err')
})

$('checkNow').addEventListener('click', async () => {
  say(t('msgChecking'))
  const res = await ask('poll')
  if (!res.ok) return say(res.error, 'err')
  say(explain(res.result), res.result.failed ? 'err' : 'ok')
})

$('reset').addEventListener('click', async () => {
  const res = await ask('reset')
  say(res.ok ? t('msgResetDone') : res.error, res.ok ? 'ok' : 'err')
})

// Opens whatever the field currently resolves to, not what was last saved — the
// point is to check the URL you just pasted. With nothing usable in it, the
// Console's own front page is where the URL is found in the first place.
$('openConsole').addEventListener('click', () => {
  const id = developerIdFrom($('consoleUrl').value.trim())
  chrome.tabs.create({ url: id ? consoleUrlFor(id) : 'https://play.google.com/console/' })
})

$('showStatus').addEventListener('click', showStatus)

$('clearLog').addEventListener('click', async () => {
  await ask('clearLog')
  renderLog([])
})

// ------------------------------------------------------------------------- log

$('logHint').textContent = t('hintLog', MAX_ENTRIES)

// A log entry stores its i18n key and arguments, never a rendered sentence, so
// switching languages re-reads history in the new one.
function lineFor(entry) {
  try {
    if (entry.key !== 'logFail') return t(entry.key, ...(entry.args ?? []))
    const [reason, fails] = entry.args ?? []
    return `${failureText(reason)} — ${t('logFailCount', fails)}`
  } catch {
    // An entry written by an older version may not render any more. Showing it
    // raw beats dropping every entry below it.
    return `${entry.key} ${(entry.args ?? []).join(' ')}`.trim()
  }
}

const clock = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
})

function renderLog(entries) {
  const view = $('logview')
  view.replaceChildren()
  if (!entries.length) {
    const li = document.createElement('li')
    li.className = 'empty'
    li.textContent = t('logEmpty')
    view.append(li)
    return
  }
  // Newest first: the answer to "is it working right now" is at the top.
  for (const entry of [...entries].reverse()) {
    const li = document.createElement('li')
    li.className = entry.level
    const dot = document.createElement('span')
    dot.className = 'dot'
    const at = document.createElement('span')
    at.className = 'at'
    at.textContent = clock.format(new Date(entry.at))
    const text = document.createElement('span')
    text.textContent = lineFor(entry)
    li.append(dot, at, text)
    view.append(li)
  }
}

// The service worker writes the log; the page follows it rather than polling.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.log) renderLog(changes.log.newValue ?? [])
})

renderLog(await readLog())

const DELIVERY_PREFIX = 'telegram: '

// Declared, not assigned to a const: the log view renders before this point in
// the file, and a const would leave it in the temporal dead zone — the render
// loop would throw on the first failure entry and silently drop every entry
// after it.
function failureText(reason) {
  if (reason === 'auth') return t('tgFailAuth')
  if (reason.startsWith(DELIVERY_PREFIX)) {
    return t('tgFailDelivery', reason.slice(DELIVERY_PREFIX.length))
  }
  return t('tgFailOther', reason)
}

// Raw result objects are for logs, not for people.
function explain(r) {
  if (r.needsSetup) return t('msgNeedSetup')
  if (r.failed) return failureText(r.failed)
  // Read before the new/scanned line rather than after: a held run scanned
  // orders and announced none, which is what "nothing new" says too, and the
  // two mean opposite things.
  if ('held' in r) return t(r.paused ? 'resultPaused' : 'resultHeld', r.held)
  if ('bootstrapped' in r) return t('resultFirst', r.bootstrapped)
  return r.new > 0 ? t('resultNew', r.new, r.scanned) : t('resultNone', r.scanned)
}

async function showStatus() {
  const res = await ask('status')
  if (!res.ok) return say(res.error, 'err')
  const s = res.result
  const lines = [s.scheduled, s.delivery]
  if (!s.configured) lines.push(t('msgNeedSetup'))
  lines.push(t('statusRecorded', s.recorded))
  if (s.consecutiveFailures > 0) lines.push(t('statusFailures', s.consecutiveFailures))
  if (s.lastSuccess) lines.push(t('statusLastSuccess', s.lastSuccess))
  if (s.lastRun) {
    lines.push(`${s.lastRun.at} — ${s.lastRun.error ?? explain(s.lastRun.result ?? {})}`)
  }
  say(lines.join('\n'), s.configured ? 'ok' : 'err')
}

showStatus()
