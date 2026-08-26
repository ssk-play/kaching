// Telegram Bot API. Chosen over chrome.notifications because the point is to
// reach the phone, not the desktop that is already showing the Console.
const API = 'https://api.telegram.org/bot'

// allowed_updates is remembered by Telegram per bot: whatever the last caller
// passed stays in force for every later call, including ones that pass nothing.
// So both callers name the same kinds — otherwise the poller asking only for
// "message" would permanently switch off the channel posts findChatId reads.
const KINDS = encodeURIComponent('["message","channel_post"]')

export async function send(botToken, chatId, text) {
  const res = await fetch(`${API}${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // No parse_mode: order text is arbitrary and escaping it wrong would turn a
    // delivery into a 400. Plain text always sends.
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok || !json.ok) {
    throw new Error(`telegram ${res.status} ${json.description ?? 'unknown error'}`)
  }
  return json.result.message_id
}

// Resolves the chat id from whatever conversation the user has already started
// with the bot, so it never has to be looked up by hand.
export async function findChatId(botToken) {
  const res = await fetch(`${API}${botToken}/getUpdates?allowed_updates=${KINDS}`)
  const json = await res.json().catch(() => ({}))
  if (!json.ok) throw new Error(json.description ?? `getUpdates ${res.status}`)
  return chatsIn(json.result ?? [])
}

// Shared, so the poller banks chats in exactly the shape findChatId returns.
export function chatsIn(list) {
  const chats = []
  for (const u of list) {
    const chat = u.message?.chat ?? u.channel_post?.chat
    if (chat && !chats.some((c) => c.id === chat.id)) {
      chats.push({ id: chat.id, name: chat.title ?? chat.username ?? chat.first_name ?? '' })
    }
  }
  return chats
}

// waitSeconds holds the connection open until something arrives — the only way
// to answer a command promptly without a server to receive a webhook. Keep it
// under the 30s of inactivity Chrome tears a service worker down after, and let
// the caller chain several waits rather than asking for one long one: a worker
// killed mid-hold answers nothing and cannot even log that it did not.
//
// Telegram allows one getUpdates at a time and answers a second with 409, so the
// caller has to keep exactly one in flight.
//
// The offset acknowledges everything below it, which Telegram then drops. That
// is necessary rather than optional: without it getUpdates keeps returning the
// hundred *oldest* pending updates, so a busy chat would bury every new command
// behind a backlog the poller could never see past.
//
// What that costs — a poll consuming the message Find chat ID would have read —
// is paid back elsewhere: the poller banks every chat it sees, and findChatId
// answers from that memory as well as from the server.
export async function updates(botToken, offset, waitSeconds = 0) {
  const from = offset > 0 ? `&offset=${offset}` : ''
  // A hung connection would hold the caller's single-flight slot open and stall
  // every later check behind it, so the wait has a hard ceiling of its own.
  const signal = AbortSignal.timeout((waitSeconds + 10) * 1000)
  const res = await fetch(
    `${API}${botToken}/getUpdates?timeout=${waitSeconds}&allowed_updates=${KINDS}${from}`,
    { signal },
  )
  const json = await res.json().catch(() => ({}))
  if (!json.ok) throw new Error(json.description ?? `getUpdates ${res.status}`)
  return json.result ?? []
}

// The command menu Telegram shows next to the input box, and autocompletes when
// someone types "/". Without it these commands exist only for whoever read the
// README — a feature nobody can find is a feature nobody has.
//
// Written out per language rather than pulled from chrome.i18n: both lists are
// registered at once so the menu follows the *Telegram* user's language, and
// chrome.i18n only ever yields the one locale the browser is running in.
export const MENU = {
  en: [
    { command: 'today', description: "Today's total so far" },
    { command: 'week', description: 'This week so far (from Sunday)' },
    { command: 'month', description: 'This month so far' },
    { command: 'recount', description: 'Fetch it all from Play again, or name a day, month or year' },
    { command: 'adjust', description: "Correct a day's total by an amount" },
    { command: 'help', description: 'What this bot can do' },
    { command: 'start', description: 'What this bot can do' },
  ],
  ko: [
    { command: 'today', description: '오늘 누계' },
    { command: 'week', description: '이번 주 누계 (일요일부터)' },
    { command: 'month', description: '이번 달 누계' },
    { command: 'recount', description: 'Play 에서 전체 다시 가져오기 (날짜·월·연도 지정 가능)' },
    { command: 'adjust', description: '특정 날짜 누계를 금액으로 보정' },
    { command: 'help', description: '이 봇이 할 수 있는 일' },
    { command: 'start', description: '이 봇이 할 수 있는 일' },
  ],
}

// What the menu currently says, as one number. The registration is remembered so
// a save that changes nothing does not re-send it — but remembered against the
// bot and the chat alone, a menu that gained a command would never reach anyone
// who had already set the bot up. They would keep the list they were given on
// the day they installed, which is how /recount stayed invisible to every
// existing install after it shipped.
//
// Derived from the list rather than a version number kept beside it, because a
// number has to be remembered by hand and this is exactly the kind of edit where
// it would not be.
export function menuFingerprint(menu = MENU) {
  const text = JSON.stringify(menu)
  let h = 0
  for (let i = 0; i < text.length; i += 1) h = (Math.imul(h, 31) + text.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

async function call(botToken, method, body) {
  const res = await fetch(`${API}${botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!json.ok) throw new Error(json.description ?? `${method} ${res.status}`)
}

// Scoped to the one chat this bot answers in, not to every chat it is in.
// The default scope would autocomplete /today for anyone who can reach the bot —
// a teammate in the same group, or a stranger who knows its username — and every
// one of them would be typing a command that is answered with silence, because
// replies only ever go to the configured chat.
export async function publishCommands(botToken, chatId) {
  const scope = { type: 'chat', chat_id: chatId }
  // Clears a default-scope list left by an earlier version of this extension, so
  // the advertisement stops where the answers stop.
  await call(botToken, 'deleteMyCommands', {})
  for (const [language, commands] of Object.entries(MENU)) {
    const body = { commands, scope }
    // The entry with no language_code is the fallback every other locale gets.
    if (language !== 'en') body.language_code = language
    await call(botToken, 'setMyCommands', body)
  }
}
