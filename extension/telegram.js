// Telegram Bot API. Chosen over chrome.notifications because the point is to
// reach the phone, not the desktop that is already showing the Console.
const API = 'https://api.telegram.org/bot'

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
  const res = await fetch(`${API}${botToken}/getUpdates`)
  const json = await res.json().catch(() => ({}))
  if (!json.ok) throw new Error(json.description ?? `getUpdates ${res.status}`)
  const chats = []
  for (const u of json.result ?? []) {
    const chat = u.message?.chat ?? u.channel_post?.chat
    if (chat && !chats.some((c) => c.id === chat.id)) {
      chats.push({ id: chat.id, name: chat.title ?? chat.username ?? chat.first_name ?? '' })
    }
  }
  return chats
}
