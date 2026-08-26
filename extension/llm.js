// Answers a question about the tally, using a key the user brought themselves.
//
// Spoken to over the OpenAI chat-completions shape rather than any one vendor's
// own. It is what nearly every provider now offers, so the setting is a URL
// instead of a brand: OpenAI by default because it is the one everybody already
// has an account with, and a gateway, a cheaper provider or something running on
// the reader's own machine by changing one field.
//
// Raw fetch rather than an SDK for the same reason telegram.js is: this
// extension has no build step, and a bundler earns its place somewhere other
// than one POST.
//
// The five fixed commands never come through here. /today has to answer when the
// key is missing, expired or over its limit, so it stays a lookup and this stays
// what answers everything that is not one of them.
import { t } from './i18n.js'

// A trailing slash on a pasted URL would otherwise make a double one, which some
// gateways route and others answer with a 404.
export const endpointFor = (base) => `${String(base).replace(/\/+$/, '')}/chat/completions`

const MAX_TOKENS = 1024
// One turn to ask for figures, one to answer, and slack for a question that
// needs two ranges. The ceiling is what stops a model that keeps re-reading the
// same days from spending a chat command's worth of money on a loop.
const MAX_TURNS = 4
// Well inside the 30s idle window Chrome tears a service worker down in, so a
// request that hangs is abandoned while the worker is still alive to say so.
// Each turn reads storage on its way through the ledger tool, which resets that
// timer the same way the long poll's own loop does.
//
// The ceiling has to cover the body as well as the headers. A reply whose
// headers arrive and whose body then stalls would otherwise hang here forever,
// and this is awaited before the update cursor moves — so the worker would be
// torn down with the question unacknowledged and the next minute would ask it
// again, paying for it again, without ever having read the first answer.
const TIMEOUT_MS = 20_000
// Telegram rejects anything past 4096 characters, and the whole message would be
// lost rather than trimmed.
const MAX_REPLY = 3500

// Written out rather than pulled from _locales: it addresses the model, not the
// user, and the answer is asked to follow the question's language instead of the
// browser's — the person typing into Telegram is not necessarily sitting at the
// machine this is running on.
const system = (today) =>
  [
    "You answer questions about one Google Play developer's own sales tally, in a Telegram chat.",
    `Today is ${today}. Every day is an ISO date in the developer's own time zone.`,
    'You are talking to the developer, so a message may be a follow-up to the last one, or may',
    'not be a question at all — greet a greeting briefly and say what you can look up.',
    'Read every figure with a tool. Never estimate, extrapolate or invent one, never add up',
    'days yourself when a tool will do it, and never answer from memory of an earlier turn if',
    'you can read it again. read_totals is day by day; read_by_currency splits the same money',
    'by the currency the buyer paid in and takes any range, so use it for a question about one',
    'currency or country, and for any total spanning more than two months.',
    'Quote the exact amounts you read, with their currency, so the reader can check the answer',
    'against them. If a day is flagged uncounted, say that its figure is short.',
    'Never add a standing disclaimer about where the figures come from. The reader owns this',
    'tally and knows. A caveat under every answer is noise, and noise is what hides the one',
    'answer that really is short — mention a shortfall only when a row you read declares one.',
    'Reply in the language of the question, as a few short lines of plain text.',
    'No Markdown, no tables, no preamble.',
  ].join(' ')

// What counts as a question. Empty is a photo or a sticker; a leading slash is a
// command, and one this does not know is a typo rather than a sentence —
// answering /todya would spend money on a slip the user is about to correct.
export const isQuestion = (said) => {
  const text = String(said).trim()
  return Boolean(text) && !text.startsWith('/')
}

// Enough for "그럼 지난달은?" to know what last month is being compared to, and no
// more: every remembered turn is resent with the next question, so this is a
// bill as much as a memory.
export const MAX_TURNS_KEPT = 4
// A question asked half an hour after the last one is a new subject. Carrying
// the old one in would have the model answer about days nobody asked about, and
// pay to reread them.
export const HISTORY_TTL_MS = 30 * 60_000

const spent = (stored, now) => !stored || now - stored.at > HISTORY_TTL_MS

