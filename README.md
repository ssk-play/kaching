# Kaching

A Chrome extension that sends you a Telegram message when your Google Play
developer account takes a new order or a refund.

No server, no account, nothing to set up per app. It runs in your browser using
the Play Console session you are already signed in to.

```
🔔 New order
Premium · premium_unlock
com.example.app · KR
USD 4.99 → KRW 5,020 est. net
2026-08-19 08:40 GMT+9 / 2026-08-18 23:40 UTC
GPA.1234-5678-9012-34567
Today KRW 18,740 · 4 orders
```

Send the bot `/today`, `/week` (from Sunday) or `/month` — all three appear in
the bot's own command menu, so there is nothing to memorise.
Answers come back within a second or two: a separate one-minute alarm holds a
long poll open on Telegram, so a command is usually waited for rather than
looked for.

## Settings

| Setting | Default | |
|---|---|---|
| Bot token / chat ID | — | Created in @BotFather; **Find chat ID** fills the second |
| Console URL | — | Paste it; the developer ID is read out of it |
| New orders / refunds | both on | Which events to announce |
| Only these apps | all | Package names |
| Minimum payout | 0 | Set 1 to hide zero-value test orders |
| Local time / UTC | both on | |
| Tax and fee breakdown | off | Adds a line so the estimated net figure can be checked |
| Day's running total | on | Footer on every order message — the bot commands work either way |
| Check every | 10 min | Only runs while Chrome is open |
| Look back | 2 days | How far back each check reads |
| Sender label | — | Prefixed to every message, for a shared chat |

The first run records what is already there without notifying; only new orders
are announced after that.

## How it works

**There is no API for this.** The Play Developer API has no endpoint that
enumerates new orders — every purchase lookup demands a token or order ID you
already hold, and the only time-ranged sweep is the voided-purchases list.
Real-time Developer Notifications are the one push channel, but every app must
be registered by hand in Play Console with no API to confirm it, so a missed app
fails silently.

**The page cannot be scraped.** The first version read the orders page and
returned nothing. The parser was not the reason:

```
tab hidden   → 0 rows
tab visible  → 25 rows
```

Play Console does not render the order table while the tab is hidden, and
waiting does not help. Anything built on a background tab returns an empty list
forever.

**So it calls the API the Console itself uses.** `orders:fetch` on
`playconsolemonetization-pa.clients6.google.com`, authenticated with the same
`SAPISIDHASH` scheme the Console page uses. No rendering involved. See
`extension/playconsole.js` for the request and the response field mapping.

## Reliability

A notifier that dies quietly is indistinguishable from a quiet sales day, so
this one reports its own failures: three consecutive failures trigger a Telegram
message, and recovery is announced too. Delivery failures count the same as read
failures — a revoked bot token leaves the read path healthy, so ignoring it would
mean no signal at all.

Delivery is at-least-once. Each order is recorded the moment it is sent rather
than at the end of a batch, so an error partway through does not re-announce
what already arrived. If the worker dies between Telegram's response and the
write, that one order repeats. A duplicate beats a miss.

The settings page keeps a 200-entry activity log — checks, messages, failures,
recoveries. It never leaves the machine.

## Development

```bash
node --test tools/extension.test.mjs   # unit tests
./tools/package.sh                     # builds dist/kaching-<version>.zip
```

Packaging verifies that every manifest reference and relative import is present
in the zip; a module left out loads fine unpacked and only fails after upload.

## License

[MIT](LICENSE) · Not affiliated with Google, Google Play, or Telegram.
