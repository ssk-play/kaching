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
// `canWrite` is whether run_recount was among the tools handed in. It is not
// always: the options page's test button asks its question with nothing to run a
// recount with. A prompt that described the tool anyway would have the model
// reach for one that is not in the list, and the connection test would read as a
// broken endpoint rather than as a tool the caller did not offer.
const system = (today, canWrite) =>
  [
    "You answer questions about one Google Play developer's own sales tally, in a Telegram chat.",
    `Today is ${today}. Every day is an ISO date in the tally's own time zone, which is`,
    'the only zone here — you never have to convert one or ask which it is.',
    'You are talking to the developer, so a message may be a follow-up to the last one, or may',
    'not be a question at all — greet a greeting briefly and say what you can look up.',
    'Read every figure with a tool. Never estimate, extrapolate or invent one, never add up',
    'days yourself when a tool will do it, and never answer from memory of an earlier turn if',
    'you can read it again. read_totals is a total over a range, grouped by day, week, month',
    'or year — whichever the question is about; read_by_currency splits the same money by the',
    'currency the buyer paid in; read_by_kind splits it by whether each sale was a one-off',
    'purchase, a new subscription or a renewal, and by how often it bills. All of them take',
    'any range at all, so ask for what was asked about: read_totals with groupBy for a weekly',
    'or monthly figure, read_by_currency for a question about a currency or a country, and',
    'read_by_kind for one about subscriptions, renewals, or monthly versus yearly plans.',
    'A question that names no period is a question about all of it, so leave the range off',
    'rather than guessing a recent one — a guess answers zero for everything older than',
    'itself, and "none" is a wrong answer that reads exactly like a right one. If you do',
    'narrow a range, say in your answer which days you read.',
    'read_expected is the one tool that answers about days that have not happened. It gives a',
    'month in three parts: what it has already earned, what subscriptions are scheduled to',
    'bill, and what the rest of it would take at the rate of recent trade. Quote the parts,',
    'not just the total — the first is a fact, the second cannot see a cancellation, and the',
    'third is a run rate off a window the answer names. Give the figure and what it rests on',
    'in the same breath, never the figure alone and never the caveat as a footnote under it.',
    ...(canWrite
      ? [
        'run_recount fetches a span from Play again and rebuilds the tally from it. It writes,',
        'so run it only when you are asked to and never to check a figure yourself. Ask for',
        'the month or day named; if a year or the whole history is wanted, say to type',
        '"/recount 2026" or "/recount" instead, because that outlives this chat.',
      ]
      : [
        'You can only read here. Asked to recount, adjust or change anything, say that it has',
        'to be typed as a command — /recount for a refetch, /adjust for a correction.',
      ]),
    'Say plainly when you cannot answer. If no tool can reach what was asked — a figure per',
    'app or per product, a country rather than a currency, why a number moved, a day in the',
    'future that read_expected does not cover — say that this tally does not record it, name',
    'the closest thing it does, and stop. Do not answer a near-miss question as though it were',
    'the one asked, and do not build a figure out of parts that were not measured together. A',
    'tool that hands back an error or a refusal is the answer: pass on what it said instead of',
    'trying another range until something comes back.',
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

// What /compact keeps. Short on purpose: it is resent with every question for
// the next half hour, so a summary as long as the turns it replaced would cost
// more than it saved.
const MAX_SUMMARY = 600

// No tools, and none offered. A summary is written from what was already said —
// a model that went back to the ledger here would be paying to re-read days in
// order to describe a conversation about them, and could quietly contradict the
// answer the reader was actually given.
const CONDENSE = [
  'You are compacting a short chat between a Google Play developer and an assistant that',
  'reads their sales tally.',
  'Write a brief recap of the exchange above, so that a follow-up question like "그럼 지난달은?"',
  'still has something to refer to.',
  'Keep the subject, the days or currencies asked about, and any figure that was quoted,',
  'with its currency. Drop the pleasantries and anything already superseded.',
  'Write it in the language the developer was using, as a few short lines of plain text.',
  'No Markdown, no preamble, and do not add a figure that was not said above.',
].join(' ')

// A synthetic turn, in the same shape as a real one, so the replay in ask()
// needs no special case for it and a compacted conversation can be compacted
// again. Phrased as something the developer could have asked, because that is
// the only role the history has to put it in.
export const RECAP = 'Before we go on: what have we been talking about?'
export const compacted = (summary, now) => ({ at: now, turns: [{ q: RECAP, a: summary }] })

// One call, one answer, nothing written. Whether the summary is kept — and what
// happens when this comes back empty — is decided by the caller, which is the
// side that knows whether the slate was cleared while this was in flight.
export async function summarize({ apiKey, baseUrl, model }, turns) {
  const reply = await call({ apiKey, baseUrl }, {
    model,
    max_tokens: MAX_TOKENS,
    messages: [
      ...turns.flatMap(({ q, a }) => [
        { role: 'user', content: q },
        { role: 'assistant', content: a },
      ]),
      { role: 'user', content: CONDENSE },
    ],
  })
  return textOf(reply.choices?.[0]?.message).slice(0, MAX_SUMMARY)
}

// Does this endpoint actually carry a question, or only the last sentence of
// one? Every figure here is read with a tool, under a system prompt that says
// which tools and what the days mean — so an endpoint that quietly drops either
// leaves the model answering about Google Play sales with no Google Play sales
// in front of it. Which it does: it answers, fluently, about the stock market.
//
// Worth a call of its own because that failure is invisible from the answer. A
// gateway that strips these still returns 200 with prose in it, so the test
// button went green while the chat was unusable, and the only way anyone found
// out was by arguing with it.
//
// One round trip proves both, and tells them apart: a ping that comes back as a
// tool call means the system prompt reached the model *and* the tool list did;
// the word alone means the tools were dropped; neither means the system message
// never arrived.
const PING_WORD = 'KACHING-OK'
const PING = {
  type: 'function',
  function: {
    name: 'ping',
    description: 'Report back the word you were given.',
    parameters: {
      type: 'object',
      properties: { word: { type: 'string' } },
      required: ['word'],
    },
  },
}
const PING_SYSTEM =
  'You are a connection test, not an assistant. Do exactly one thing: call the tool named ' +
  `ping once, with word set to ${PING_WORD}. Add no other text.`

export const CARRIES_BOTH = 'ok'
export const DROPS_TOOLS = 'tools'
export const DROPS_SYSTEM = 'system'

export async function probe({ apiKey, baseUrl, model }) {
  const reply = await call({ apiKey, baseUrl }, {
    model,
    max_tokens: MAX_TOKENS,
    tools: [PING],
    messages: [
      { role: 'system', content: PING_SYSTEM },
      { role: 'user', content: 'Run the connection test.' },
    ],
  })
  const said = reply.choices?.[0]?.message
  if ((said?.tool_calls ?? []).some((c) => c.function?.name === 'ping')) return CARRIES_BOTH
  // The instruction landed but the tool list did not, so the model said the word
  // instead of calling with it.
  if (textOf(said).toUpperCase().includes(PING_WORD)) return DROPS_TOOLS
  return DROPS_SYSTEM
}

export async function ask({ apiKey, baseUrl, model, question, today, tools, history = [] }) {
  // Replayed as plain sentences. What the model actually said and did on those
  // turns — which days it read, in how many calls — is not carried: it can read
  // them again for the price of one tool call, and a tool call resent without
  // the result that answered it is a request the API rejects.
  const messages = [
    { role: 'system', content: system(today, tools.some((x) => x.spec.name === 'run_recount')) },
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
