# Kaching

A Chrome extension that sends you a Telegram message when your Google Play
developer account takes a new order or a refund. No server, no account, nothing
to configure per app.

```
Chrome ──every N min──▶ Play Console orders API ──filter──▶ Telegram ──▶ phone
        (your session)
```

```
🔔 New order
Premium
com.example.app · KR
USD 4.99 → KRW 5,020 net
2026-08-19 08:40 GMT+9 / 2026-08-18 23:40 UTC
GPA.1234-5678-9012-34567
```

## Install

1. `chrome://extensions` → **Developer mode** → **Load unpacked** → `extension/`
2. Be signed in to Play Console in this browser
3. Click the toolbar icon, paste your Telegram bot token and Console URL, **Save**

Create the bot with `/newbot` in [@BotFather](https://t.me/BotFather); it takes a
minute. Send the bot any message, then press **Find chat ID** and the rest fills
itself in.

The first run records the orders already in the window **without notifying**.
Only new ones are announced after that.

## Why it works this way

The Play Developer API has **no endpoint that enumerates new orders.** Every
purchase lookup demands a `purchaseToken` or `orderId` you already hold, and the
only thing you can sweep by time range is `purchases.voidedpurchases.list`
(refunds). So there is no polling path to a new order on the API side.

Real-time Developer Notifications are the one push channel, but each app has to
be registered **by hand in Play Console**, and no API reports whether an app is
registered — miss one and it fails silently. It also drags in Pub/Sub, a server
to receive the push, and FCM to reach a phone.

The Console's own orders screen shows **every app in the account at once**. An
extension runs inside your live session, so the cookie expiry and IP-change
re-auth that sink server-side scraping never happen. When the session lapses,
signing in normally is the recovery.

**The cost:** it only checks while Chrome is running.

## Why it calls the API instead of reading the page

The first version scraped the orders page. It did not work, and the parser was
not the reason.

**Play Console does not render the order table while the tab is hidden.**

```
tab hidden   → rows 0,  ids 0,  len 135508
tab visible  → rows 25, ids 25, len 139681
```

Waiting does not fill it in (observed over 30 seconds). Any approach built on a
background tab returns an empty list forever, so the approach was dropped. The
extension now calls the same API the Console uses to draw that table.

```
POST playconsolemonetization-pa.clients6.google.com/v1/developer/{devId}/orders:fetch
auth SAPISIDHASH = sha1("<ts> <SAPISID> <origin>")
```

The response is protobuf-over-JSON: fields are numbers, not names.
`playconsole.js` holds that mapping.

| Field | Meaning |
|---|---|
| `1` | Order ID |
| `9` | Purchase time (ms) |
| `11.1` / `11.2` | Product title / product ID |
| `12` | 2 = one-time, 3 = subscription |
| `13` | Package name |
| `14.2` | Buyer country |
| `15` | Amount charged (tax included) |
| `19` / `26` | Amount before tax / tax |
| `27` | Net proceeds (= `19` × (1 − fee rate)) |
| `28` | The same net, converted to the developer's currency |
| `33` | 2 = charged, 4 = refunded |

The fee is 15% or 30% depending on the programme, so it is derived from
`27 / 19` rather than assumed.

### The Origin problem

SAPISIDHASH folds the origin into the hash, and the server recomputes it against
the `Origin` header it actually received. An extension sends
`chrome-extension://…`, which fails with 401.

`rules.json` rewrites `Origin` to `https://play.google.com`. Whether
declarativeNetRequest applies to an extension's own requests is not clearly
documented, so `fetchOrders` tries both origins in turn and **remembers the one
that worked** — guessing once and being wrong would mean going quiet forever. In
practice the rewritten origin is the one that works.

## Files

| File | Role |
|---|---|
| `settings.js` | Single source of defaults, read by both the options page and the worker |
| `playconsole.js` | The orders API call and response normalisation |
| `filters.js` | What to notify, and in what order (`plan`) |
| `format.js` | Message text, time zones, money |
| `health.js` | When the extension is allowed to say it is broken |
| `log.js` | Activity log (200-entry ring buffer) |
| `i18n.js` | One `chrome.i18n` substitution helper |
| `background.js` | Scheduling, dedupe, delivery, failure detection |
| `options.html/js` | Settings page |

## Settings

| Setting | Default | Notes |
|---|---|---|
| Bot token / chat ID | empty | Create in @BotFather, fill with **Find chat ID** |
| Sender label | empty | Prefixed to every message; omitted when blank |
| Console URL | empty | Paste it; the developer ID is read out of it |
| New orders / refunds | both on | Which events to announce |
| Only these apps | empty | Package names; empty means all |
| Minimum payout | 0 | Set 1 to hide zero-value test orders |
| Local time / UTC | both on | Turning both off drops the time line |
| Tax and fee breakdown | off | Adds a line so the net can be checked |
| Check every | 10 min | |
| Look back | 2 days | How far back each check reads |

Orders removed by a filter are **still recorded**. Widening a filter later
should announce future orders, not dump the backlog that was filtered out while
the narrower setting was in force.

`pending` orders are never announced. The dedupe key carries the state, so
announcing one at `pending` would announce it again when it settles.

## It tells you when it stops working

A notifier that dies quietly is indistinguishable from a quiet sales day. After
three consecutive failures it says so, and it says so again when it recovers.
Delivery failures count toward the same counter as read failures — a revoked bot
token leaves the read path healthy, so not counting it would mean no signal at
all, ever.

The alert policy lives in `health.js`. It has been wrong in both directions, so
it is a pure function pinned by tests: never clearing the cooldown buries the
second outage of the day, and clearing it on every success makes a flapping
session alert forever. The cooldown runs from when an alert **actually arrived**,
not when one was attempted.

Delivered orders are recorded **one at a time**. Recording the whole burst at the
end means a delivery error or a worker teardown halfway through re-announces
everything that already arrived. It is still at-least-once, not exactly-once: if
the worker dies between Telegram's 200 and the write, that one order repeats. A
duplicate beats a miss.

The settings page keeps an **activity log** — per-check results, messages sent,
failures and recoveries, 200 entries deep. Entries store an i18n key and its
arguments rather than a rendered sentence, so switching languages re-reads
history in the new one. It never leaves the machine.

The toolbar badge is the state at a glance: green = fine, red `!` = consecutive
failures, grey = needs setup.

## Development

```bash
node --test tools/extension.test.mjs   # unit tests
./tools/package.sh                     # builds dist/kaching-<version>.zip
```

Packaging verifies that every manifest reference and every relative import is
actually present in the zip. The file list is maintained by hand, so a new module
left out of it loads fine unpacked and only surfaces after upload, as a failed
service-worker registration.

Store listing copy and permission justifications are in `extension/STORE.md`; the
privacy policy is `extension/PRIVACY.md`. Neither ships in the package.
Screenshots and their sources are in `store/`.

## Out of scope

- Anything happening while Chrome is closed
- Paid app purchases (they appear in the orders list, but this is unverified)

## License

[MIT](LICENSE)

## Notice

Not affiliated with Google, Google Play, or Telegram.
