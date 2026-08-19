import {
  DEFAULTS, load, developerIdFrom, isConfigured, consoleUrlFor, clampNumber,
} from './settings.js'
import { describe } from './format.js'
import { read as readLog, MAX_ENTRIES } from './log.js'
import { t } from './i18n.js'

const $ = (id) => document.getElementById(id)
const log = $('log')

const say = (text, cls = '') => {
  log.textContent = text
  log.className = cls
}

// ------------------------------------------------------------------------ i18n

document.title = t('optTitle')
for (const el of document.querySelectorAll('[data-i18n]')) {
  el.textContent = t(el.dataset.i18n)
}

// ------------------------------------------------------------------- form <-> storage

const CHECKBOXES = [
  'notifyCharged', 'notifyRefunded', 'showLocalTime', 'showUtcTime', 'showBreakdown', 'verbose',
]
const NUMBERS = { intervalMinutes: [1, 120], days: [1, 30], minPayout: [0, Number.MAX_SAFE_INTEGER] }
const TEXTS = ['botToken', 'chatId', 'senderName', 'consoleUrl', 'packages']

function fill(settings) {
  for (const id of TEXTS) $(id).value = settings[id]
  // Older installs stored developerId with no consoleUrl. Showing the URL it
  // implies keeps Save from wiping an id the form cannot otherwise see.
  $('consoleUrl').value = settings.consoleUrl || consoleUrlFor(settings.developerId)
  for (const id of Object.keys(NUMBERS)) $(id).value = settings[id]
  for (const id of CHECKBOXES) $(id).checked = settings[id]
  $('setup').hidden = isConfigured(settings)
}

function read() {
  const out = {}
  for (const id of TEXTS) out[id] = $(id).value.trim()
  for (const [id, range] of Object.entries(NUMBERS)) {
    out[id] = clampNumber($(id).value, range, DEFAULTS[id])
  }
  for (const id of CHECKBOXES) out[id] = $(id).checked
  // Stored alongside the URL it came from so the service worker never has to
  // parse a user-entered string at poll time.
  out.developerId = developerIdFrom(out.consoleUrl)
  return out
}

const settings = await load()
fill(settings)

// --------------------------------------------------------------------- preview

const SAMPLE = {
  id: 'GPA.1234-5678-9012-34567',
  state: 'charged',
  subscription: false,
  product: 'Premium',
  packageName: 'com.example.app',
  country: 'KR',
  total: { currency: 'USD', amount: 4.99 },
  beforeFee: { currency: 'USD', amount: 4.54 },
  tax: { currency: 'USD', amount: 0.45 },
  net: { currency: 'USD', amount: 3.86 },
  payout: { currency: 'KRW', amount: 5020 },
  at: Date.now(),
}

const renderPreview = () => {
  $('preview').textContent = describe(SAMPLE, read())
}
for (const id of ['senderName', 'showLocalTime', 'showUtcTime', 'showBreakdown']) {
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

$('save').addEventListener('click', async () => {
  const values = read()
  if (values.consoleUrl && !values.developerId) return say(t('msgBadUrl'), 'err')
  if (values.botToken && !/^\d+:[\w-]{30,}$/.test(values.botToken)) {
    return say(t('msgBadToken'), 'err')
  }
  await chrome.storage.local.set(values)
  await ask('rearm')
  fill(await load())
  renderPreview()
  say(t('msgSaved'), 'ok')
})

$('findChat').addEventListener('click', async () => {
  const botToken = $('botToken').value.trim()
  if (!botToken) return say(t('msgNeedToken'), 'err')
  if (!/^\d+:[\w-]{30,}$/.test(botToken)) return say(t('msgBadToken'), 'err')

  say(t('msgSearching'))
  const res = await ask('findChatId', { botToken })
  if (!res.ok) {
    return say(res.error + (/401|Unauthorized/.test(res.error) ? t('msgUnauthorized') : ''), 'err')
  }
  if (!res.result.length) return say(t('msgNoChat'), 'err')

  $('chatId').value = res.result[0].id
  say(t('msgChatFilled', res.result.map((c) => `${c.id} ${c.name}`).join('\n')), 'ok')
})

$('test').addEventListener('click', async () => {
  say(t('msgChecking'))
  const res = await ask('test')
  say(res.ok ? t('msgTestSent') : res.error, res.ok ? 'ok' : 'err')
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
  if ('bootstrapped' in r) return t('resultFirst', r.bootstrapped)
  return r.new > 0 ? t('resultNew', r.new, r.scanned) : t('resultNone', r.scanned)
}

async function showStatus() {
  const res = await ask('status')
  if (!res.ok) return say(res.error, 'err')
  const s = res.result
  const lines = [s.scheduled]
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
