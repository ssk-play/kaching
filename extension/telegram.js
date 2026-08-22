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

// Short poll, never a long one: a service worker parked on a 30-second Telegram
// hold is a worker Chrome is entitled to kill mid-hold.
//
// The offset acknowledges everything below it, which Telegram then drops. That
// is necessary rather than optional: without it getUpdates keeps returning the
// hundred *oldest* pending updates, so a busy chat would bury every new command
// behind a backlog the poller could never see past.
//
// What that costs — a poll consuming the message Find chat ID would have read —
// is paid back elsewhere: the poller banks every chat it sees, and findChatId
// answers from that memory as well as from the server.
export async function updates(botToken, offset) {
  const from = offset > 0 ? `&offset=${offset}` : ''
  const res = await fetch(`${API}${botToken}/getUpdates?timeout=0&allowed_updates=${KINDS}${from}`)
  const json = await res.json().catch(() => ({}))
  if (!json.ok) throw new Error(json.description ?? `getUpdates ${res.status}`)
  return json.result ?? []
}
