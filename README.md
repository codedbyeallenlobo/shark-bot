# shark-bot

A trading bot for Shark Exchange USDT perpetual futures. Nine instances run
concurrently against a single exchange account on an Oracle Cloud VPS,
supervised by pm2.

As deployed it takes a single entry per symbol and manages one exit. The code
also supports laddering into a position over several levels (`--levels N`,
default 4), but production runs `--levels 1`, so no averaging down happens.

This repository holds what is actually deployed and running — not a prototype.

> **Live trading risks real money.** Everything here runs with `--live` against
> a funded account. Read [what it does not protect you from](#what-this-does-not-do)
> before running any of it.

---

## What it does

Each bot process owns one symbol. It opens a position, places a resting
take-profit, and manages the exit. Entries rest passively at bid (long) or ask
(short) to earn the maker fee rather than pay the taker fee, which matters when
the profit target is a few rupees per round trip.

```
node finalepicbot.js --symbol SUSDT --usdt 6 --tp 4 \
  --bail-floating 200 --bail-at 200 \
  --max-hold-min 180 --only-red \
  --start-side short --no-alternate --reentry-better --levels 1 --live
```

In production all nine are launched together:

```
pm2 start ecosystem.config.js
```

---

## The interesting parts

### Nine processes, one account

The processes share an exchange account but have no shared memory, so every
piece of coordination is a file operation that has to be atomic across
processes.

- **Symbol locks** — `FINALEPIC_LOCK_<SYMBOL>` is created with
  `fs.writeFileSync(..., {flag:'wx'})`, which fails if the file exists. The
  holder's PID is written into it and liveness is checked with
  `process.kill(pid, 0)`, so a lock left behind by a killed process is
  recovered rather than deadlocking.
- **A shared PnL baseline** — account-wide caps measure from one timestamp in
  `bank-baseline.json`. A bot starting late adopts the round already running
  instead of beginning its own, otherwise nine bots would measure nine
  different nets.
- **A single-winner round claim** — when a cap trips, all nine cross the
  threshold on the same 20-second tick. An exclusive file create decides which
  one acts; the rest follow. Without it, nine bots each flatten on their own
  authority.
- **`closableQty()`** — exits size from `min(exchangeQty, ownBook)`. An earlier
  version sized from the account-wide position, and with two bots on one symbol
  the exit compounded 231 → 462 → 924 → 2772.

### Rate limiting

The exchange allows 60 requests/minute per account. The first version used 611.
Now it is 4.8 per bot per minute, flat from 5 to 25 concurrent processes:

- one websocket feed per process carries prices for all ~700 symbols
- account snapshots are shared through `account-snapshot.json` behind a lock,
  so nine bots reading "what do I hold" costs one request, not nine
- the mover scan is cached and lock-guarded — a second bot waits for the first
  bot's answer rather than running an identical scan

### Exits derived from measurement, not intuition

Every closed episode appends a row to `finalepic-mae.csv` with its **maximum
adverse excursion** — how far underwater it went before it came back:

```
ts,symbol,direction,qty,avg_entry,exit_price,mae_pct,mae_inr,
mfe_pct,mfe_inr,pnl_inr,outcome,exit_reason,held_sec
```

Across 92 trades that data showed winners closing fast (median 9.1 min, p75
62 min) while every loser ran long — one for 570 minutes. `--max-hold-min 180
--only-red` came out of that: a repeating checkpoint that closes a position
only if it is red beyond a threshold, so losers are cut on a schedule while
winners keep running. In its first session it cut a position at −22 INR whose
drawdown had already reached −47.

`analyse-mae.js` reproduces the analysis.

### Two kinds of stop

- `--bail-floating N` — flatten everything when the **open positions** are
  worse than −N INR. Realised history is excluded, so banked profit cannot mask
  a drawdown in progress.
- `--bail-at N` — flatten everything when **realised since the baseline plus
  floating** is worse than −N INR. A session equity floor.

Both write `FINALEPIC_BAIL`. Every bot sees it within one check, flattens its
own position, and halts. The file then blocks startup until a human removes it:
a stop that fired because something went wrong should not restart itself into
the same conditions.

pm2 is configured with `stop_exit_codes: [0]` so a deliberate halt is final.
Without it, the bots exit, pm2 restarts them, each hits the startup guard and
exits again — observed at roughly 125 restarts per process before it was fixed.

---

## Deployment

Runs on an Oracle Cloud Always Free instance (1 OCPU, 498 MB usable RAM).
Nine bots sit at 22–30 MB each; measured at 367 MB used with all nine live.

Setup covers swap sizing, process supervision, boot persistence, per-process
memory limits, and an SSH tunnel for the dashboard. The runbook with the live
host details is kept out of this repository deliberately.

The dashboard serves data derived from the API keys and binds to `127.0.0.1`
only. It is reached over an SSH tunnel; nothing but port 22 is open.

---

## Setup

```bash
npm install
cp .env.example .env     # add SHARK_API_KEY and SHARK_API_SECRET
```

Shark pins the API key to a whitelisted IP, so a key that works on one machine
returns HTTP 403 from another until that address is whitelisted too.
`ipwatch.js` watches for that and notifies when the address rotates — the
problem a static-IP VPS removes entirely.

Run without `--live` for a dry run. It connects to the real feed and prices
everything, but places no orders.

---

## What this does not do

- **No stop loss.** Nothing closes a losing trade on price. At 10× isolated a
  short liquidates roughly 10% above the average entry, and a short's loss has
  no ceiling the way a long's does at zero. The only backstops are the
  take-profit, the time exit, and the two bail thresholds.
- **It does not adopt positions it did not open.** A bot that finds an existing
  position on its symbol refuses to start. This prevents it mismanaging
  something it has no book for, but it does mean changing symbols while a
  position is open leaves that position unmanaged.
- **No backtest is included.** Parameters here come from live measurement over
  days, not from a historical simulation, and the sample is small.

---

## Layout

```
finalepicbot.js        the bot
ecosystem.config.js    pm2: nine symbols, shared flags
config.js              endpoints, precision, fees
lib/exchange.js        REST client - orders, positions, klines, signing
lib/feed.js            websocket price feed
lib/dashboard.js       dashboard data assembly
lib/logger.js          logging
lib/notify.js          telegram / webhook alerts
dashboard.js           local dashboard server (127.0.0.1 only)
analyse-mae.js         drawdown analysis over finalepic-mae.csv
ipwatch.js             IP whitelist watcher
```