// Kept apart from the storage read so the rule about when a conversation has
// lapsed is one expression both sides share, rather than two that can disagree
// about which turns are still current.
export const freshTurns = (stored, now) => (spent(stored, now) ? [] : stored.turns)

export const nextTurns = (stored, now, q, a) => ({
  // Stamped at the last turn, not the first: a conversation still being had has
  // not lapsed, however long it has been going.
  at: now,
  turns: [...freshTurns(stored, now), { q, a }].slice(-MAX_TURNS_KEPT),
})

// Only what the model said, never what it thought on the way. A reasoning model
// returns its working in reasoning_content, and a chat that printed that would be
// showing the reader a draft they never asked for.
export const textOf = (message) => String(message?.content ?? '').trim()

async function call({ apiKey, baseUrl }, body) {
  const res = await fetch(endpointFor(baseUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  // Only a refusal is allowed a body this cannot read: the status already says
  // enough to report one. On a 200 the body is the whole answer, and a read that
  // fails — the timeout above firing mid-body, or a captive portal serving HTML
  // through — has to reach the chat as the failure it is. Swallowed into {}, it
  // would come back as "no answer came back", which sends the reader off to ask
  // again rather than to look at their network.
  const json = await res.json().catch((err) => {
    if (res.ok) throw err
    return {}
  })
  // The API says why in the body — an expired key and a spent balance are
  // different problems with different fixes, and the status alone tells the
  // reader neither.
  if (!res.ok) throw new Error(json.error?.message ?? `${baseUrl} ${res.status}`)
  return json
}

// One message per result, each naming the call it answers. A call left without
// its result is a conversation the API rejects on the next turn, so every one of
// them comes back — including the ones that failed.
const resultsFor = (calls, tools) =>
  Promise.all(
    calls.map(async (call_) => {
      const name = call_.function?.name
      const tool = tools.find((x) => x.spec.name === name)
      const answer = async () => {
        if (!tool) throw new Error(`no such tool: ${name}`)
        // Arguments arrive as a string of JSON rather than as an object, and a
        // model that writes malformed JSON is a thing that happens — caught
        // below with everything else rather than thrown into the loop.
        return JSON.stringify(await tool.run(JSON.parse(call_.function.arguments || '{}')))
      }
      return {
        role: 'tool',
        tool_call_id: call_.id,
        // Handed back rather than thrown. A failed read is something the model
        // can tell the reader about; an exception here would lose the question.
        content: await answer().catch((err) => String(err?.message ?? err)),
      }
    }),
  )

export async function ask({ apiKey, baseUrl, model, question, today, tools, history = [] }) {
  // Replayed as plain sentences. What the model actually said and did on those
  // turns — which days it read, in how many calls — is not carried: it can read
  // them again for the price of one tool call, and a tool call resent without
  // the result that answered it is a request the API rejects.
  const messages = [
    { role: 'system', content: system(today) },
    ...history.flatMap(({ q, a }) => [
      { role: 'user', content: q },
      { role: 'assistant', content: a },
    ]),
    { role: 'user', content: question },
  ]
  const specs = tools.map((x) => ({ type: 'function', function: x.spec }))

  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    const reply = await call({ apiKey, baseUrl }, {
      model,
      max_tokens: MAX_TOKENS,
      tools: specs,
      messages,
    })
    const said = reply.choices?.[0]?.message
    const calls = said?.tool_calls ?? []
    // Appended whole, because the tool_calls in it are what the results below
    // name — a turn stripped to its prose would leave them answering nothing.
    // Minus the reasoning: providers differ on whether they will accept their
    // own working back, and none of them need it to continue.
    messages.push({ role: 'assistant', content: said?.content ?? '', ...(calls.length ? { tool_calls: calls } : {}) })

    if (!calls.length) return textOf(said).slice(0, MAX_REPLY) || t('cmdAiNothing')
    messages.push(...(await resultsFor(calls, tools)))
  }
  // Out of turns with the model still reading. Saying so is the honest answer;
  // the alternative is a summary of figures it had not finished gathering.
  return t('cmdAiGaveUp')
}
