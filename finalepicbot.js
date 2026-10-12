'use strict';

/**
 * FINAL EPIC BOT — alternating record-move ladder, fixed INR profit target,
 * optional fixed INR stop loss.
 *
 * Strategy
 *   1. Opens a position at start (level 1). Which side: if --start-side was
 *      given, that side, immediately. Otherwise the bot warms up for one
 *      bucket window and reads the direction the same way it reads adds —
 *      price fell, go long; price rose, go short — rather than always
 *      defaulting to a blind long.
 *   2. While the trade is open it records the % change of every 60-second
 *      bucket. It adds another entry ONLY when the current rolling 60-second
 *      move AGAINST the position is bigger than any such move recorded so
 *      far this episode. Long episodes ladder into dips; short episodes
 *      ladder into rallies — the same rule, mirrored.
 *   3. Each add escalates size: 1x, 3x, 12x, 48x of the starting notional
 *      (10 -> 30 -> 120 -> 480 USDT for --usdt 10). Beyond level 4 it keeps
 *      multiplying by 4.
 *   4. The moment unrealised PnL reaches the target, the position closes via
 *      a resting reduce-only LIMIT order kept live on the EXCHANGE at all
 *      times (not just checked by the bot each tick) — a SELL above the
 *      average entry when long, a BUY below it when short. It is placed
 *      right after level 1 fills, and re-priced — cancelled and replaced —
 *      every time a new level adds, since a bigger position hits the same
 *      INR target at a different price. Keeping it resting rather than only
 *      polling in-process means the exit still works if the bot itself
 *      crashes or loses its connection; a purely reactive check would not.
 *   5. Every completed episode FLIPS the side. A long that just paid out did
 *      so because price rallied into the target, so the next episode shorts
 *      that strength instead of buying into it; a short that paid out did so
 *      on a fall, so the next one buys. --no-alternate keeps one side.
 *   6. Stop loss is OFF by default — the original spec — but --sl N caps the
 *      loss at N INR. When set, it works like the take-profit: a resting
 *      reduce-only STOP_MARKET, maintained through every add, so it
 *      survives the bot crashing too. It fires immediately once triggered
 *      (no separate limit leg to fail to fill) — the residual risk is
 *      slippage on that fill, not the order silently never executing, so
 *      the risk banner at boot still applies, just to a smaller extent.
 *      Downside is worse on the short side either way: a long's loss stops
 *      at zero, a short's does not stop anywhere.
 *
 * Usage:
 *   node finalepicbot.js --symbol BTCUSDT --usdt 10 --tp 30
 *   node finalepicbot.js --symbol BTCUSDT --usdt 10 --tp 30 --live
 *   node finalepicbot.js --autosymbols 6 --usdt 12 --tp 12 --live
 *
 * --autosymbols N picks the symbol instead of naming one: it ranks every
 * USDT contract by how far it moved over the last --autosymbols-window
 * hours (default 1), gainers AND losers, and claims the biggest mover that
 * is not already taken by another bot and whose spread is under 40% of the
 * take-profit target. One bot still trades one symbol — launch N bots with
 * the same flag and they fill N different slots.
 *   --autosymbols-window H    hours of movement to rank on   (default 1)
 *   --autosymbols-min-lev N   skip contracts below N leverage
 *   --autosymbols-ttl-min M   how long the shared scan is reused (default 15)
 *   node finalepicbot.js --symbol BTCUSDT --usdt 10 --tp 30 --sl 40 --max-hold-min 8 --live
 *
 * Two independent downside exits, usable together:
 *   --sl N            close if the loss reaches N INR (a resting STOP_MARKET).
 *                     Always fills; the price is whatever the market gives.
 *   --sl-stop-limit N close at EXACTLY -N INR (a resting STOP_LIMIT). Cannot
 *                     fill worse than that — and in a gap does not fill at
 *                     all, leaving the position open. Mutually exclusive
 *                     with --sl.
 *   --sl-trigger-buffer N  how far before the limit the trigger fires, in
 *                     INR (default 0.5). The limit sits at -N; the trigger
 *                     at -(N - buffer), so the limit is already marketable
 *                     when it fires instead of resting at the touch.
 *   --bail-floating N close EVERY position on the account and stop, when the
 *                     net of the OPEN positions is worse than -N INR.
 *                     Realised history is NOT counted, so banked profit cannot
 *                     buffer the stop. Contrast --bail-at, which measures
 *                     realised-since-the-baseline PLUS floating and is
 *                     therefore a session equity floor, not a drawdown cap.
 *                     The two are independent and may be armed together.
 *   --max-hold-min M  close M minutes after the episode's first entry fill,
 *                     whatever the PnL. Catches trades going nowhere, which a
 *                     price stop never sees.
 *   --only-red [U]    changes that from a deadline into a repeating
 *                     checkpoint: every M minutes, close ONLY if the position
 *                     is worse than -U USDT (default 0.05). Green positions
 *                     are left alone and re-checked M minutes later, so
 *                     winners keep running while losers are cut on schedule.
 *
 * Run it with no flags and it will prompt for symbol, starting USDT and the
 * take-profit target.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { io } = require('socket.io-client');
const ex = require('./lib/exchange');
const notify = require('./lib/notify');

/**
 * Fire-and-forget alert. A notification must NEVER delay or block an exit, so
 * this deliberately does not return a promise to await and swallows every
 * failure. Telegram being down is not a reason to hold a position open.
 */
function alert(text) {
  try {
    notify.send(`${SYMBOL || 'bot'}: ${text}`).catch(() => { /* never throws */ });
  } catch (e) { /* never throws */ }
}

// ─── CLI parsing ─────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { flags: new Set() };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { out.flags.add(key); }
    else { out[key] = next; i++; }
  }
  return out;
}

const args = parseArgs(process.argv);

function usage(msg) {
  if (msg) console.log(`\n\x1b[31m${msg}\x1b[0m`);
  console.log(`
Usage:
  node finalepicbot.js --symbol BTCUSDT --usdt 10 --tp 30 [--live]

Required (prompted for if omitted):
  --symbol S     contract to trade, e.g. BTCUSDT
  --usdt N       STARTING notional per buy in USDT (level 1)
  --tp N         take-profit target in INR — exits at this profit or better

Direction:
  --direction M    'flip' (default) or 'hourlybias':
                 'flip' — direction alternates after every closed episode
                 (see --start-side / --no-alternate below).
                 'hourlybias' — direction is read fresh from the PREVIOUS
                 completed hourly candle before every episode, including
                 the first: bearish candle -> short, bullish -> long.
                 Entry waits for a pullback/rally of at least --min-dip off
                 the best price seen since the read, same as an add would,
                 while price stays on the valid side of the candle's own
                 high/low. That high/low is the ENTRY invalidation only: it
                 decides whether to open, and does NOT place a stop. Use
                 --sl / --sl-stop-limit for a stop, in this mode as in any
                 other. --start-side / --no-alternate are ignored here,
                 since the candle decides direction every time.
  --start-side S   (--direction flip only) force 'long' or 'short' for the
                 very first episode. Without this, the bot warms up for one
                 --bucket-sec window and picks: price fell -> long, price
                 rose -> short (the same reversion read it uses for adds).
  --no-alternate   (--direction flip only) stay on the starting side
                   instead of flipping after every completed episode
  --reentry-better [N]  rest the next episode's entry at that side's LAST
                 entry price rather than at the current touch — a short rests
                 HIGHER, a long LOWER — optionally N% further out. The order
                 goes into the book immediately and waits there.
                 Without this, --no-alternate re-enters on the next tick: a
                 short takes profit because price fell, so the next short
                 opens lower, and the next lower still.

Sizing:
  --levels N     max entries per episode                     (default 4)
                 sizes are 1x, 3x, 12x, 48x of --usdt, then x4 per level
  --leverage N   leverage for the contract                   (default 10)

Entries (and ladder adds — same order, same rules):
  Rest PASSIVELY at the touch (buy at the bid, sell at the ask) instead of
  crossing the spread, so they fill as MAKER (lower fee) rather than taker,
  with no entry slippage — at the cost of not always filling immediately.
  --entry-buffer-pct N  push further onto the passive side of the touch,
                 in % — better expected price, slower to fill  (default 0)
  --entry-timeout-min N  minutes to leave an unfilled entry/add resting
                 before cancelling it and giving up on that level (default 15)

Add trigger (the "enter again" rule — mirrored per side: a long ladders
into dips, a short ladders into rallies):
  --bucket-sec N   length of each recorded window, seconds   (default 60)
  --min-buckets N  windows to observe before the first add   (default 3)
  --min-dip N      ignore adverse moves smaller than this %  (default 0.1)

Exit:
  --net          require the target NET of estimated fees    (default: gross,
                 matching the Active P&L figure Shark shows you)
  --exit-buffer N  push the exit limit N% past the touch     (default 0)
                 (below the bid when long, above the ask when short)
  --sl N         fixed INR loss at which to stop out. NO stop by default —
                 pass this to enable one. Sign doesn't matter (-150 and 150
                 both mean "stop at 150 INR of loss"). Resting as a
                 STOP_MARKET: fires immediately once triggered, trading
                 price certainty for the guarantee that it actually closes.
  --once         stop after the first take-profit            (default: keep cycling)
  --cooldown-min N  wait N minutes after a take-profit       (default 0)
  --max-episodes N  stop after N completed cycles, 0 = forever  (default 0)
  --max-loss N   stop once ACCOUNT equity is down N INR from startup
  --max-gain N   stop once ACCOUNT equity is up N INR from startup

                 Equity = wallet balance + floating PnL on EVERY open
                 position, not just this symbol and not just closed trades.
                 That matters twice over: a position sitting deeply
                 underwater counts immediately rather than only when it
                 finally closes, and when several bots share one account
                 they all measure the same account-wide figure.

                 Re-checked every 20s, so a cap CAN fire while a position is
                 still open and losing. On tripping, the bot PARKS: it stops
                 placing orders but leaves resting take-profits live (see the
                 FINALEPIC_PARK switch), so an open position keeps its exit.

                 Baseline is taken at startup, so restarting resets it. In a
                 dry run there is no account to read and these fall back to
                 this symbol's realised PnL only.

  --bail-at N    close EVERY position on the account and stop, once the
                 account-wide net is worse than -N INR. The mirror of
                 --bank-at. NOT the same as --max-loss, which only parks and
                 leaves open positions live with nothing managing them.
                 Writes FINALEPIC_BAIL, which every bot picks up within one
                 check; that file then blocks a restart until you delete it,
                 so a bail-out cannot be undone by accident.

  --bank-at N    take the money and keep going. Net profit = what the wallet
                 has actually gained since the baseline, MINUS the floating
                 loss still open. The moment that clears N INR, every position
                 is flattened with reduce-only limits, the wallet is re-noted
                 as the new baseline, and trading resumes.

                 This is the answer to a session that earns for an hour and
                 then gives it all back: alternation keeps flipping into a
                 symbol that has started trending, and the take-profit stops
                 being reached. Banking a modest net early sidesteps that.

                 Unlike --max-gain this does NOT stop the bot. Several bots on
                 one account all read the same account-wide net, so they trip
                 together and the whole book flattens at once.

  The take-profit lives as a resting reduce-only LIMIT order on the exchange
  itself (LIVE mode only) — a SELL when long, a BUY when short — re-priced
  after every level add. It keeps working even if this process dies; the
  in-process check is only a fallback for when no such order currently
  exists (e.g. placement failed, or one is mid-replace).

Other:
  --inr-rate N   USDT->INR rate for the PnL maths     (default: from exchangeInfo)
  --live         place REAL orders (default is a dry run)

There is NO stop loss in this bot, by design. Nothing closes a losing trade.
`);
  process.exit(msg ? 1 : 0);
}

if (args.flags.has('help') || args.flags.has('h')) usage();

// ─── Config (filled in after any interactive prompting) ──────────────────

let SYMBOL = String(args.symbol || '').toUpperCase().replace(/[-_]/g, '');
// --autosymbols N: instead of naming a symbol, pick one from the N biggest
// hourly movers (gainers AND losers — the ladder trades both sides).
//
// One bot still trades ONE symbol. Launch N bots with the same flag and each
// claims a different candidate, because the per-symbol lock refuses a second
// bot on a symbol already taken. So --autosymbols 6 across 6 bots fills all
// six slots; a 7th would find them all locked and say so.
const AUTOSYMBOLS = args.autosymbols !== undefined ? parseInt(args.autosymbols, 10) : null;
const AUTO_WINDOW_H = parseFloat(args['autosymbols-window'] ?? 1);
const AUTO_MIN_LEV = parseFloat(args['autosymbols-min-lev'] ?? 0);
// A scan is ~330 requests, so the result is shared between every bot that
// starts within the TTL rather than repeated once per bot.
const AUTO_CACHE = path.join(__dirname, 'autosymbols-cache.json');
const AUTO_CACHE_TTL_MS = parseFloat(args['autosymbols-ttl-min'] ?? 15) * 60000;
const AUTO_LOCK = path.join(__dirname, 'autosymbols.lock');
let NOTIONAL = args.usdt !== undefined ? parseFloat(args.usdt) : NaN;
let TP_INR = args.tp !== undefined ? parseFloat(args.tp) : NaN;

const START_SIDE_EXPLICIT = args['start-side'] !== undefined;
const START_SIDE = String(args['start-side'] ?? 'long').toUpperCase();
// 'flip' (default): existing behaviour — direction alternates after every
// closed episode. 'hourlybias': direction is read fresh from the previous
// hourly candle's colour before EVERY episode (including the first),
// overriding --start-side/the warm-up and --no-alternate, and the stop
// becomes the candle's own high/low instead of --sl.
const DIRECTION_MODE = String(args.direction ?? 'flip').toLowerCase();
const ALTERNATE = !args.flags.has('no-alternate');
const MAX_LEVELS = parseInt(args.levels ?? 4, 10);
const LEVERAGE = parseInt(args.leverage ?? 10, 10);
const BUCKET_SEC = parseFloat(args['bucket-sec'] ?? 60);
const MIN_BUCKETS = parseInt(args['min-buckets'] ?? 10, 10);
const MIN_DIP_PCT = parseFloat(args['min-dip'] ?? 0.3);
const NET_TARGET = args.flags.has('net');
const EXIT_BUFFER_PCT = parseFloat(args['exit-buffer'] ?? 0);
// Fixed INR loss threshold. Sign doesn't matter — either -150 or 150 means
// "stop once unrealised loss reaches 150 INR." null = no stop (the original
// default). Mirrors --tp, matching ladder-buy-bot's --total-stop convention.
const SL_INR = args.sl !== undefined ? Math.abs(parseFloat(args.sl)) : null;
// --sl-stop-limit N caps the loss at EXACTLY N INR instead of accepting
// whatever a market order gets. The limit price sits at exactly -N INR; the
// TRIGGER fires --sl-trigger-buffer INR earlier, so when it fires the limit
// is already marketable and normally fills at or better than -N.
//
// The tradeoff is explicit: in a gap the limit rests unfilled and the
// position stays open. A STOP_MARKET always closes but at any price; this
// always closes at a known price or not at all.
const SL_LIMIT_INR = args['sl-stop-limit'] !== undefined
  ? Math.abs(parseFloat(args['sl-stop-limit'])) : null;
const SL_TRIGGER_BUFFER_INR = args['sl-trigger-buffer'] !== undefined
  ? Math.abs(parseFloat(args['sl-trigger-buffer'])) : 0.5;
// Close a position that has been open too long regardless of its PnL.
// The MAE study showed winners that turn quickly barely go underwater
// (14-95s), while the deep drawdowns were all long-running trades
// (328-427s). Time is a second, independent way to cut those loose —
// it fires on trades that are going nowhere, which a price stop cannot see.
const MAX_HOLD_MIN = args['max-hold-min'] !== undefined
  ? Math.abs(parseFloat(args['max-hold-min'])) : null;
// --reentry-better: the next episode may only open at a price at least as
// good as the last entry on the SAME side, optionally by a margin.
//
// Without it, --no-alternate re-enters immediately at whatever the market is
// doing. A short takes profit BECAUSE price fell, so the next short opens
// lower, and the one after lower still — selling into a range all the way
// down. Requiring a better price makes re-entry wait for a bounce, which is
// what "sell into strength" actually means.
//
// It is applied to the ORDER PRICE, not as a wait: the entry limit is placed
// straight into the book at that level instead of at the touch. The order
// holds queue priority and fills on a brief spike that a wait-then-place
// approach would miss.
//
//   --reentry-better        rest at the last entry price
//   --reentry-better 0.5    rest 0.5% better than the last entry
const REENTRY_BETTER = args.flags.has('reentry-better') || args['reentry-better'] !== undefined;
const REENTRY_EDGE_PCT = args['reentry-better'] !== undefined
  ? Math.abs(parseFloat(args['reentry-better'])) : 0;
// --only-red turns the time stop from "close everything" into "cut the
// losers, give the winners another interval". A position still showing a
// profit (or a loss smaller than the threshold) has its clock extended by
// another --max-hold-min instead of being closed.
//
// Accepts a bare flag (uses the default) or a threshold in USDT:
//   --only-red          close only positions worse than -0.05 USDT
//   --only-red 0.10     ... worse than -0.10 USDT
const ONLY_RED = args.flags.has('only-red') || args['only-red'] !== undefined;
const ONLY_RED_USDT = args['only-red'] !== undefined
  ? Math.abs(parseFloat(args['only-red'])) : 0.05;
const ONCE = args.flags.has('once');
const COOLDOWN_MIN = parseFloat(args['cooldown-min'] ?? 0);
const MAX_EPISODES = parseInt(args['max-episodes'] ?? 0, 10);
// --bail-at N: close EVERY position on the account and stop, once the
// account-wide net is worse than -N INR. The mirror of --bank-at.
//
// Not the same as --max-loss, which only PARKS: parking stops new orders but
// leaves open positions live with nothing managing them. --bail-at actually
// gets you flat.
const BAIL_AT_INR = args['bail-at'] !== undefined ? Math.abs(parseFloat(args['bail-at'])) : null;

// --bail-floating N: the same "close everything and stop", but measured on the
// OPEN positions alone.
//
// --bail-at counts realised-since-the-baseline PLUS floating, which means
// banked profit buffers the stop: sitting on +172 INR realised, a -200 bail
// does not fire until the open book is 372 INR underwater. That is a session
// equity floor, not a drawdown cap, and it is not what you want if the job is
// to limit the damage one bad episode can do.
//
// This one ignores history entirely. Floating worse than -N INR, everything
// closes. The two are independent and can be armed together: a drawdown cap
// and a session floor.
const BAIL_FLOATING_INR = args['bail-floating'] !== undefined
  ? Math.abs(parseFloat(args['bail-floating'])) : null;
// Session-scoped circuit breakers on REALISED PnL (sum of closed episodes,
// this process's lifetime only — not persisted across restarts). null =
// no cap. Sign doesn't matter for --max-loss, same convention as --sl.
const MAX_LOSS_INR = args['max-loss'] !== undefined ? Math.abs(parseFloat(args['max-loss'])) : null;
const MAX_GAIN_INR = args['max-gain'] !== undefined ? Math.abs(parseFloat(args['max-gain'])) : null;
// BANK-AND-RESTART. Net profit = (wallet now - wallet at the baseline) plus
// the floating PnL on every open position — i.e. what is actually banked
// minus what is still underwater. The moment that clears this many INR, the
// bot flattens, re-notes the wallet as the new baseline, and carries on.
// The point is to take a modest net BEFORE the alternation flips into a
// trending symbol and gives it all back, which is how the losing stretches
// start. Unlike --max-gain this does NOT stop the bot.
const BANK_AT_INR = args['bank-at'] !== undefined
  ? Math.abs(parseFloat(args['bank-at'])) : null;
const DRY_RUN = !args.flags.has('live');
let INR_RATE = parseFloat(args['inr-rate'] ?? 88);

const BUCKET_MS = BUCKET_SEC * 1000;
// Entries (and adds) sit PASSIVELY at the touch instead of crossing the
// spread: a BUY rests at the bid, a SELL at the ask. At 0 (the default) that
// joins the touch exactly — never marketable at placement, so it fills as
// MAKER (the cheaper fee tier) rather than paying taker to guarantee an
// instant fill. A positive value pushes it further onto the passive side
// (better expected price, slower/less likely to fill).
const ENTRY_BUFFER_PCT = parseFloat(args['entry-buffer-pct'] ?? 0) / 100;
// How long a passive entry/add is left resting before giving up on it.
// Deliberately much longer than the old fixed ~24s now that fills aren't
// guaranteed to be near-instant — the tradeoff the user is choosing.
const ENTRY_TIMEOUT_MIN = parseFloat(args['entry-timeout-min'] ?? 15);
const ENTRY_POLL_MS = 3000;   // unchanged from before — only the total wait got longer
const ENTRY_TIMEOUT_ITERS = Math.max(1, Math.ceil((ENTRY_TIMEOUT_MIN * 60000) / ENTRY_POLL_MS));
const WS_PUBLIC = 'https://fawss.sharkexchange.in/';
// Two kill switches, both honoured:
//   FINALEPIC_STOP           — shared; stops EVERY finalepicbot instance
//   FINALEPIC_STOP_<SYMBOL>  — stops just this one
// The per-symbol file is resolved lazily because SYMBOL can still be set by
// the interactive prompt after this point.
const KILL_FILE = path.join(__dirname, 'FINALEPIC_STOP');
const symbolKillFile = () => path.join(__dirname, `FINALEPIC_STOP_${SYMBOL}`);
// PARK switches stop the bot WITHOUT cancelling anything already resting on
// the exchange. Use when a position's take-profit / stop should stay live
// and keep working after the bot itself is gone. STOP cancels; PARK does not.
// ONE BOT PER SYMBOL. Two bots on the same symbol do not merely duplicate
// work — they corrupt each other: each reads the COMBINED exchange position
// and tries to close all of it, so exits compound (231 -> 462 -> 924 ->
// 2772 units against a real 462) and the excess flips into a fresh position
// in the opposite direction. That cost 469 INR in one session.
// Resolved lazily because SYMBOL can still be set by the interactive prompt.
const symbolLockFile = () => path.join(__dirname, `FINALEPIC_LOCK_${SYMBOL}`);
const PARK_FILE = path.join(__dirname, 'FINALEPIC_PARK');
// Written by whichever bot first sees the account past --bail-at. Every bot
// picks it up on its next cap check and closes its own position.
const BAIL_FILE = path.join(__dirname, 'FINALEPIC_BAIL');
const symbolParkFile = () => path.join(__dirname, `FINALEPIC_PARK_${SYMBOL}`);
const EVENT_LOG = path.join(__dirname, 'finalepic-events.log');
const TRADE_LOG = path.join(__dirname, 'finalepic-trades.csv');
// Separate from the trade log on purpose: one row per CLOSED episode, written
// only once, so it can be analysed without untangling entries from exits.
const MAE_LOG = path.join(__dirname, 'finalepic-mae.csv');
// One status file per symbol, refreshed every few seconds. The dashboard
// reads these rather than scraping the shared event log — heartbeat lines
// carry no symbol, so the log alone cannot tell nine bots apart.
const statusFile = () => path.join(__dirname, `finalepic-status-${SYMBOL}.json`);
const MAE_HEADER =
  'ts,symbol,episode,direction,levels,qty,avg_entry,exit_price,notional_inr,' +
  'mae_pct,mae_inr,mfe_pct,mfe_inr,pnl_inr,outcome,exit_reason,held_sec\n';

const TRADE_HEADER =
  'ts,symbol,episode,direction,level,side,qty,price,notional_usdt,dip_pct,record_dip_pct,pnl_inr,client_order_id,note,dry_run\n';

if (!fs.existsSync(TRADE_LOG)) {
  fs.writeFileSync(TRADE_LOG, TRADE_HEADER);
} else {
  // The 'direction' column was added when the bot learned to alternate
  // sides. Appending new-shaped rows under the old header would silently
  // misalign every column after 'episode', so retire the old file instead
  // of corrupting it.
  const existing = fs.readFileSync(TRADE_LOG, 'utf8').split('\n')[0] + '\n';
  if (existing !== TRADE_HEADER) {
    const archive = TRADE_LOG.replace(/\.csv$/, `-${Date.now()}.pre-alternating.csv`);
    fs.renameSync(TRADE_LOG, archive);
    fs.writeFileSync(TRADE_LOG, TRADE_HEADER);
    console.log(`[trade log] schema changed — previous rows archived to ${path.basename(archive)}`);
  }
}

// ─── Logging ─────────────────────────────────────────────────────────────

const C = { info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m', trade: '\x1b[35m', ok: '\x1b[32m', dim: '\x1b[90m' };
const R = '\x1b[0m';
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
function log(level, msg) {
  const line = `[${stamp()}] ${level.toUpperCase().padEnd(5)} ${msg}`;
  console.log(`${C[level] || ''}${line}${R}`);
  try { fs.appendFileSync(EVENT_LOG, line + '\n'); } catch (e) { /* disk full etc. — keep trading */ }
}
const info = m => log('info', m), warn = m => log('warn', m), error = m => log('error', m);
const trade = m => log('trade', m), ok = m => log('ok', m), dim = m => log('dim', m);
const fmt = (n, d = 6) => Number(n).toFixed(d);
const signed = n => `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;

// ─── State ───────────────────────────────────────────────────────────────

const openLongs = [];          // {level, qty, fillPrice, notional, clientOrderId, ts}
let episode = 1;
let direction = START_SIDE === 'SHORT' ? 'SHORT' : 'LONG';
// Only used for the bot's very first-ever entry, and only when --start-side
// wasn't explicitly given: warm up for one bucket and read direction the
// same way adds already do — price fell, go long; price rose, go short.
let warmupDone = START_SIDE_EXPLICIT;
let warmupAnchorPrice = null;
let warmupStartTs = null;

// --direction hourlybias state. Refreshed at the start of every episode
// (including the first) and cleared again once that episode closes.
let hourlyBiasFetching = false;
let hourlyBiasNextTry = 0;
let hourlyInvalidation = null;   // the price that invalidates the bias — prior high (short) / prior low (long)
let hourlyBestPrice = null;      // best price seen since the bias was read, for the entry-timing gate
let level = 0;                 // levels filled this episode
let lastPrice = null;
let firstEntryTs = null;
// Worst and best prices seen while this episode held a position. Together
// with the average entry these give MAE (maximum adverse excursion) and MFE
// — how far underwater a trade went before it resolved, and how far ahead.
// MAE is the empirical basis for choosing a stop: a stop must sit beyond the
// drawdown that winners routinely survive, or it converts them into losses.
// The next moment the time stop evaluates this position. Under --only-red a
// spared position gets this pushed out by another interval, so the clock
// becomes a repeating checkpoint rather than a one-shot deadline.
let nextHoldCheckTs = null;
let holdChecksSurvived = 0;
const BOT_STARTED_AT = Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Entry price of the last episode opened on each side. Kept per side because
// comparing a long's entry against a previous short's says nothing useful.
const lastEntryBySide = { LONG: null, SHORT: null };
let episodeWorstPrice = null;
let episodeBestPrice = null;
// When this episode's first entry filled. Unlike firstEntryTs it survives
// finishEpisode(), because the realised-PnL lookup runs while the episode is
// being torn down and needs to know how far back to look.
let episodeStartTs = null;
// positionIds already booked, so two exit paths reporting the same close
// cannot count it twice.
const countedPositions = new Set();
let placing = false;
let exiting = false;
let exitDisabled = false;
let exitRetryAfter = 0;
let exitFailures = 0;
let halted = false;
let preferenceSet = false;
let cooldownUntil = 0;
let consecutiveFailures = 0;
let closedEpisodes = 0;
let sessionRealisedInr = 0;
// Account-wide equity baseline for --max-gain / --max-loss, captured once at
// boot. Equity = wallet balance + floating PnL across EVERY open position,
// not just this bot's symbol. Realised PnL alone is misleading two ways: it
// ignores an open position sitting deeply underwater, and with several bots
// running each one only ever sees its own symbol.
let lastCapCheck = 0;
let bankedRounds = 0;
let flattening = false;
// Live prices for EVERY symbol, straight off the shared websocket feed.
const feedPrices = new Map();
//
// ─── Running several symbols at once ─────────────────────────────────────
//
// Every instance on the same account reads the same wallet and the same
// open positions, so they share two files in this directory:
//
//   account-snapshot.json  wallet + open positions, refreshed at most once
//                          every 15s by whichever bot asks first. Disposable
//                          — delete it any time; it is rebuilt on demand.
//   bank-baseline.json     the equity mark that --bank-at / --max-gain /
//                          --max-loss measure against, plus the round
//                          number. A bot starting up joins a baseline less
//                          than 12h old rather than setting its own, so all
//                          of them measure the same net and bank together.
//                          DELETE IT to start a fresh session.
//
// Before this, each bot fetched the wallet, the position list, and one price
// per other open position, every 20s. Thirteen bots came to ~600 requests a
// minute against a 60/min ceiling. Now the continuous cost is ~5/min in
// total and does not grow with the number of bots.

// Several bots share one account, so they also share one snapshot of it and
// one baseline — otherwise each re-derives the same figures over the API and
// they drift apart after the first bank.
const ACCOUNT_SNAPSHOT = path.join(__dirname, 'account-snapshot.json');
const SNAPSHOT_LOCK = path.join(__dirname, 'account-snapshot.lock');
const BANK_BASELINE = path.join(__dirname, 'bank-baseline.json');
// One file per round, created exclusively. Whoever creates it owns that
// round; everyone else follows it.
const bankClaimFile = (round) => path.join(__dirname, `bank-round-${round}.claim`);
const SNAPSHOT_TTL_MS = 15000;     // refresh once this old
const SNAPSHOT_MAX_AGE_MS = 60000; // past this, treat the account as unknown
const LOCK_STALE_MS = 20000;       // a lock older than this belonged to a dead bot
const BANK_SETTLE_MS = 8000;       // let the other bots' exits land before re-baselining
let lastStatusLog = 0;
let lastAddTs = 0;
let socket = null;

// The resting reduce-only take-profit order, or null when none is live.
// LIVE mode only — DRY_RUN never places real orders and keeps using the
// purely reactive check in onPrice().
let restingTp = null;   // {clientOrderId, qty, price, side, ts}

// Same idea for the stop loss — null when SL_INR is unset (no stop
// requested) or when none is currently resting.
let restingSl = null;   // {clientOrderId, qty, stopPrice, side, ts}

// Dip tracking
const priceHistory = [];       // {t, p} — trimmed to a bit over one bucket
const dipRecords = [];         // {t, dipPct, source} — the aligned 60s windows
let bucketStartPrice = null;
let rollingDipMax = 0;         // deepest rolling window seen this episode

// Exchange truth, refreshed periodically
let exchangePos = null;        // {qty, entryPrice, ts}
let lastReconcile = 0;
let reconcileSuppressedUntil = 0;

// ─── Direction ───────────────────────────────────────────────────────────

const isLong = () => direction === 'LONG';
/** The side that OPENS and adds to the current episode's position. */
const entrySide = () => (isLong() ? 'BUY' : 'SELL');
/** The side that CLOSES it — always reduce-only. */
const exitSide = () => (isLong() ? 'SELL' : 'BUY');
/** What an adverse move is called on this side, for logs. */
const moveWord = () => (isLong() ? 'dip' : 'rally');

/** Round away from the market so a closing limit stays marketable. */
function ceilTo(v, p) { const f = Math.pow(10, p); return Math.ceil(v * f) / f; }

// ─── Sizing ──────────────────────────────────────────────────────────────

/**
 * 1x, 3x, 12x, 48x — the 10 / 30 / 120 / 480 pattern from the spec.
 * Past level 4 the ratio settles at x4 per level, matching 120 -> 480.
 */
const SIZE_SEQUENCE = [1, 3, 12, 48];
function levelMultiplier(n) {
  if (n <= SIZE_SEQUENCE.length) return SIZE_SEQUENCE[n - 1];
  return SIZE_SEQUENCE[SIZE_SEQUENCE.length - 1] * Math.pow(4, n - SIZE_SEQUENCE.length);
}
function levelNotional(n) { return NOTIONAL * levelMultiplier(n); }

/**
 * The largest notional this bot is ever allowed to hold, in USDT.
 *
 * With --levels 1 that is exactly --usdt; with a ladder it is the full
 * planned stack. Nothing may exceed it. This is a hard ceiling checked
 * against what the EXCHANGE holds, not against the bot's own book, because
 * the book is exactly what goes wrong: a position can grow from a fill the
 * bot did not record, a duplicate bot, or an exit that overshot and flipped.
 * A 12 USDT setting produced a 396 USDT position that way.
 */
function maxPositionNotional() {
  let cum = 0;
  for (let n = 1; n <= MAX_LEVELS; n++) cum += levelNotional(n);
  return cum;
}

/**
 * Refuses an entry that would push the real position past the ceiling.
 * Returns null when it is safe to proceed, or a reason to abort.
 */
async function positionCapBreach(addNotionalUsdt) {
  if (DRY_RUN) return null;
  const held = await ex.positionSize(SYMBOL).catch(() => null);
  if (held === null) return null;                 // unknown: other guards apply
  const px = lastPrice || (book().avgEntry) || 0;
  if (!(px > 0)) return null;
  const heldNotional = held * px;
  const cap = maxPositionNotional();
  if (heldNotional + addNotionalUsdt > cap * 1.05) {   // 5% for price drift
    return `${SYMBOL} already holds ${heldNotional.toFixed(2)} USDT; adding ` +
           `${addNotionalUsdt.toFixed(2)} would exceed the ${cap.toFixed(2)} USDT ceiling`;
  }
  return null;
}

function ladderPlan() {
  const rows = [];
  let cum = 0;
  for (let n = 1; n <= MAX_LEVELS; n++) {
    const notional = levelNotional(n);
    cum += notional;
    rows.push({ level: n, mult: levelMultiplier(n), notional, cumNotional: cum, margin: cum / LEVERAGE });
  }
  return rows;
}

// ─── Position maths ──────────────────────────────────────────────────────

function aggregate() {
  const totalQty = openLongs.reduce((s, p) => s + p.qty, 0);
  if (totalQty === 0) return { totalQty: 0, avgEntry: 0, totalNotional: 0 };
  const totalNotional = openLongs.reduce((s, p) => s + p.notional, 0);
  const avgEntry = openLongs.reduce((s, p) => s + p.fillPrice * p.qty, 0) / totalQty;
  return { totalQty, avgEntry, totalNotional };
}

/**
 * Quantity and average entry, preferring what the exchange actually holds.
 * The in-memory book assumes every marketable limit filled at its limit
 * price; the exchange knows the real average. On a bot whose only exit is a
 * profit target, being wrong about the entry means exiting at the wrong PnL.
 */
function book() {
  const mem = aggregate();
  if (exchangePos && Date.now() - exchangePos.ts < 60000 &&
      exchangePos.qty > 0 && exchangePos.entryPrice > 0) {
    // Only trust the exchange figures if they describe the side this episode
    // is actually trading. A mismatch means the account holds something this
    // bot did not open, and using its entry price would invert every PnL
    // sign — closing at a loss while reporting a profit.
    if (exchangePos.side && exchangePos.side !== direction) {
      warn(`exchange reports a ${exchangePos.side} on ${SYMBOL} but this episode is ${direction} — ` +
           `ignoring its figures and using the bot's own book`);
    } else {
      return {
        totalQty: exchangePos.qty, avgEntry: exchangePos.entryPrice,
        totalNotional: mem.totalNotional, source: 'exchange',
      };
    }
  }
  return { ...mem, source: 'memory' };
}

/** Gross PnL in INR at a given price, signed for the current direction. */
function pnlInrAt(price) {
  const { totalQty, avgEntry } = book();
  if (totalQty === 0) return 0;
  const move = isLong() ? (price - avgEntry) : (avgEntry - price);
  return move * totalQty * INR_RATE;
}

/**
 * Taker fee as a FRACTION.
 *
 * exchangeInfo reports fees as percentages — BTCUSDT comes back as 0.06,
 * meaning 0.06%, not 6%. Anything at or above 0.01 is therefore a percentage
 * and gets divided by 100; a genuine fraction (0.0006) is already small
 * enough to pass through untouched.
 */
function takerFeeRate() {
  const c = ex.contract(SYMBOL);
  const raw = c ? c.takerFee : 0.0006;
  return raw >= 0.01 ? raw / 100 : raw;
}

/** Estimated round-trip taker fees on the open notional, in INR. */
function feeInr() {
  const { totalQty, avgEntry } = book();
  return totalQty * avgEntry * takerFeeRate() * 2 * INR_RATE;
}

/** The PnL the exit rule must beat: the target, plus fees when --net. */
function exitThresholdInr() {
  return NET_TARGET ? TP_INR + feeInr() : TP_INR;
}

/**
 * Price at which the current book hits the exit threshold — above the
 * average entry for a long, below it for a short.
 */
function targetPrice() {
  const { totalQty, avgEntry } = book();
  if (totalQty === 0) return null;
  const distance = exitThresholdInr() / (totalQty * INR_RATE);
  return isLong() ? avgEntry + distance : avgEntry - distance;
}

/**
 * Price at which the current book hits the stop-loss threshold — below the
 * average entry for a long, above it for a short. null when no stop is
 * configured or there's nothing open to compute one for.
 */
/** Price at which the position has lost exactly `inr`, or null. */
function priceAtLossInr(inr) {
  const { totalQty, avgEntry } = book();
  if (totalQty === 0 || !(avgEntry > 0)) return null;
  const distance = inr / (totalQty * INR_RATE);
  return isLong() ? avgEntry - distance : avgEntry + distance;
}

function stopTriggerPrice() {
  const { totalQty } = book();
  if (totalQty === 0) return null;
  // hourlybias used to force the stop to the candle's invalidation level.
  // It no longer does: the stop is opt-in through --sl / --sl-stop-limit in
  // every mode. The candle level is still the ENTRY invalidation — price
  // crossing it makes the bot re-read the hour rather than open — but that
  // is a decision about whether to enter, not a resting stop order.

  // Under --sl-stop-limit the trigger sits BUFFER inr nearer than the limit,
  // so the limit is marketable the moment it fires rather than sitting at
  // the exact touch and waiting for someone to cross to it.
  if (SL_LIMIT_INR !== null) {
    const triggerAt = Math.max(0, SL_LIMIT_INR - SL_TRIGGER_BUFFER_INR);
    return priceAtLossInr(triggerAt);
  }
  if (SL_INR === null) return null;
  return priceAtLossInr(SL_INR);
}

/** The limit price for --sl-stop-limit: exactly -N INR. Null otherwise. */
function stopLimitPrice() {
  if (SL_LIMIT_INR === null) return null;
  return priceAtLossInr(SL_LIMIT_INR);
}

/** True if a stop-loss is configured at all, under either mode. */
function slEnabled() {
  return SL_INR !== null || SL_LIMIT_INR !== null;
}

/**
 * Reads the previous completed hourly candle and sets direction + the
 * invalidation price for the upcoming episode: bearish candle -> SHORT,
 * stop above its high; bullish candle -> LONG, stop below its low. A flat
 * candle (open === close) keeps whatever direction is already set.
 */
async function refreshHourlyBias() {
  try {
    const candle = await ex.previousHourlyCandle(SYMBOL);
    if (!candle) {
      warn('hourlybias: previous hourly candle unavailable — will retry');
      return;
    }
    if (candle.close > candle.open) {
      direction = 'LONG';
      hourlyInvalidation = candle.low;
    } else if (candle.close < candle.open) {
      direction = 'SHORT';
      hourlyInvalidation = candle.high;
    } else if (hourlyInvalidation === null) {
      // Flat candle with no prior value to fall back on (the very first
      // fetch) — still has to leave a valid, non-null state, or the caller
      // would treat this as "never fetched" and retry forever. Falls back
      // to the existing LONG default with the candle's own low as the level.
      hourlyInvalidation = candle.low;
    }
    hourlyBestPrice = null;
    info(`hourlybias: previous hour was ${candle.close > candle.open ? 'bullish' : candle.close < candle.open ? 'bearish' : 'flat'} ` +
         `(O ${fmt(candle.open)} H ${fmt(candle.high)} L ${fmt(candle.low)} C ${fmt(candle.close)}) → ` +
         `${direction}, invalidated at ${fmt(hourlyInvalidation)}`);
  } catch (e) {
    warn(`hourlybias: could not fetch the previous hourly candle (${e.message}) — will retry`);
  }
}

// ─── Dip tracking ────────────────────────────────────────────────────────

/**
 * The deepest aligned window recorded this episode. A rise contributes
 * nothing, so a run of green windows never raises the bar for the next add.
 */
function recordDipPct() {
  let max = 0;
  for (const r of dipRecords) if (r.dipPct > max) max = r.dipPct;
  return max;
}

/**
 * The bar the current dip has to clear.
 *
 * The aligned windows alone are not enough. A decline that straddles two
 * window boundaries is split between them, so each records less than the
 * fall actually was — and the live reading, which is a ROLLING window, would
 * clear that understated bar on a dip no deeper than one already seen. The
 * running maximum of the rolling reading keeps the comparison like-for-like,
 * so "deeper than anything recorded" means what it says.
 */
function dipBarPct() {
  return Math.max(recordDipPct(), rollingDipMax);
}

/**
 * The ADVERSE move over the trailing bucket window, as a positive %:
 * a fall when long, a rise when short. Negative means the window moved in
 * the position's favour.
 *
 * Returns null until a full window of prices has been observed — comparing
 * a partial window against completed ones would trigger on nothing.
 */
function currentDipPct() {
  if (lastPrice === null || priceHistory.length < 2) return null;
  const cutoff = Date.now() - BUCKET_MS;
  if (priceHistory[0].t > cutoff) return null;         // window not full yet
  let ref = null;
  for (const s of priceHistory) { if (s.t >= cutoff) { ref = s; break; } }
  if (!ref || !(ref.p > 0)) return null;
  return isLong()
    ? ((ref.p - lastPrice) / ref.p) * 100
    : ((lastPrice - ref.p) / ref.p) * 100;
}

/**
 * Closes off a bucket every BUCKET_SEC and files its % change. Only runs
 * while a trade is open — the spec measures dips during the trade, and a
 * flat pre-entry market would otherwise seed the history with noise.
 */
function closeBucket() {
  if (lastPrice === null) return;
  if (openLongs.length === 0) { bucketStartPrice = lastPrice; return; }
  if (bucketStartPrice === null || !(bucketStartPrice > 0)) { bucketStartPrice = lastPrice; return; }

  const changePct = ((lastPrice - bucketStartPrice) / bucketStartPrice) * 100;
  // Only the adverse half of the move counts: a fall when long, a rise when
  // short. A window that went our way contributes nothing, so it never
  // raises the bar for the next add.
  const dipPct = Math.max(0, isLong() ? -changePct : changePct);
  dipRecords.push({ t: Date.now(), dipPct, source: 'bucket' });
  dim(`bucket closed: ${signed(changePct)}% over ${BUCKET_SEC}s · ` +
      `${dipRecords.length} recorded · ${moveWord()} bar for the next add ${dipBarPct().toFixed(3)}%`);
  bucketStartPrice = lastPrice;
}

function resetDipState() {
  dipRecords.length = 0;
  rollingDipMax = 0;
  bucketStartPrice = lastPrice;
  lastAddTs = 0;
}

// ─── Kill switch ─────────────────────────────────────────────────────────

function killSwitchActive() { return fs.existsSync(KILL_FILE) || fs.existsSync(symbolKillFile()); }
function parkSwitchActive() { return fs.existsSync(PARK_FILE) || fs.existsSync(symbolParkFile()); }
function parkSwitchName() {
  return fs.existsSync(symbolParkFile()) ? `FINALEPIC_PARK_${SYMBOL}` : 'FINALEPIC_PARK';
}
/** Which kill file tripped, for the log line. */
function killSwitchName() {
  return fs.existsSync(symbolKillFile()) ? `FINALEPIC_STOP_${SYMBOL}` : 'FINALEPIC_STOP';
}

// ─── Core tick handler ───────────────────────────────────────────────────

function onPrice(price) {
  if (halted) return;
  if (parkSwitchActive()) {
    halt(`park switch file detected (${parkSwitchName()})`, { keepOrders: true }).catch(() => {});
    return;
  }
  if (killSwitchActive()) { halt(`kill switch file detected (${killSwitchName()})`).catch(() => {}); return; }

  lastPrice = price;
  const now = Date.now();

  // Extremes while a position is on. Tick-level, so unlike a candle
  // reconstruction this catches wicks that never close.
  if (openLongs.length > 0) {
    if (episodeWorstPrice === null || episodeBestPrice === null) {
      episodeWorstPrice = price; episodeBestPrice = price;
    } else if (isLong()) {
      if (price < episodeWorstPrice) episodeWorstPrice = price;
      if (price > episodeBestPrice) episodeBestPrice = price;
    } else {
      if (price > episodeWorstPrice) episodeWorstPrice = price;
      if (price < episodeBestPrice) episodeBestPrice = price;
    }
  }

  priceHistory.push({ t: now, p: price });
  const keepFrom = now - (BUCKET_MS + 15000);
  while (priceHistory.length && priceHistory[0].t < keepFrom) priceHistory.shift();

  // Track the dip FIRST, before any guard can return early. Placing an order
  // takes seconds to confirm, and if tracking paused for that window the
  // deepest part of the very dip that triggered the add would go unrecorded —
  // leaving the bar too low, so the next add fires on a shallower fall than
  // one already seen. The bar is read before the maximum absorbs this tick,
  // otherwise the current dip would be compared against itself and never win.
  const dip = currentDipPct();
  const bar = dipBarPct();
  if (openLongs.length > 0 && dip !== null && dip > rollingDipMax) rollingDipMax = dip;

  reconcile().catch(e => error(`reconcile: ${e.message}`));

  status(price);

  // 1. Take profit always wins — check it before adding more size.
  //
  // In LIVE mode the resting reduce-only order on the exchange is the real
  // exit — it survives the bot crashing, which this reactive check cannot.
  // This only fires as a fallback when no resting order currently exists
  // (placement failed, or a replace is mid-flight), so the position is
  // never left with zero coverage just because that one order didn't land.
  // DRY_RUN never has a resting order, so this check IS the exit mechanism.
  //
  // Also gated on !placing: openLevel's own tp_fired handling (the resting
  // TP firing while a level-add was mid-flight) nulls restingTp and then
  // awaits realisedPnlInr() — which can take up to ~16s — before it clears
  // openLongs. Without this, a tick landing in that window would see a
  // null restingTp and stale non-empty openLongs and fire a second,
  // redundant close racing openLevel's own.
  if (openLongs.length > 0 && !placing && (DRY_RUN || restingTp === null)) {
    const pnl = pnlInrAt(price);
    if (pnl >= exitThresholdInr() && !exiting && !exitDisabled && now >= exitRetryAfter) {
      takeProfit(price).catch(e => error(`take-profit failed: ${e.message}`));
      return;
    }
  }

  // 1a. Stop loss — same fallback logic, mirrored. Only configured if --sl
  // was passed; a resting STOP_MARKET is the real
  // mechanism in LIVE mode, this only fires when none currently exists.
  // Checked against PRICE (via stopTriggerPrice(), which already abstracts
  // over INR-distance vs the hourly invalidation level) rather than PnL
  // directly, so the same check works under both modes.
  if (slEnabled() && openLongs.length > 0 && !placing && (DRY_RUN || restingSl === null)) {
    const trigger = stopTriggerPrice();
    const hit = trigger !== null && (isLong() ? price <= trigger : price >= trigger);
    if (hit && !exiting && !exitDisabled && now >= exitRetryAfter) {
      stopLoss(price).catch(e => error(`stop-loss failed: ${e.message}`));
      return;
    }
  }

  // 1b. Time stop — independent of price and of --sl, so both can be armed
  // at once. Measured from the FIRST entry fill of the episode, not from the
  // last add, so laddering cannot keep extending the clock indefinitely.
  if (MAX_HOLD_MIN !== null && openLongs.length > 0 && !placing &&
      nextHoldCheckTs !== null && !exiting && !exitDisabled && now >= exitRetryAfter) {
    if (now >= nextHoldCheckTs) {
      const pnlUsdt = pnlInrAt(price) / INR_RATE;

      // Under --only-red a position that is green, or only slightly red,
      // is spared and re-checked one interval later. Losers still go.
      if (ONLY_RED && pnlUsdt > -ONLY_RED_USDT) {
        holdChecksSurvived++;
        nextHoldCheckTs = now + MAX_HOLD_MIN * 60000;
        const held = ((now - firstEntryTs) / 60000).toFixed(1);
        ok(`holding ${SYMBOL} — ${signed(pnlInrAt(price))} INR after ${held} min ` +
           `(not worse than -${ONLY_RED_USDT} USDT) · next check in ${MAX_HOLD_MIN} min ` +
           `· extension ${holdChecksSurvived}`);
        return;
      }

      timeExit(price).catch(e => error(`time exit failed: ${e.message}`));
      return;
    }
  }

  if (placing || exiting) return;
  if (now < cooldownUntil) return;

  // 2. First entry of an episode — open immediately, EXCEPT for the bot's
  // very first-ever episode when --start-side wasn't given: warm up for one
  // bucket first and pick the side using the same reversion read as adds.
  if (openLongs.length === 0) {
    if (MAX_EPISODES > 0 && closedEpisodes >= MAX_EPISODES) return;

    if (DIRECTION_MODE === 'hourlybias') {
      if (hourlyInvalidation === null) {
        if (!hourlyBiasFetching && now >= hourlyBiasNextTry) {
          hourlyBiasFetching = true;
          refreshHourlyBias().finally(() => { hourlyBiasFetching = false; });
        }
        if (hourlyInvalidation === null) { hourlyBiasNextTry = now + 15000; return; }
      }

      // Track the favourable extreme since the bias was read — the entry
      // waits for a genuine pullback/rally off THIS, not off the level the
      // bias happened to be read at.
      if (hourlyBestPrice === null) hourlyBestPrice = price;
      else if (isLong() ? price > hourlyBestPrice : price < hourlyBestPrice) hourlyBestPrice = price;

      // Already past the invalidation level before any entry ever
      // triggered — this hour's bias didn't hold. Re-read fresh rather
      // than open into a setup that's already broken.
      const invalidated = isLong() ? price <= hourlyInvalidation : price >= hourlyInvalidation;
      if (invalidated) {
        warn(`hourlybias: price already past the invalidation level (${fmt(hourlyInvalidation)}) — re-reading`);
        hourlyInvalidation = null;
        hourlyBestPrice = null;
        return;
      }

      // Wait for a real pullback/rally off the extreme, same threshold the
      // ladder already uses for its own adds — not just any tick.
      const retracePct = isLong()
        ? ((hourlyBestPrice - price) / hourlyBestPrice) * 100
        : ((price - hourlyBestPrice) / hourlyBestPrice) * 100;
      if (retracePct < MIN_DIP_PCT) return;

      openLevel(price, `hourlybias ${direction}: ${retracePct.toFixed(3)}% pullback off ${fmt(hourlyBestPrice)}, ` +
                       `invalidated at ${fmt(hourlyInvalidation)}`).catch(handlePlaceError);
      return;
    }

    if (!warmupDone) {
      if (warmupAnchorPrice === null) {
        warmupAnchorPrice = price;
        warmupStartTs = now;
        info(`warming up ${BUCKET_SEC}s to pick a starting side (pass --start-side to skip this)`);
        return;
      }
      if (now - warmupStartTs < BUCKET_MS) return;   // still warming up

      if (price < warmupAnchorPrice) direction = 'LONG';
      else if (price > warmupAnchorPrice) direction = 'SHORT';
      // unchanged: keep the default (LONG)
      warmupDone = true;
      const movePct = ((price - warmupAnchorPrice) / warmupAnchorPrice) * 100;
      ok(`opening ${direction} — price moved ${signed(movePct)}% over the warm-up ` +
         `(${fmt(warmupAnchorPrice)} -> ${fmt(price)})`);
    }

    openLevel(price, 'episode open').catch(handlePlaceError);
    return;
  }

  // 3. Add on a record dip.
  if (dip === null) return;
  if (level >= MAX_LEVELS) return;
  if (dipRecords.length < MIN_BUCKETS) return;
  if (dip < MIN_DIP_PCT) return;
  if (dip <= bar) return;
  // One add per window at most, so a single deepening dip cannot fire twice.
  if (now - lastAddTs < BUCKET_MS) return;

  openLevel(price, `record ${moveWord()} ${dip.toFixed(3)}% beats previous best ${bar.toFixed(3)}%`, dip)
    .catch(handlePlaceError);
}

function handlePlaceError(e) {
  consecutiveFailures++;
  error(`buy failed (${consecutiveFailures}): ${e.message}`);
  if (consecutiveFailures >= 3) {
    const mins = Math.min(30, consecutiveFailures * 2);
    cooldownUntil = Date.now() + mins * 60000;
    warn(`${consecutiveFailures} consecutive failures — pausing entries for ${mins} min`);
  }
  if (consecutiveFailures >= 10) {
    halt(`${consecutiveFailures} consecutive order failures — stopping to avoid a retry loop`).catch(() => {});
  }
}

function status(price) {
  if (Date.now() - lastStatusLog < 30000) return;
  lastStatusLog = Date.now();

  if (openLongs.length === 0) {
    const wait = cooldownUntil > Date.now() ? ` · cooldown ${Math.ceil((cooldownUntil - Date.now()) / 60000)}min` : '';
    dim(`price ${fmt(price)} · flat · episode ${episode} (${direction} next)${wait}`);
    return;
  }

  const { totalQty, avgEntry, totalNotional, source } = book();
  const pnl = pnlInrAt(price);
  const dip = currentDipPct();
  const tp = targetPrice();
  const sl = stopTriggerPrice();
  dim(`price ${fmt(price)} · ${direction} L${level}/${MAX_LEVELS} · ${totalQty} @ avg ${fmt(avgEntry)} (${source}) · ` +
      `${totalNotional.toFixed(2)} USDT · PnL ${signed(pnl)} INR (exit at ${signed(exitThresholdInr())}, ` +
      `price ${tp ? fmt(tp) : '?'}` + (sl !== null
        ? ` · stop at -${SL_LIMIT_INR ?? SL_INR}, price ${fmt(sl)}`
        : '') +
      `) · ${moveWord()} now ${dip === null ? 'n/a' : dip.toFixed(3) + '%'} ` +
      `vs bar ${dipBarPct().toFixed(3)}% · ${dipRecords.length} window(s)`);
}

/**
 * The price the OPENING entry of an episode must be at least as good as, or
 * null when there is no constraint.
 *
 * Applies only to level 1: ladder adds have their own trigger (--min-dip
 * against the running move) and constraining them here would fight it.
 *
 * The first episode on a side is unconstrained — there is nothing to improve
 * on yet.
 */
function reentryFloor(n) {
  if (!REENTRY_BETTER || n !== 1) return null;
  const last = lastEntryBySide[direction];
  if (last === null || !(last > 0)) return null;
  const edge = REENTRY_EDGE_PCT / 100;
  return isLong() ? last * (1 - edge) : last * (1 + edge);
}

// ─── Entries ─────────────────────────────────────────────────────────────

async function openLevel(price, reason, dipPct = null) {
  placing = true;
  try {
    const c = ex.contract(SYMBOL);
    if (!c) throw new Error(`${SYMBOL} not found in exchangeInfo`);

    const quote = await ex.bestQuote(SYMBOL);
    if (!quote) throw new Error('no order book');

    const n = level + 1;
    // Sit passively at the touch instead of crossing it: buy at the bid when
    // going long, sell at the ask when going short. Never marketable at
    // placement, so it fills as MAKER (lower fee) if/when the market comes
    // to it, trading fill speed/certainty for lower fees and no entry
    // slippage — the opposite tradeoff from before.
    let entryPx = isLong()
      ? quote.bid * (1 - ENTRY_BUFFER_PCT)
      : quote.ask * (1 + ENTRY_BUFFER_PCT);

    // --reentry-better: floor (or cap) the OPENING entry of an episode at the
    // last entry on this side. Rather than waiting for price to come back and
    // then placing at the touch, the order goes straight into the book at the
    // level we want — so it holds queue priority and fills on a brief spike
    // that a poll-and-place approach would miss entirely.
    const reFloor = reentryFloor(n);
    if (reFloor !== null) {
      const adjusted = isLong() ? Math.min(entryPx, reFloor) : Math.max(entryPx, reFloor);
      if (adjusted !== entryPx) {
        const awayPct = ((adjusted - entryPx) / entryPx) * 100;
        info(`re-entry: resting ${isLong() ? 'BUY' : 'SELL'} at ${fmt(adjusted)} rather than the ` +
             `touch ${fmt(entryPx)} (${signed(awayPct)}%) — last ${direction} entered at ` +
             `${fmt(lastEntryBySide[direction])}`);
        entryPx = adjusted;
      }
    }

    const sized = ex.sizeOrder(SYMBOL, levelNotional(n), entryPx);
    if (!sized.ok) throw new Error(`level ${n} (${levelNotional(n).toFixed(2)} USDT): ${sized.reason}`);

    // Hard size ceiling. Checked against the exchange right before placing,
    // so it catches a position the bot does not know it has.
    const breach = await positionCapBreach(sized.notional);
    if (breach) {
      error('='.repeat(66));
      error(`POSITION CAP — refusing to open: ${breach}.`);
      error('  Something is holding more than this bot opened. Check Shark.');
      error('='.repeat(66));
      exitDisabled = false;
      // Back off. Without this the next tick retries immediately and the
      // same refusal is logged several times a second.
      exitRetryAfter = Date.now() + 60000;
      return;
    }

    if (DRY_RUN) {
      recordFill({
        level: n, qty: sized.qty, fillPrice: sized.price, notional: sized.notional,
        clientOrderId: `paper-${SYMBOL}-L${n}-${Date.now()}`, reason, dipPct,
      });
      trade(`[DRY] ${entrySide()} L${n} ${sized.qty} ${SYMBOL} @ ${fmt(sized.price)} ` +
            `(${sized.notional.toFixed(2)} USDT, ${direction}) — ${reason}`);
      return;
    }

    // Clean the slate before the first buy of an episode. A resting order
    // from a previous run can fill later with nothing managing it.
    if (n === 1) {
      try {
        const r = await ex.cancelAllOrders(SYMBOL);
        if (r.found > 0) {
          warn(`cleared ${r.cancelled}/${r.found} stale order(s) on ${SYMBOL} before opening`);
          if (r.failed.length) throw new Error(`stale orders remain: ${r.failed.join(' | ')}`);
          await new Promise(res => setTimeout(res, 1000));
        }
      } catch (e) {
        if (/stale orders remain/.test(e.message)) throw e;
        warn(`stale-order check failed: ${e.message}`);
      }
    }

    if (!preferenceSet) {
      const exists = await ex.hasOpenPosition(SYMBOL);
      if (exists === false) {
        await ex.setPreference(SYMBOL, LEVERAGE)
          .then(() => { preferenceSet = true; })
          .catch(e => { preferenceSet = true; warn(`preference set failed (${e.message}) — using the account default`); });
      } else {
        preferenceSet = true;
      }
    }

    const before = await ex.positionSize(SYMBOL);
    const res = await ex.placeLimit({
      symbol: SYMBOL, side: entrySide(), quantity: sized.qty, price: sized.price,
    });
    trade(`${entrySide()} L${n} ${sized.qty} ${SYMBOL} @ ${fmt(sized.price)} · ${direction} · ` +
          `${sized.notional.toFixed(2)} USDT · marginAsset ${ex.marginAssetInUse()} · ` +
          `order ${res.clientOrderId} — ${reason}`);

    if (n === 1) {
      // Nothing else is resting on the exchange yet, so there's no race to
      // worry about — a plain fill confirmation is enough.
      const filled = await confirmFill(before, sized.qty, res.clientOrderId);
      if (!filled) {
        error(`entry L${n} did not fill — cancelled, level not counted`);
        return;
      }
      recordFill({
        level: n, qty: sized.qty, fillPrice: sized.price, notional: sized.notional,
        clientOrderId: res.clientOrderId, reason, dipPct,
      });
      await placeRestingTp('initial take profit after L1');
      await placeRestingSl('initial stop loss after L1');
      return;
    }

    // Levels 2+: the OLD take-profit is deliberately left resting on the
    // exchange while this add is in flight, so the position is never
    // uncovered even for the ~24s a fill confirmation can take. That means
    // it can fire before this add confirms — confirmLevelAddFill watches
    // for exactly that instead of assuming it away.
    const outcome = await confirmLevelAddFill(before, sized.qty, res.clientOrderId);

    if (outcome === 'filled') {
      recordFill({
        level: n, qty: sized.qty, fillPrice: sized.price, notional: sized.notional,
        clientOrderId: res.clientOrderId, reason, dipPct,
      });
      await replaceRestingTp(`after L${n} add`);
      await replaceRestingSl(`after L${n} add`);
      return;
    }

    if (outcome === 'tp_fired' || outcome === 'sl_fired') {
      await handleRestingFireDuringAdd(outcome === 'tp_fired' ? 'take-profit' : 'stop loss', n, res, sized);
      return;
    }

    // timeout: the add itself never filled. Both resting orders are
    // untouched and still protect the smaller, pre-add position.
    error(`entry L${n} did not fill — cancelled, level not counted (the resting orders are unaffected)`);
  } finally {
    placing = false;
    consecutiveFailures = 0;
  }
}

/**
 * Common handling for EITHER resting order (take-profit or stop-loss)
 * firing while a level add was still confirming. Settles the now-closing
 * episode from the wallet, then — since the in-flight add's own fate is
 * still unknown at this point — either cancels it (nothing to carry over)
 * or, if it turns out to have filled anyway, folds that quantity in as the
 * NEXT episode's level 1 rather than losing track of it.
 */
async function handleRestingFireDuringAdd(which, n, res, sized) {
  warn(`the resting ${which} fired while L${n} was still placing — settling the episode first`);
  let cancelOk = true;
  try {
    await ex.cancelOrder(res.clientOrderId);
  } catch (e) {
    cancelOk = false;   // most likely reason a cancel fails here: it already filled
  }
  if (!cancelOk) await new Promise(r => setTimeout(r, 1500));

  const sizeNow = await ex.positionSize(SYMBOL).catch(() => null);
  const carriedOver = sizeNow !== null && sizeNow > 0;
  restingTp = null;
  restingSl = null;
  const settled = await realisedPnlInr(episodeStartTs);
  // Don't flip if there's a fill to carry over — it belongs to THIS
  // episode's direction, not the new one. See finishEpisode's doc comment.
  finishEpisode(settled, lastPrice ?? sized.price, { flip: !carriedOver, reason: 'carryover' });

  if (carriedOver) {
    warn(`L${n}'s entry filled despite the race — starting episode ${episode} from it (${sizeNow} units)`);
    try { await ex.cancelAllOrders(SYMBOL); } catch (e) { /* best effort, mirrors finishEpisode's own cleanup */ }
    recordFill({
      level: 1, qty: sizeNow, fillPrice: sized.price, notional: sizeNow * sized.price,
      clientOrderId: res.clientOrderId, reason: `carried over from a ${which}/add race`, dipPct: null,
    });
    await placeRestingTp('after a race-carried level 1');
    await placeRestingSl('after a race-carried level 1');
  } else if (!cancelOk) {
    error(`could not confirm whether L${n}'s order (${res.clientOrderId}) filled or was cancelled — ` +
          `CHECK ${SYMBOL} OPEN ORDERS ON SHARK for a stray order`);
  }
}

/** Polls the position until it grows by the ordered quantity, then cancels if not. */
async function confirmFill(before, qty, clientOrderId) {
  const baseline = before === null ? null : before;
  for (let i = 0; i < ENTRY_TIMEOUT_ITERS; i++) {   // up to ENTRY_TIMEOUT_MIN
    await new Promise(r => setTimeout(r, ENTRY_POLL_MS));
    const now = await ex.positionSize(SYMBOL);
    if (now === null) continue;
    if (baseline === null) { if (now > 0) return true; }
    else if (now >= baseline + qty * 0.95) return true;
  }
  try {
    await ex.cancelOrder(clientOrderId);
    warn(`cancelled unfilled entry ${clientOrderId}`);
  } catch (e) {
    // It may have filled in the race between the last poll and the cancel.
    const now = await ex.positionSize(SYMBOL).catch(() => null);
    if (now !== null && baseline !== null && now >= baseline + qty * 0.95) {
      warn('cancel failed because the order had already filled — keeping the level');
      return true;
    }
    error(`could not cancel unfilled entry ${clientOrderId}: ${e.message} — check ${SYMBOL} on Shark`);
  }
  return false;
}

/**
 * Confirms a level-ADD's buy while also watching for the resting take-profit
 * firing mid-flight. The safer sequencing (old TP left resting until the
 * add confirms) means the two race each other: the add can complete just as
 * the OLD, now-undersized TP closes the book out from under it.
 * Returns 'filled', 'tp_fired', or 'timeout'.
 */
async function confirmLevelAddFill(beforeQty, qty, clientOrderId) {
  for (let i = 0; i < ENTRY_TIMEOUT_ITERS; i++) {   // up to ENTRY_TIMEOUT_MIN
    await new Promise(r => setTimeout(r, ENTRY_POLL_MS));

    if (restingTp && !(await tpStillResting())) return 'tp_fired';
    if (restingSl && !(await slStillResting())) return 'sl_fired';

    const now = await ex.positionSize(SYMBOL);
    if (now === null) continue;
    if (now >= beforeQty + qty * 0.95) return 'filled';
  }
  try {
    await ex.cancelOrder(clientOrderId);
    warn(`cancelled unfilled level-add entry ${clientOrderId}`);
  } catch (e) {
    const now = await ex.positionSize(SYMBOL).catch(() => null);
    if (now !== null && now >= beforeQty + qty * 0.95) {
      warn('cancel failed because the level-add order had already filled — keeping the level');
      return 'filled';
    }
    if (restingTp && !(await tpStillResting())) return 'tp_fired';
    if (restingSl && !(await slStillResting())) return 'sl_fired';
    error(`could not cancel unfilled entry ${clientOrderId}: ${e.message} — check ${SYMBOL} on Shark`);
  }
  return 'timeout';
}

function recordFill({ level: n, qty, fillPrice, notional, clientOrderId, reason, dipPct }) {
  openLongs.push({ level: n, qty, fillPrice, notional, clientOrderId, ts: Date.now() });
  level = n;
  lastAddTs = Date.now();

  // The dip that triggered this add becomes the new record, so the next add
  // needs a strictly deeper one — exactly the escalation the spec asks for.
  if (dipPct !== null) dipRecords.push({ t: Date.now(), dipPct, source: 'trigger' });

  if (firstEntryTs === null) {
    // Remember where this side entered, so the next episode on the same side
    // has to improve on it rather than chasing the move that just paid out.
    lastEntryBySide[direction] = fillPrice;
    firstEntryTs = Date.now();
    episodeStartTs = firstEntryTs;
    nextHoldCheckTs = MAX_HOLD_MIN !== null ? firstEntryTs + MAX_HOLD_MIN * 60000 : null;
    holdChecksSurvived = 0;
    // Anchor the first bucket to the FEED price, not the fill price. The fill
    // sits above the mark by the entry buffer, so anchoring to it would book a
    // phantom dip of that size and set the bar for the first add too high.
    bucketStartPrice = lastPrice ?? fillPrice;
  }

  refreshExchangePos().catch(() => {});

  writeTrade({
    level: n, side: entrySide(), qty, price: fillPrice, notional, dipPct,
    pnl: '', clientOrderId, note: reason,
  });

  const { totalQty, avgEntry, totalNotional } = aggregate();
  const nextN = n + 1;
  ok(`${direction} L${n}/${MAX_LEVELS} filled · book ${totalQty} @ avg ${fmt(avgEntry)} · ` +
     `${totalNotional.toFixed(2)} USDT · exit target ${signed(exitThresholdInr())} INR` +
     (nextN <= MAX_LEVELS
       ? ` · next add ${levelNotional(nextN).toFixed(2)} USDT on a ${moveWord()} bigger than ${dipBarPct().toFixed(3)}%`
       : ' · ladder full, waiting on the profit target'));
}

// ─── Resting take-profit maintenance ────────────────────────────────────

/** True if the resting take-profit order is still listed among open orders. */
async function tpStillResting() {
  if (!restingTp) return false;
  const open = await ex.openOrders(SYMBOL).catch(() => null);
  if (open === null) return true;   // unknown — don't false-trigger a close on a lookup failure
  const list = Array.isArray(open) ? open : (open.data || open.orders || []);
  return list.some(o => (o.clientOrderId || o.clientOrderID || o.linkId) === restingTp.clientOrderId);
}

/**
 * Places a reduce-only LIMIT order for the WHOLE current position at the
 * price that hits the profit target, and leaves it resting on the exchange:
 * a SELL above the average entry when long, a BUY below it when short.
 * This is what makes the take-profit survive the bot crashing — it becomes
 * real exchange order-book state, not just something the running process
 * would otherwise have noticed.
 */
async function placeRestingTp(reason) {
  if (DRY_RUN) return;
  const c = ex.contract(SYMBOL);
  await refreshExchangePos();
  const qty = await ex.positionSize(SYMBOL);
  if (!qty || qty <= 0) { warn('placeRestingTp: no position to protect — skipped'); return; }
  const tgt = targetPrice();
  if (tgt === null) { warn('placeRestingTp: could not compute a target price — skipped'); return; }
  if (tgt <= 0) {
    warn(`placeRestingTp: the ${TP_INR} INR target sits at or below zero for this position — skipped`);
    return;
  }
  const px = ex.roundTo(tgt, c.pricePrecision);
  const q = ex.floorTo(qty, c.quantityPrecision);
  if (q <= 0) { warn('placeRestingTp: quantity rounds to zero — skipped'); return; }
  try {
    const res = await ex.placeLimit({ symbol: SYMBOL, side: exitSide(), quantity: q, price: px, reduceOnly: true });
    restingTp = { clientOrderId: res.clientOrderId, qty: q, price: px, side: exitSide(), ts: Date.now() };
    trade(`resting TAKE PROFIT: ${exitSide()} ${q} ${SYMBOL} @ ${fmt(px)} reduce-only ` +
          `(closes the ${direction}) · order ${res.clientOrderId} — ${reason}`);
  } catch (e) {
    error(`could not place a resting take-profit (${e.message}) — this position has NO exchange-side exit right now`);
  }
}

/**
 * Swaps the resting take-profit for a fresh one sized to the current
 * (post-add) position. The old order is cancelled first; if that cancel
 * fails because it had already filled in the gap, the episode is already
 * closing and a new TP must NOT be placed on top of it. If it fails for any
 * OTHER reason, the old order is left in place rather than risking two
 * live reduce-only sells overlapping the same quantity.
 */
async function replaceRestingTp(reason) {
  const old = restingTp;
  if (old) {
    try {
      await ex.cancelOrder(old.clientOrderId);
      restingTp = null;
    } catch (e) {
      const size = await ex.positionSize(SYMBOL).catch(() => null);
      if (size === 0) {
        warn('the previous take-profit filled just as it was being replaced — episode is closing');
        restingTp = null;
        const settled = await realisedPnlInr(episodeStartTs);
        finishEpisode(settled, lastPrice ?? old.price, { reason: 'tp' });
        return;
      }
      warn(`could not cancel the previous take-profit (${e.message}) — leaving it in place, will retry next add`);
      return;   // do NOT place a second TP on top of one that may still be live
    }
  }
  await placeRestingTp(reason);
}

// ─── Resting stop-loss maintenance ──────────────────────────────────────
// Mirrors the take-profit trio above, except the order is a STOP_MARKET:
// inert until price reaches the trigger, then executes immediately at
// whatever price is available. No separate limit leg to fail to fill —
// trades price certainty for the guarantee that it actually closes. Its
// trigger sits on the LOSS side of the average entry.
//
// Switched from STOP_LIMIT after live evidence: a resting stop-limit sat
// unfilled for 13+ minutes while price repeatedly crossed both its trigger
// and its limit leg — the exact failure mode behind this bot's largest
// losses. STOP_MARKET accepts slippage on the fill in exchange for actually
// closing the position when triggered.

/** True if the resting stop-loss order is still listed among open orders. */
async function slStillResting() {
  if (!restingSl) return false;
  const open = await ex.openOrders(SYMBOL).catch(() => null);
  if (open === null) return true;
  const list = Array.isArray(open) ? open : (open.data || open.orders || []);
  return list.some(o => (o.clientOrderId || o.clientOrderID || o.linkId) === restingSl.clientOrderId);
}

/**
 * Places a reduce-only STOP_MARKET for the WHOLE current position: a SELL
 * below the average entry when long, a BUY above it when short. Executes
 * immediately once triggered — no separate limit leg to fail to fill.
 */
async function placeRestingSl(reason) {
  if (DRY_RUN || !slEnabled()) return;
  const c = ex.contract(SYMBOL);
  await refreshExchangePos();
  const qty = await ex.positionSize(SYMBOL);
  if (!qty || qty <= 0) { warn('placeRestingSl: no position to protect — skipped'); return; }
  const trigger = stopTriggerPrice();
  if (trigger === null || trigger <= 0) {
    warn('placeRestingSl: could not compute a valid stop price for this position — skipped');
    return;
  }
  const stopPx = ex.roundTo(trigger, c.pricePrecision);
  const q = ex.floorTo(qty, c.quantityPrecision);
  if (q <= 0) { warn('placeRestingSl: quantity rounds to zero — skipped'); return; }
  const capDesc = SL_LIMIT_INR !== null ? `exactly -${SL_LIMIT_INR} INR` : `-${SL_INR} INR`;
  try {
    let res;
    if (SL_LIMIT_INR !== null) {
      // STOP_LIMIT: the limit is pinned at exactly -N INR. It cannot fill
      // worse than that — and in a gap it does not fill at all, which is the
      // trade the flag exists to make.
      const limit = stopLimitPrice();
      if (limit === null || limit <= 0) {
        warn('placeRestingSl: could not compute the stop-limit price — skipped');
        return;
      }
      const limitPx = isLong()
        ? ex.floorTo(limit, c.pricePrecision)      // sell no lower than this
        : ceilTo(limit, c.pricePrecision);         // buy no higher than this
      res = await ex.placeStopLimit({
        symbol: SYMBOL, side: exitSide(), quantity: q,
        stopPrice: stopPx, price: limitPx, reduceOnly: true,
      });
      restingSl = { clientOrderId: res.clientOrderId, qty: q, stopPrice: stopPx,
                    limitPrice: limitPx, side: exitSide(), ts: Date.now() };
      trade(`resting STOP LIMIT: ${exitSide()} ${q} ${SYMBOL} trigger ${fmt(stopPx)} ` +
            `-> limit ${fmt(limitPx)} reduce-only (caps the ${direction} at ${capDesc}, ` +
            `trigger ${SL_TRIGGER_BUFFER_INR} INR earlier) · order ${res.clientOrderId} — ${reason}`);
    } else {
      res = await ex.placeStopMarket({
        symbol: SYMBOL, side: exitSide(), quantity: q, stopPrice: stopPx, reduceOnly: true,
      });
      restingSl = { clientOrderId: res.clientOrderId, qty: q, stopPrice: stopPx, side: exitSide(), ts: Date.now() };
      trade(`resting STOP LOSS: ${exitSide()} ${q} ${SYMBOL} stop ${fmt(stopPx)} (market once triggered) reduce-only ` +
            `(caps the ${direction} at ${capDesc}) · order ${res.clientOrderId} — ${reason}`);
    }
  } catch (e) {
    error(`could not place a resting stop loss (${e.message}) — this position has NO stop protection right now`);
  }
}

/** Swaps the resting stop for a fresh one sized to the current position. */
async function replaceRestingSl(reason) {
  if (!slEnabled()) return;
  const old = restingSl;
  if (old) {
    try {
      await ex.cancelOrder(old.clientOrderId);
      restingSl = null;
    } catch (e) {
      const size = await ex.positionSize(SYMBOL).catch(() => null);
      if (size === 0) {
        warn('the previous stop loss filled just as it was being replaced — episode is closing');
        restingSl = null;
        const settled = await realisedPnlInr(episodeStartTs);
        finishEpisode(settled, lastPrice ?? old.stopPrice, { reason: 'sl' });
        return;
      }
      warn(`could not cancel the previous stop loss (${e.message}) — leaving it in place, will retry next add`);
      return;
    }
  }
  await placeRestingSl(reason);
}

// ─── Take profit ─────────────────────────────────────────────────────────

/**
 * Exits the whole position with a reduce-only LIMIT sell, re-pricing at the
 * live bid until it fills. A sell placed at the best bid is marketable, so
 * this normally fills on the first attempt; the loop covers a fast market
 * walking away from the order.
 */
async function takeProfit(price) {
  if (exiting) return;
  exiting = true;
  reconcileSuppressedUntil = Date.now() + 180000;

  try {
    const c = ex.contract(SYMBOL);
    const threshold = exitThresholdInr();

    // Re-check against the side of the book we actually exit into: the bid
    // for a long, the ask for a short. The mark price sits between them, and
    // acting on the mark alone would exit for less than the target.
    const quote = await ex.bestQuote(SYMBOL);
    const exitRef = quote ? (isLong() ? quote.bid : quote.ask) : price;
    const { totalQty, avgEntry } = book();
    if (totalQty <= 0) return;
    const exitMove = isLong() ? (exitRef - avgEntry) : (avgEntry - exitRef);
    const pnlAtBid = exitMove * totalQty * INR_RATE;
    if (pnlAtBid < threshold) {
      dim(`target seen on the mark (${signed(pnlInrAt(price))}) but the ` +
          `${isLong() ? 'bid' : 'ask'} only pays ${signed(pnlAtBid)} INR — holding`);
      // Throttle: the mark can sit above the bid for a long stretch, and this
      // branch costs an order-book call every time it runs.
      exitRetryAfter = Date.now() + 3000;
      return;
    }

    ok(`TAKE PROFIT — ${signed(pnlAtBid)} INR at the ${isLong() ? 'bid' : 'ask'} ` +
       `(target ${signed(threshold)}) · ${direction} ${totalQty} @ avg ${fmt(avgEntry)}`);

    if (DRY_RUN) {
      const px = isLong()
        ? exitRef * (1 - EXIT_BUFFER_PCT / 100)
        : exitRef * (1 + EXIT_BUFFER_PCT / 100);
      trade(`[DRY] ${exitSide()} ${totalQty} ${SYMBOL} @ ${fmt(px)} (reduce-only limit)`);
      writeTrade({
        level: 'EXIT', side: exitSide(), qty: totalQty, price: px, notional: totalQty * px,
        dipPct: null, pnl: pnlAtBid, clientOrderId: 'paper-exit', note: 'take profit',
      });
      finishEpisode(pnlAtBid, px, { reason: 'tp' });
      return;
    }

    // Resting orders would eat into the quantity available to close. This
    // fallback only runs when restingTp is already null (see onPrice), but
    // clear it defensively in case that ever changes.
    restingTp = null;
    try {
      const cleared = await ex.cancelAllOrders(SYMBOL);
      if (cleared.found > 0) {
        info(`cleared ${cleared.cancelled}/${cleared.found} resting order(s) before exiting`);
        await new Promise(r => setTimeout(r, 800));
      }
    } catch (e) {
      warn(`could not clear resting orders: ${e.message} — the exit may be rejected`);
    }

    // Size from what the exchange holds. Closing a remembered quantity that
    // is larger than the real one opens a SHORT.
    let remaining = closableQty(await ex.positionSize(SYMBOL).catch(() => null));
    if (remaining === 0) {
      warn('exchange reports no position — already closed');
      finishEpisode(null, exitRef, { reason: 'tp' });
      return;
    }
    if (remaining === null) remaining = totalQty;

    for (let attempt = 1; attempt <= 5; attempt++) {
      const q = await ex.bestQuote(SYMBOL);
      const ref = q ? (isLong() ? q.bid : q.ask) : exitRef;
      // Round away from the market on both sides so the closing limit stays
      // marketable: down to at-or-below the bid when selling, up to
      // at-or-above the ask when buying back.
      const px = isLong()
        ? ex.floorTo(ref * (1 - EXIT_BUFFER_PCT / 100), c.pricePrecision)
        : ceilTo(ref * (1 + EXIT_BUFFER_PCT / 100), c.pricePrecision);
      const qty = ex.floorTo(remaining, c.quantityPrecision);
      if (qty <= 0) break;

      const pnlNow = (isLong() ? (px - avgEntry) : (avgEntry - px)) * qty * INR_RATE;
      if (pnlNow < TP_INR) {
        warn(`the ${isLong() ? 'bid' : 'ask'} slipped — exiting here would only make ` +
             `${signed(pnlNow)} INR (target ${TP_INR}). Backing off, will retry on the next tick.`);
        exitRetryAfter = Date.now() + 15000;
        return;
      }

      const res = await ex.placeLimit({
        symbol: SYMBOL, side: exitSide(), quantity: qty, price: px, reduceOnly: true,
      });
      const orderId = res.clientOrderId;
      trade(`${exitSide()} ${qty} ${SYMBOL} @ ${fmt(px)} reduce-only · order ${orderId} ` +
            `(attempt ${attempt}/5, ~${signed(pnlNow)} INR)`);

      const done = await waitForClose(orderId);
      if (done.closed) {
        const realised = (isLong() ? (px - avgEntry) : (avgEntry - px)) * qty * INR_RATE;
        writeTrade({
          level: 'EXIT', side: exitSide(), qty, price: px, notional: qty * px,
          dipPct: null, pnl: realised, clientOrderId: orderId, note: 'take profit',
        });
        await finishEpisodeSettled(realised, px, { reason: 'tp' });
        return;
      }

      remaining = done.remaining !== null ? done.remaining : remaining;
      if (done.partial) warn(`partially filled — ${remaining} still open, re-pricing`);
      else warn(`no fill at ${fmt(px)} — re-pricing at the fresh bid`);

      try { await ex.cancelOrder(orderId); } catch (e) { dim(`cancel of ${orderId} failed: ${e.message}`); }
      await new Promise(r => setTimeout(r, 1500));
    }

    exitFailures++;
    error('='.repeat(66));
    error(`EXIT FAILED after 5 attempts on ${SYMBOL} — position is STILL OPEN`);
    error(`  ~${remaining} units at avg ${fmt(avgEntry)}.` +
          (!slEnabled() ? ' This bot has NO stop loss.' : ` The resting stop loss was cleared for this exit attempt.`));
    error('  Close it on Shark yourself if this repeats.');
    error('='.repeat(66));
    if (exitFailures >= 3) {
      exitDisabled = true;
      error('automatic exits disabled after 3 failed rounds — manage this position manually');
    } else {
      exitRetryAfter = Date.now() + 60000;
    }
  } finally {
    exiting = false;
  }
}

// ─── Time stop ───────────────────────────────────────────────────────────

/**
 * Closes the position because it has been open too long, whatever its PnL.
 *
 * Deliberately separate from stopLoss() rather than folded into it. A stop
 * has a trigger condition and re-checks the executable price before firing;
 * a time exit has neither — the clock has run out and the only question is
 * how fast we can get flat. Keeping them apart also means this cannot
 * regress the stop path, which handles live money on a tested route.
 *
 * Like the stop it never waits for a better price: it re-prices at the fresh
 * touch each attempt and takes what the market offers.
 */
async function timeExit(price) {
  if (exiting) return;
  exiting = true;
  reconcileSuppressedUntil = Date.now() + 180000;

  try {
    const c = ex.contract(SYMBOL);
    const { totalQty, avgEntry } = book();
    if (totalQty <= 0) return;

    const quote = await ex.bestQuote(SYMBOL).catch(() => null);
    const exitRef = quote ? (isLong() ? quote.bid : quote.ask) : price;
    const heldMin = firstEntryTs ? (Date.now() - firstEntryTs) / 60000 : 0;
    const pnlAtBid = (isLong() ? (exitRef - avgEntry) : (avgEntry - exitRef)) * totalQty * INR_RATE;

    warn(`TIME EXIT — held ${heldMin.toFixed(1)} min (limit ${MAX_HOLD_MIN}) · ` +
         `closing ${totalQty} ${SYMBOL} at ~${signed(pnlAtBid)} INR`);

    if (DRY_RUN) {
      const px = isLong()
        ? exitRef * (1 - EXIT_BUFFER_PCT / 100)
        : exitRef * (1 + EXIT_BUFFER_PCT / 100);
      trade(`[DRY] ${exitSide()} ${totalQty} ${SYMBOL} @ ${fmt(px)} (reduce-only, time exit)`);
      writeTrade({
        level: 'EXIT', side: exitSide(), qty: totalQty, price: px, notional: totalQty * px,
        dipPct: null, pnl: pnlAtBid, clientOrderId: 'paper-exit-time', note: 'time exit',
      });
      finishEpisode(pnlAtBid, px, { reason: 'time' });
      return;
    }

    restingTp = null;
    restingSl = null;
    try {
      const cleared = await ex.cancelAllOrders(SYMBOL);
      if (cleared.found > 0) {
        info(`cleared ${cleared.cancelled}/${cleared.found} resting order(s) before the time exit`);
        await new Promise(r => setTimeout(r, 800));
      }
    } catch (e) {
      warn(`could not clear resting orders: ${e.message} — the exit may be rejected`);
    }

    let remaining = closableQty(await ex.positionSize(SYMBOL).catch(() => null));
    if (remaining === 0) {
      warn('exchange reports no position — already closed');
      finishEpisode(null, exitRef, { reason: 'time' });
      return;
    }
    if (remaining === null) remaining = totalQty;

    for (let attempt = 1; attempt <= 5; attempt++) {
      const q = await ex.bestQuote(SYMBOL).catch(() => null);
      const ref = q ? (isLong() ? q.bid : q.ask) : exitRef;
      const px = isLong()
        ? ex.floorTo(ref * (1 - EXIT_BUFFER_PCT / 100), c.pricePrecision)
        : ceilTo(ref * (1 + EXIT_BUFFER_PCT / 100), c.pricePrecision);
      const qty = ex.floorTo(remaining, c.quantityPrecision);
      if (qty <= 0) break;

      const res = await ex.placeLimit({
        symbol: SYMBOL, side: exitSide(), quantity: qty, price: px, reduceOnly: true,
      });
      const orderId = res.clientOrderId;
      const pnlNow = (isLong() ? (px - avgEntry) : (avgEntry - px)) * qty * INR_RATE;
      trade(`${exitSide()} ${qty} ${SYMBOL} @ ${fmt(px)} reduce-only · order ${orderId} ` +
            `(time exit ${attempt}/5, ~${signed(pnlNow)} INR)`);

      const done = await waitForClose(orderId);
      if (done.closed) {
        writeTrade({
          level: 'EXIT', side: exitSide(), qty, price: px, notional: qty * px,
          dipPct: null, pnl: pnlNow, clientOrderId: orderId, note: 'time exit',
        });
        await finishEpisodeSettled(pnlNow, px, { reason: 'time' });
        return;
      }

      remaining = done.remaining !== null ? done.remaining : remaining;
      if (done.partial) warn(`partially filled — ${remaining} still open, re-pricing`);
      else warn(`no fill at ${fmt(px)} — re-pricing at the fresh touch`);
      try { await ex.cancelOrder(orderId); } catch (e) { dim(`cancel of ${orderId} failed: ${e.message}`); }
      await new Promise(r => setTimeout(r, 1200));
    }

    error(`TIME EXIT did not complete on ${SYMBOL} — ~${remaining} units still open. ` +
          `The position stays managed; it will retry.`);
    exitRetryAfter = Date.now() + 15000;
  } finally {
    exiting = false;
  }
}

// ─── Stop loss ───────────────────────────────────────────────────────────

/**
 * Reactive fallback for the stop loss — mirrors takeProfit() closely, with
 * one deliberate difference: a stop never backs off to wait for a better
 * price. Once triggered it re-prices at the fresh touch and keeps trying
 * until it's out, accepting whatever the market offers — the entire point
 * of a stop is capping the loss, not holding out for a nicer exit.
 */
async function stopLoss(price) {
  if (exiting) return;
  exiting = true;
  reconcileSuppressedUntil = Date.now() + 180000;

  try {
    const c = ex.contract(SYMBOL);

    // Confirm against the real executable price before firing — a wide
    // spread can make the mark look worse than what's actually available,
    // and a stop shouldn't panic-exit on that noise. It does NOT wait for a
    // better price beyond this single check; see the note above.
    const quote = await ex.bestQuote(SYMBOL);
    const exitRef = quote ? (isLong() ? quote.bid : quote.ask) : price;
    const { totalQty, avgEntry } = book();
    if (totalQty <= 0) return;
    const exitMove = isLong() ? (exitRef - avgEntry) : (avgEntry - exitRef);
    const pnlAtBid = exitMove * totalQty * INR_RATE;
    // Price-based rather than an INR comparison, so the same check works
    // for --sl and --sl-stop-limit without re-deriving the distance.
    const trigger = stopTriggerPrice();
    const stillBad = trigger !== null && (isLong() ? exitRef <= trigger : exitRef >= trigger);
    if (!stillBad) {
      dim(`stop seen on the mark (${signed(pnlInrAt(price))}) but the ` +
          `${isLong() ? 'bid' : 'ask'} hasn't reached the trigger (${fmt(trigger)}) — holding`);
      exitRetryAfter = Date.now() + 3000;
      return;
    }

    const thresholdDesc = SL_LIMIT_INR !== null ? `-${SL_LIMIT_INR} INR (limit)` : `-${SL_INR} INR`;
    error(`STOP LOSS — ${signed(pnlAtBid)} INR at the ${isLong() ? 'bid' : 'ask'} ` +
          `(threshold ${thresholdDesc}) · ${direction} ${totalQty} @ avg ${fmt(avgEntry)}`);

    if (DRY_RUN) {
      const px = isLong()
        ? exitRef * (1 - EXIT_BUFFER_PCT / 100)
        : exitRef * (1 + EXIT_BUFFER_PCT / 100);
      trade(`[DRY] ${exitSide()} ${totalQty} ${SYMBOL} @ ${fmt(px)} (reduce-only, stop loss)`);
      writeTrade({
        level: 'EXIT', side: exitSide(), qty: totalQty, price: px, notional: totalQty * px,
        dipPct: null, pnl: pnlAtBid, clientOrderId: 'paper-exit-sl', note: 'stop loss',
      });
      finishEpisode(pnlAtBid, px, { reason: 'sl' });
      return;
    }

    restingTp = null;
    restingSl = null;
    try {
      const cleared = await ex.cancelAllOrders(SYMBOL);
      if (cleared.found > 0) {
        info(`cleared ${cleared.cancelled}/${cleared.found} resting order(s) before stopping out`);
        await new Promise(r => setTimeout(r, 800));
      }
    } catch (e) {
      warn(`could not clear resting orders: ${e.message} — the stop may be rejected`);
    }

    let remaining = closableQty(await ex.positionSize(SYMBOL).catch(() => null));
    if (remaining === 0) {
      warn('exchange reports no position — already closed');
      finishEpisode(null, exitRef, { reason: 'sl' });
      return;
    }
    if (remaining === null) remaining = totalQty;

    for (let attempt = 1; attempt <= 5; attempt++) {
      const q = await ex.bestQuote(SYMBOL);
      const ref = q ? (isLong() ? q.bid : q.ask) : exitRef;
      const px = isLong()
        ? ex.floorTo(ref * (1 - EXIT_BUFFER_PCT / 100), c.pricePrecision)
        : ceilTo(ref * (1 + EXIT_BUFFER_PCT / 100), c.pricePrecision);
      const qty = ex.floorTo(remaining, c.quantityPrecision);
      if (qty <= 0) break;

      const pnlNow = (isLong() ? (px - avgEntry) : (avgEntry - px)) * qty * INR_RATE;
      const res = await ex.placeLimit({
        symbol: SYMBOL, side: exitSide(), quantity: qty, price: px, reduceOnly: true,
      });
      const orderId = res.clientOrderId;
      trade(`${exitSide()} ${qty} ${SYMBOL} @ ${fmt(px)} reduce-only · order ${orderId} ` +
            `(stop attempt ${attempt}/5, ~${signed(pnlNow)} INR)`);

      const done = await waitForClose(orderId);
      if (done.closed) {
        const realised = (isLong() ? (px - avgEntry) : (avgEntry - px)) * qty * INR_RATE;
        writeTrade({
          level: 'EXIT', side: exitSide(), qty, price: px, notional: qty * px,
          dipPct: null, pnl: realised, clientOrderId: orderId, note: 'stop loss',
        });
        await finishEpisodeSettled(realised, px, { reason: 'sl' });
        return;
      }

      remaining = done.remaining !== null ? done.remaining : remaining;
      if (done.partial) warn(`partially filled — ${remaining} still open, re-pricing`);
      else warn(`no fill at ${fmt(px)} — re-pricing at the fresh touch`);

      try { await ex.cancelOrder(orderId); } catch (e) { dim(`cancel of ${orderId} failed: ${e.message}`); }
      await new Promise(r => setTimeout(r, 1500));
    }

    exitFailures++;
    error('='.repeat(66));
    error(`STOP-OUT FAILED after 5 attempts on ${SYMBOL} — position is STILL OPEN and STILL LOSING`);
    error(`  ~${remaining} units at avg ${fmt(avgEntry)}.`);
    error('  Close it on Shark yourself NOW.');
    error('='.repeat(66));
    if (exitFailures >= 3) {
      exitDisabled = true;
      error('automatic exits disabled after 3 failed rounds — manage this position manually');
    } else {
      exitRetryAfter = Date.now() + 15000;   // shorter than the TP's backoff — a stuck stop is more urgent
    }
  } finally {
    exiting = false;
  }
}

/**
 * Waits for a reduce-only sell to close the position.
 * An order leaving the book usually means it filled — the positions endpoint
 * lags by a second or two — so a vanished order is re-checked before being
 * treated as a rejection. Getting that backwards would re-sell and open a short.
 */
async function waitForClose(clientOrderId) {
  const startSize = await ex.positionSize(SYMBOL).catch(() => null);
  for (let i = 0; i < 8; i++) {                     // up to ~24s
    await new Promise(r => setTimeout(r, 3000));
    const size = await ex.positionSize(SYMBOL);
    if (size === 0) return { closed: true, remaining: 0, partial: false };

    const open = await ex.openOrders(SYMBOL).catch(() => null);
    const list = open ? (Array.isArray(open) ? open : (open.data || open.orders || [])) : [];
    const still = list.some(o => (o.clientOrderId || o.clientOrderID || o.linkId) === clientOrderId);
    if (!still) {
      for (let j = 0; j < 4; j++) {
        await new Promise(r => setTimeout(r, 2500));
        const s2 = await ex.positionSize(SYMBOL);
        if (s2 === 0) return { closed: true, remaining: 0, partial: false };
        if (s2 !== null && startSize !== null && s2 < startSize * 0.95) {
          return { closed: false, remaining: s2, partial: true };
        }
      }
      return { closed: false, remaining: size, partial: false };
    }
    if (size !== null && startSize !== null && size < startSize * 0.95) {
      return { closed: false, remaining: size, partial: true };
    }
  }
  const size = await ex.positionSize(SYMBOL).catch(() => null);
  return { closed: size === 0, remaining: size, partial: false };
}

/** Wallet-delta PnL for the episode — ground truth, includes fees and funding. */
/**
 * Realised PnL for the episode that just closed, in INR, read from the
 * exchange's own position history. Returns null if it cannot be determined —
 * callers must never treat that as zero.
 *
 * This replaces a wallet-diff. The old version recorded the futures wallet
 * before the episode and subtracted it after the exit, calling the
 * difference profit. That is not what the number means: `walletBalance` is
 * the FREE balance, so it also moves when margin locks on entry, unlocks on
 * exit, when ANOTHER bot on the same account opens or closes, and when funds
 * are deposited or withdrawn. In practice it produced episode PnLs of
 * +12,345 INR and -12,739 INR on positions worth 12 USDT, and three bots
 * closing at the same instant each claimed the same wallet movement as their
 * own profit.
 *
 * positions/history gives realizedProfit per position, computed by the
 * exchange. It is GROSS of commission (verified: it equals
 * (exit - entry) x qty exactly), and no endpoint reports the fee, so the
 * commission is modelled from the contract's own maker/taker rates.
 */
async function realisedPnlInr(sinceTs) {
  if (DRY_RUN || sinceTs === null) return null;

  // The position takes a moment to flip to CLOSED after the exit fills.
  for (let attempt = 0; attempt < 8; attempt++) {
    await new Promise(r => setTimeout(r, 2000));

    const rows = await ex.positionHistory({ symbol: SYMBOL, pageSize: 20 }).catch(() => null);
    if (rows === null) continue;

    // Everything this episode closed. Adds (L2+) merge into one position on
    // the exchange, but a mid-episode flatten can leave more than one, so
    // sum rather than take the newest. `countedPositions` stops a position
    // being booked twice if two exit paths both report the same close.
    const mine = rows.filter(r =>
      r.positionStatus !== 'OPEN' &&
      Date.parse(r.updatedAt) >= sinceTs - 2000 &&
      !countedPositions.has(r.positionId));
    if (!mine.length) continue;

    let gross = 0, fees = 0, liquidated = 0;
    for (const r of mine) {
      countedPositions.add(r.positionId);
      const rate = +r.marginSettlementRate || INR_RATE;
      gross += r.realizedProfitInMarginAsset !== null && r.realizedProfitInMarginAsset !== undefined
        ? +r.realizedProfitInMarginAsset
        : +r.realizedProfit * rate;

      // Entries rest at the touch (maker); exits cross it (taker). An exit
      // that filled passively pays less than this, so the estimate is on
      // the cautious side.
      const c = ex.contract(SYMBOL);
      const maker = (c ? +c.makerFee : 0.02) / 100;
      const taker = (c ? +c.takerFee : 0.06) / 100;
      // NOT positionSize: on a closed row that is the leftover size (0.0001),
      // not what was traded. Entry notional is quantity x entryPrice.
      const notionalInr = Math.abs(+r.quantity * +r.entryPrice) * rate;
      if (isFinite(notionalInr)) fees += notionalInr * (maker + taker);

      if (r.positionStatus === 'LIQUIDATED') liquidated++;
    }

    if (liquidated > 0) {
      error('='.repeat(66));
      error(`LIQUIDATED — ${liquidated} position(s) on ${SYMBOL} were closed by the exchange,`);
      error('  not by this bot. The margin on them is gone. Check --sl and position size.');
      error('='.repeat(66));
    }

    // Keep the set from growing without bound over a long-running session.
    if (countedPositions.size > 400) {
      for (const id of [...countedPositions].slice(0, 200)) countedPositions.delete(id);
    }
    return gross - fees;
  }
  return null;
}

async function finishEpisodeSettled(estimate, price, { reason = 'other' } = {}) {
  const settled = await realisedPnlInr(episodeStartTs);
  if (settled !== null) {
    const line = `realised PnL: ${signed(settled)} INR from the exchange's position history ` +
                 `(estimate was ${signed(estimate)}, difference ${signed(settled - estimate)} = fees + funding)`;
    settled >= 0 ? ok(line) : warn(line);
  } else {
    warn(`could not read realised PnL for ${SYMBOL} — falling back to the estimate ${signed(estimate)} INR`);
  }
  // Forward the reason: without it every close routed through here lands in
  // the MAE log as 'other', which hid the time exits entirely.
  finishEpisode(settled !== null ? settled : estimate, price, { reason });
}

/**
 * `flip: false` is only for handleRestingFireDuringAdd: when the in-flight
 * add turns out to have filled anyway, that fill happened in THIS episode's
 * direction (it was placed as one of its levels), not the new one. Flipping
 * before recording it would book — and then price the resting orders for —
 * the wrong side entirely, leaving the bot's own bookkeeping inconsistent
 * with what the exchange actually holds. The flip that was skipped here
 * happens for real once this carried-over mini-episode itself closes.
 */
/**
 * Current account equity in USDT: wallet balance plus floating PnL on every
 * open position. The API doesn't report unrealised PnL, so it's computed
 * from each position's entry against its live mark price.
 * Returns null if anything can't be read — callers must treat that as
 * "unknown", never as zero.
 */
/**
 * Wallet + open positions, shared between every bot on this account.
 *
 * Whichever bot asks first while the cache is stale does the two API calls
 * and writes the result; the rest read the file. With 10+ bots polling every
 * 20s the naive version issued hundreds of requests a minute against a
 * 60/min ceiling — this collapses that to roughly two.
 */
function readSnapshotFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(ACCOUNT_SNAPSHOT, 'utf8'));
    if (raw && isFinite(raw.wallet) && isFinite(raw.ts)) return raw;
  } catch (e) { /* missing, or caught mid-write */ }
  return null;
}

async function accountSnapshot({ maxAgeMs = SNAPSHOT_TTL_MS, baselineTs = null } = {}) {
  const cached = readSnapshotFile();
  // A snapshot taken against a different baseline has the wrong realised
  // total in it, however fresh it is — banking moves the baseline forward.
  const sameBaseline = !baselineTs || (cached && cached.baselineTs === baselineTs);
  if (cached && sameBaseline && Date.now() - cached.ts < maxAgeMs) return cached;

  // Every bot's timer fires on its own 20s cycle, so they all find the file
  // stale at roughly the same moment. Without this lock they would all
  // refresh together and the burst — not the average — is what trips the
  // rate limit. One refreshes; the rest reuse the slightly older figures.
  let holdingLock = false;
  try {
    fs.writeFileSync(SNAPSHOT_LOCK, String(process.pid), { flag: 'wx' });
    holdingLock = true;
  } catch (e) {
    let lockAge = Infinity;
    try { lockAge = Date.now() - fs.statSync(SNAPSHOT_LOCK).mtimeMs; } catch (e2) { /* vanished */ }
    if (lockAge < LOCK_STALE_MS) {
      // Someone else is fetching. Older figures beat a 429 — but NEVER older
      // than the caller asked for. reconcile() requests 2s-fresh data before
      // it will declare a position gone; handing it a 60s-old snapshot made
      // it cancel the take-profit on a position that had just been opened,
      // leaving it live with no exit.
      const limit = Math.min(maxAgeMs, SNAPSHOT_MAX_AGE_MS);
      if (cached && Date.now() - cached.ts < limit) return cached;
      return null;
    }
    // The lock outlived a crashed holder — take it over.
    try { fs.writeFileSync(SNAPSHOT_LOCK, String(process.pid)); holdingLock = true; } catch (e2) { /* ignore */ }
  }

  try {
    return await fetchSnapshot(baselineTs);
  } finally {
    if (holdingLock) { try { fs.unlinkSync(SNAPSHOT_LOCK); } catch (e) { /* ignore */ } }
  }
}

async function fetchSnapshot(baselineTs) {
  const wallet = await ex.walletBalance().catch(() => null);
  if (wallet === null) return null;
  const pos = await ex.positions('OPEN').catch(() => null);
  if (pos === null) return null;

  // Realised PnL for the WHOLE account since the round began, straight from
  // the exchange. startTimestamp keeps this to the handful of rows that
  // matter — the unfiltered call returns ~2,900 rows / 2 MB.
  let realisedInr = null;
  if (baselineTs) {
    const hist = await ex.positionHistory({ startTimestamp: baselineTs }).catch(() => null);
    if (hist === null) return null;
    realisedInr = 0;
    for (const r of hist) {
      if (r.positionStatus === 'OPEN') continue;
      if (Date.parse(r.updatedAt) < baselineTs) continue;
      const rate = +r.marginSettlementRate || INR_RATE;
      realisedInr += r.realizedProfitInMarginAsset !== null && r.realizedProfitInMarginAsset !== undefined
        ? +r.realizedProfitInMarginAsset
        : +r.realizedProfit * rate;
      const c = ex.contract(String(r.contractPair || '').toUpperCase());
      const maker = (c ? +c.makerFee : 0.02) / 100;
      const taker = (c ? +c.takerFee : 0.06) / 100;
      const notionalInr = Math.abs(+r.quantity * +r.entryPrice) * rate;
      if (isFinite(notionalInr)) realisedInr -= notionalInr * (maker + taker);
    }
  }

  const list = Array.isArray(pos) ? pos : (pos.data || pos.positions || []);
  const snap = { ts: Date.now(), wallet, baselineTs: baselineTs || null, realisedInr,
                 raw: Array.isArray(list) ? list : [] };
  // Write via a temp file so a concurrent reader never sees a half-written one.
  try {
    const tmp = ACCOUNT_SNAPSHOT + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(snap));
    fs.renameSync(tmp, ACCOUNT_SNAPSHOT);
  } catch (e) { /* the value is still usable even if caching failed */ }
  return snap;
}


/**
 * The banking baseline is SHARED between every bot on the account. If each
 * kept its own, they would re-baseline at slightly different instants after
 * a flatten — different fills, different fees — and drift apart, so they'd
 * stop tripping together and "close all trades" would stop meaning it.
 */
function readSharedBaseline() {
  try {
    const raw = JSON.parse(fs.readFileSync(BANK_BASELINE, 'utf8'));
    if (raw && isFinite(raw.ts)) return raw;
  } catch (e) { /* not written yet */ }
  return null;
}

/**
 * The baseline is the INSTANT a round began — not an equity figure.
 *
 * It used to store wallet + floating PnL and measure the change against it.
 * That silently counted anything that moved the balance: a deposit read as
 * pure profit (one landed and the bots instantly banked a phantom +11,059
 * INR, flattening the whole book), a withdrawal would read as an equal loss
 * and trip --max-loss, and margin locking on every entry moved it constantly.
 *
 * A timestamp cannot be distorted that way. Net is realised PnL booked by
 * the exchange since that moment, plus what is floating right now.
 */
function writeSharedBaseline(ts, round) {
  try {
    const tmp = BANK_BASELINE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ ts, round, written: Date.now() }));
    fs.renameSync(tmp, BANK_BASELINE);
  } catch (e) { warn(`could not write the shared baseline: ${e.message}`); }
}

/**
 * Account-wide session PnL in INR, or null while unknown. This is what the
 * gain/loss caps test — NOT sessionRealisedInr, which counts only this
 * symbol's closed episodes.
 */
async function accountPnlInr() {
  const shared = readSharedBaseline();
  if (shared === null) return null;

  const snap = await accountSnapshot({ baselineTs: shared.ts });
  if (snap === null || !isFinite(snap.realisedInr)) return null;

  // Floating on what is still open, priced off the websocket feed. Entry vs
  // mark is unaffected by margin locking or deposits, so this half is safe.
  let floating = 0;
  for (const p of snap.raw) {
    const sym = String(p.contractPair || p.symbol || p.name || '').toUpperCase().replace(/[-_]/g, '');
    const qty = Math.abs(parseFloat(p.quantity ?? p.positionAmt ?? p.size));
    const entry = parseFloat(p.entryPrice ?? p.avgPrice);
    if (!sym || !isFinite(qty) || !isFinite(entry) || qty <= 0 || entry <= 0) continue;
    const mark = sym === SYMBOL && lastPrice !== null ? lastPrice : feedPrices.get(sym);
    if (!isFinite(mark) || mark <= 0) return null;      // unpriced: never guess
    const long = String(p.positionType || '').toUpperCase() !== 'SHORT';
    floating += (long ? (mark - entry) : (entry - mark)) * qty;
  }
  const floatingInr = floating * INR_RATE;

  // Both halves, separately. --bail-at wants the sum; --bail-floating wants
  // the floating half on its own, with realised history excluded so banked
  // profit cannot mask a drawdown on what is open.
  return { total: snap.realisedInr + floatingInr, floating: floatingInr };
}

/**
 * Claims the right to INITIATE a round, atomically across processes.
 *
 * Every bot checks the same shared net on the same 20s tick and reads the
 * same cached snapshot, so without this they all cross the target together
 * and all initiate — 13 bots each bumping the round and each flattening on
 * its own authority. An exclusive create is the only thing here that is
 * atomic across processes, so the round number becomes a filename and the
 * first bot to create it wins.
 */
function claimBankRound(round) {
  const file = bankClaimFile(round);
  try {
    fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
    return true;
  } catch (e) {
    // The claim exists. If its owner is gone — crashed mid-bank, or killed —
    // the file would otherwise block this round forever, and since
    // bankedRounds never advances past a round nobody completes, banking
    // would be dead for every bot on the account with nothing logged.
    let owner = null;
    try { owner = parseInt(fs.readFileSync(file, 'utf8').trim(), 10); } catch (e2) { /* unreadable */ }
    if (owner && owner !== process.pid && processAlive(owner)) return false;

    warn(`clearing a stale bank claim for round ${round} (PID ${owner || 'unknown'} is gone)`);
    try {
      fs.unlinkSync(file);
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
      return true;
    } catch (e2) {
      return false;                     // another bot took it in the meantime
    }
  }
}

/** Drops claim files from rounds well behind us. */
function tidyBankClaims(round) {
  for (let r = round - 4; r < round - 1; r++) {
    if (r >= 0) { try { fs.unlinkSync(bankClaimFile(r)); } catch (e) { /* already gone */ } }
  }
}

/**
 * Picks up a bank round started by another bot on the same account.
 *
 * "Close all trades" has to mean all of them. Each bot can only flatten its
 * own symbol, so whichever one first sees the shared net cross the target
 * bumps the round in the shared file and the rest follow it here. Merely
 * adopting the new baseline — which is what this used to do — left every
 * other bot holding its position with the profit already counted as banked.
 */
async function syncBankRound() {
  const shared = readSharedBaseline();
  if (!shared) return;

  if (shared.round > bankedRounds) {
    const from = bankedRounds;
    bankedRounds = shared.round;
    if (BANK_AT_INR === null) return;             // not banking; just stay in step
    ok(`another bot banked (round ${from} -> ${shared.round}) — flattening ${SYMBOL} to match`);
    await bankAndRestart(null, { follower: true });
  }
}

/**
 * Flattens this bot's position with reduce-only marketable limits, re-pricing
 * up to 5 times if the touch walks away, then re-baselines equity so the next
 * round measures its own target. Mirrors stopLoss's proven exit loop rather
 * than inventing a second one.
 *
 * With several bots on one account they all read the same account-wide net,
 * so they trip together and the whole book flattens — "close all trades".
 */
async function bankAndRestart(netInr, { follower = false, bail = false } = {}) {
  if (flattening || DRY_RUN) return;
  flattening = true;
  exiting = true;
  reconcileSuppressedUntil = Date.now() + 180000;
  try {
    if (bail) {
      warn(`BAILING OUT — flattening ${SYMBOL} because the account passed its bail threshold `
         + `(${BAIL_AT_INR !== null ? '--bail-at ' + BAIL_AT_INR : ''}`
         + `${BAIL_AT_INR !== null && BAIL_FLOATING_INR !== null ? ' / ' : ''}`
         + `${BAIL_FLOATING_INR !== null ? '--bail-floating ' + BAIL_FLOATING_INR : ''} INR)`);
    } else if (!follower) {
      bankedRounds++;
      // Publish the round FIRST. Flattening a position takes seconds, and
      // until the other bots know, they are still holding theirs. The
      // baseline moves to NOW only once the exits have landed — see below —
      // so the profit being banked is not erased before it is counted.
      writeSharedBaseline(readSharedBaseline().ts, bankedRounds);
      ok(`BANKING ${signed(netInr)} INR net (target ${BANK_AT_INR}) — flattening ${SYMBOL} ` +
         `and signalling every other bot to flatten too (round ${bankedRounds})`);
    }

    restingTp = null; restingSl = null;
    try {
      const cleared = await ex.cancelAllOrders(SYMBOL);
      if (cleared.found > 0) info(`cleared ${cleared.cancelled}/${cleared.found} resting order(s)`);
    } catch (e) { warn(`could not clear resting orders: ${e.message}`); }

    let remaining = closableQty(await ex.positionSize(SYMBOL).catch(() => null));
    if (remaining && remaining > 0) {
      const c = ex.contract(SYMBOL);
      const { avgEntry } = book();
      for (let attempt = 1; attempt <= 5; attempt++) {
        const q = await ex.bestQuote(SYMBOL).catch(() => null);
        const ref = q ? (isLong() ? q.bid : q.ask) : lastPrice;
        if (!ref) break;
        const px = isLong()
          ? ex.floorTo(ref * (1 - EXIT_BUFFER_PCT / 100), c.pricePrecision)
          : ceilTo(ref * (1 + EXIT_BUFFER_PCT / 100), c.pricePrecision);
        const qty = ex.floorTo(remaining, c.quantityPrecision);
        if (qty <= 0) break;
        const res = await ex.placeLimit({
          symbol: SYMBOL, side: exitSide(), quantity: qty, price: px, reduceOnly: true,
        });
        trade(`${exitSide()} ${qty} ${SYMBOL} @ ${fmt(px)} reduce-only · order ${res.clientOrderId} ` +
              `(bank flatten ${attempt}/5)`);
        const done = await waitForClose(res.clientOrderId);
        if (done.closed) {
          const realised = (isLong() ? (px - avgEntry) : (avgEntry - px)) * qty * INR_RATE;
          writeTrade({
            level: 'EXIT', side: exitSide(), qty, price: px, notional: qty * px,
            dipPct: null, pnl: realised, clientOrderId: res.clientOrderId, note: 'bank and restart',
          });
          const settled = await realisedPnlInr(episodeStartTs);
          finishEpisode(settled !== null ? settled : realised, px, { reason: 'bank' });
          remaining = 0;
          break;
        }
        remaining = done.remaining !== null ? done.remaining : remaining;
        try { await ex.cancelOrder(res.clientOrderId); } catch (e) { /* may have filled */ }
        await new Promise(r => setTimeout(r, 1500));
      }
      if (remaining && remaining > 0) {
        error('='.repeat(66));
        error(`BANK FLATTEN FAILED on ${SYMBOL} — ~${remaining} units STILL OPEN.`);
        error('  Close it on Shark yourself. The bot keeps running but this position is unmanaged.');
        error('='.repeat(66));
      }
    } else {
      info('nothing open on this symbol to flatten');
    }

    if (bail) {
      // Nothing to re-baseline: bailing ends the session rather than opening
      // the next round. The halt below cancels whatever is still resting.
      ok(`flattened ${SYMBOL} — bailing out`);
    } else if (follower) {
      // The bot that started the round settles the final baseline for
      // everyone; a follower would only race it with a different number.
      ok(`flattened ${SYMBOL} for round ${bankedRounds} — baseline follows the bot that banked`);
    } else {
      // Let the followers' exits land and be recorded by the exchange before
      // moving the mark; anything closed after it counts towards the NEXT
      // round, so cutting over too early would drop this round's profit.
      await new Promise(r => setTimeout(r, BANK_SETTLE_MS));
      writeSharedBaseline(Date.now(), bankedRounds);
      tidyBankClaims(bankedRounds);
      ok(`re-baselined at ${new Date().toISOString().slice(11, 19)} UTC — the next round ` +
         `counts only what is realised from here, targeting ${BANK_AT_INR} INR ` +
         `(shared with every bot on this account)`);
    }
    lastCapCheck = Date.now();
  } catch (e) {
    error(`bank-and-restart failed: ${e.message}`);
  } finally {
    flattening = false;
    exiting = false;
  }
}

/**
 * Trips --max-gain / --max-loss on ACCOUNT equity, including floating PnL.
 * Runs on a timer, not only at episode close, so a cap can fire while a
 * losing position is still open — the case the old check could never see.
 * Parks rather than fully stopping: resting take-profits stay live.
 */
async function checkAccountCaps() {
  if (halted || DRY_RUN) return;
  if (MAX_LOSS_INR === null && MAX_GAIN_INR === null &&
      BANK_AT_INR === null && BAIL_AT_INR === null && BAIL_FLOATING_INR === null) return;
  if (Date.now() - lastCapCheck < 20000) return;
  lastCapCheck = Date.now();

  // syncBankRound() owns adopting the shared round — reading it here and
  // bumping bankedRounds first would hide the very difference it looks for,
  // and every bot would then initiate its own round instead of following.
  await syncBankRound();
  if (flattening) return;

  const net = await accountPnlInr();
  if (net === null) return;                       // unknown — never guess
  const pnl = net.total;
  const floatingPnl = net.floating;

  // Banking runs BEFORE the hard caps: it flattens and keeps trading, so it
  // should get the chance to take a modest net before --max-gain would stop
  // the bot outright.
  if (BANK_AT_INR !== null && pnl >= BANK_AT_INR && !flattening) {
    if (claimBankRound(bankedRounds + 1)) {
      await bankAndRestart(pnl);
    } else {
      // Another bot owns this round. Follow it rather than starting a
      // second one on the same profit.
      await syncBankRound();
    }
    return;
  }

  // --bail-at: CLOSE EVERYTHING and stop. The mirror of --bank-at, and
  // distinct from --max-loss, which only parks: parking leaves open positions
  // live with nothing managing them, which is the opposite of what a loss cap
  // is usually meant to do.
  //
  // Coordinated through a switch file rather than the round-claim mechanism.
  // Every bot sees the file within one check, including bots that were busy
  // placing an order when the threshold was crossed, and a bot that starts
  // later still finds it.
  // --bail-floating: the same flatten-and-stop, triggered on the OPEN book
  // alone. Checked before --bail-at because it is the tighter guard: it fires
  // on a drawdown in progress rather than waiting for the session as a whole
  // to go underwater.
  //
  // It shares BAIL_FILE with --bail-at, so the coordination is identical —
  // one bot writes it, every other bot sees it within one 20s check, and the
  // file then blocks startup until a human clears it.
  if (BAIL_FLOATING_INR !== null && !flattening) {
    const alreadyBailing = fs.existsSync(BAIL_FILE);
    if (floatingPnl <= -BAIL_FLOATING_INR && !alreadyBailing) {
      try {
        fs.writeFileSync(BAIL_FILE,
          `open positions floating ${signed(floatingPnl)} INR passed ` +
          `-${BAIL_FLOATING_INR} at ${new Date().toISOString()}\n` +
          `(session net including realised was ${signed(pnl)} INR)\n` +
          `tripped by ${SYMBOL} (pid ${process.pid}) via --bail-floating\n`);
        error('='.repeat(70));
        error(`BAIL-OUT (floating) — open positions are ${signed(floatingPnl)} INR, ` +
              `past -${BAIL_FLOATING_INR}.`);
        error('  Every bot on this account is closing its position and stopping.');
        error(`  Delete ${path.basename(BAIL_FILE)} before restarting, or they refuse to start.`);
        error('='.repeat(70));
        // Only the bot that WON the exclusive write alerts. The other eight
        // see the file and flatten too, but nine identical messages would
        // make the channel useless.
        alert(`BAIL-OUT (floating) — open positions ${signed(floatingPnl)} INR past ` +
              `-${BAIL_FLOATING_INR}. All bots flattening and stopping. ` +
              `They will NOT restart until FINALEPIC_BAIL is deleted.`);
      } catch (e) { error(`could not write the bail switch: ${e.message}`); }
    }
    if (alreadyBailing || floatingPnl <= -BAIL_FLOATING_INR) {
      await bankAndRestart(pnl, { bail: true });
      await halt(`--bail-floating ${BAIL_FLOATING_INR} INR — open positions ` +
                 `${signed(floatingPnl)} INR, positions closed`, { keepOrders: false });
      return;
    }
  }

  if (BAIL_AT_INR !== null && !flattening) {
    const alreadyBailing = fs.existsSync(BAIL_FILE);
    if (pnl <= -BAIL_AT_INR && !alreadyBailing) {
      try {
        fs.writeFileSync(BAIL_FILE,
          `account net ${signed(pnl)} INR passed -${BAIL_AT_INR} at ${new Date().toISOString()}\n` +
          `tripped by ${SYMBOL} (pid ${process.pid})\n`);
        error('='.repeat(70));
        error(`BAIL-OUT — account net ${signed(pnl)} INR is past -${BAIL_AT_INR}.`);
        error('  Every bot on this account is closing its position and stopping.');
        error(`  Delete ${path.basename(BAIL_FILE)} before restarting, or they refuse to start.`);
        error('='.repeat(70));
        alert(`BAIL-OUT (session) — account net ${signed(pnl)} INR past -${BAIL_AT_INR}. ` +
              `All bots flattening and stopping. ` +
              `They will NOT restart until FINALEPIC_BAIL is deleted.`);
      } catch (e) { error(`could not write the bail switch: ${e.message}`); }
    }
    if (alreadyBailing || pnl <= -BAIL_AT_INR) {
      await bankAndRestart(pnl, { bail: true });
      await halt(`--bail-at ${BAIL_AT_INR} INR — account net ${signed(pnl)} INR, positions closed`,
                 { keepOrders: false });
      return;
    }
  }

  if (MAX_LOSS_INR !== null && pnl <= -MAX_LOSS_INR) {
    await halt(`--max-loss ${MAX_LOSS_INR} INR reached — ACCOUNT equity ${signed(pnl)} INR ` +
               `(includes floating PnL on open positions)`, { keepOrders: true });
    return;
  }
  if (MAX_GAIN_INR !== null && pnl >= MAX_GAIN_INR) {
    await halt(`--max-gain ${MAX_GAIN_INR} INR reached — ACCOUNT equity ${signed(pnl)} INR ` +
               `(includes floating PnL on open positions)`, { keepOrders: true });
  }
}

/**
 * One row per closed episode: how far the trade went against us before it
 * resolved (MAE) and how far in favour (MFE), against what it actually paid.
 *
 * This is the evidence a stop-loss decision needs. A stop has to sit beyond
 * the drawdown that WINNERS routinely survive, otherwise it converts them
 * into losses — measuring 24h of history showed 99% of winners go underwater
 * first, by a median 0.73%, against a target of roughly 0.45%. Recording it
 * live is exact: the extremes come from every websocket tick, so wicks that
 * never close in a candle are still caught.
 */
function writeMaeRow(pnl, exitPrice, reason) {
  if (DRY_RUN || openLongs.length === 0) return;
  if (episodeWorstPrice === null || episodeBestPrice === null) return;

  const { totalQty, avgEntry } = aggregate();
  if (!(totalQty > 0) || !(avgEntry > 0)) return;

  const long = isLong();
  const maePct = (long ? (avgEntry - episodeWorstPrice) : (episodeWorstPrice - avgEntry)) / avgEntry * 100;
  const mfePct = (long ? (episodeBestPrice - avgEntry) : (avgEntry - episodeBestPrice)) / avgEntry * 100;
  const notionalInr = totalQty * avgEntry * INR_RATE;
  const heldSec = firstEntryTs ? ((Date.now() - firstEntryTs) / 1000).toFixed(0) : '';

  const row = [
    new Date().toISOString(), SYMBOL, episode, direction, level, totalQty, avgEntry,
    exitPrice ?? '', notionalInr.toFixed(2),
    // Clamp at zero: a trade that never traded against us has no adverse
    // excursion, and a small negative here is just the entry buffer.
    Math.max(0, maePct).toFixed(4), (Math.max(0, maePct) / 100 * notionalInr).toFixed(2),
    Math.max(0, mfePct).toFixed(4), (Math.max(0, mfePct) / 100 * notionalInr).toFixed(2),
    pnl === null ? '' : pnl.toFixed(2),
    pnl === null ? 'unknown' : (pnl > 0 ? 'win' : 'loss'),
    reason || 'other',
    heldSec,
  ].join(',');

  try {
    if (!fs.existsSync(MAE_LOG)) {
      fs.writeFileSync(MAE_LOG, MAE_HEADER);
    } else {
      // A file written by an older build has fewer columns than the rows we
      // are about to append, which silently shifts every field after the
      // mismatch — the analyser would read exit_reason as held_sec. Move the
      // old file aside rather than corrupt it.
      const first = fs.readFileSync(MAE_LOG, 'utf8').split('\n', 1)[0] + '\n';
      if (first !== MAE_HEADER) {
        const aside = MAE_LOG.slice(0, -4) + '-' + Date.now() + '.csv';
        fs.renameSync(MAE_LOG, aside);
        fs.writeFileSync(MAE_LOG, MAE_HEADER);
        warn(`MAE log had an older column layout — kept it as ${path.basename(aside)} ` +
             `and started a new one`);
      }
    }
    fs.appendFileSync(MAE_LOG, row + '\n');
  } catch (e) { warn(`could not write the MAE log: ${e.message}`); }
}

function finishEpisode(pnl, price, { flip = true, reason = 'other' } = {}) {
  writeMaeRow(pnl, price, reason);

  if (pnl !== null) {
    sessionRealisedInr += pnl;
    closedEpisodes++;
    ok(`episode ${episode} (${direction}) closed: ${signed(pnl)} INR · ` +
       `session ${signed(sessionRealisedInr)} INR over ${closedEpisodes} episode(s)`);
  }

  openLongs.length = 0;
  level = 0;
  nextHoldCheckTs = null;
  holdChecksSurvived = 0;
  episodeWorstPrice = null;
  episodeBestPrice = null;
  firstEntryTs = null;
  exchangePos = null;
  exitFailures = 0;
  restingTp = null;
  restingSl = null;
  resetDipState();
  episode++;

  if (DIRECTION_MODE === 'hourlybias') {
    // Direction gets read fresh from the hourly candle at the start of the
    // next episode instead of being flipped or carried over — clear the
    // state so that read actually happens rather than reusing a stale one.
    hourlyInvalidation = null;
    hourlyBestPrice = null;
  } else if (ALTERNATE && flip) {
    // Flip sides. A long only reaches its target on a rally, which leaves
    // price extended — so the next episode sells that strength rather than
    // buying into it, and vice versa. This fires on EVERY completed
    // episode, including one closed outside the bot, so the alternation
    // never depends on how the previous one happened to end.
    direction = isLong() ? 'SHORT' : 'LONG';
    info(`side flips to ${direction} for episode ${episode}`);
  } else if (ALTERNATE && !flip) {
    info(`side stays ${direction} for episode ${episode} — continuing a race-carried fill`);
  }

  if (!DRY_RUN) {
    ex.cancelAllOrders(SYMBOL).catch(e => warn(`post-exit cleanup failed: ${e.message}`));
  }

  if (ONCE) { halt('--once: take-profit reached').catch(() => {}); return; }
  if (MAX_EPISODES > 0 && closedEpisodes >= MAX_EPISODES) {
    halt(`--max-episodes ${MAX_EPISODES} reached`).catch(() => {});
    return;
  }
  // Caps are evaluated on ACCOUNT equity by the 20s timer (checkAccountCaps),
  // which sees floating PnL too. Nudge it to run now so a cap that the just
  // closed episode pushed over the line trips immediately rather than in up
  // to 20 seconds. DRY_RUN has no account to read, so it keeps using the
  // realised-only figures.
  if (DRY_RUN) {
    if (MAX_LOSS_INR !== null && sessionRealisedInr <= -MAX_LOSS_INR) {
      halt(`--max-loss ${MAX_LOSS_INR} INR reached (session ${signed(sessionRealisedInr)} INR)`).catch(() => {});
      return;
    }
    if (MAX_GAIN_INR !== null && sessionRealisedInr >= MAX_GAIN_INR) {
      halt(`--max-gain ${MAX_GAIN_INR} INR reached (session ${signed(sessionRealisedInr)} INR)`).catch(() => {});
      return;
    }
  } else {
    lastCapCheck = 0;
    checkAccountCaps().catch(() => {});
  }
  if (COOLDOWN_MIN > 0) {
    cooldownUntil = Date.now() + COOLDOWN_MIN * 60000;
    info(`cooling down ${COOLDOWN_MIN} min before the next episode`);
  } else {
    info(`re-arming immediately — episode ${episode} opens on the next tick from ${fmt(price)}`);
  }
}

// ─── Reconciliation ──────────────────────────────────────────────────────

async function refreshExchangePos({ fresh = false } = {}) {
  if (DRY_RUN) return;
  // Shares the account snapshot with the equity checks — polling positions
  // separately doubled the request rate for no new information.
  const snap = await accountSnapshot(fresh ? { maxAgeMs: 2000 } : {});
  if (!snap) return;
  applyPositionSnapshot(snap);
}

/** Pulls this bot's own symbol out of a shared snapshot into `exchangePos`. */
function applyPositionSnapshot(snap) {
  for (const p of snap.raw) {
    const sym = String(p.contractPair || p.symbol || p.name || '').toUpperCase().replace(/[-_]/g, '');
    if (sym !== SYMBOL) continue;
    const rawQty = parseFloat(p.positionAmt ?? p.quantity ?? p.positionAmount ?? p.size);
    const qty = Math.abs(rawQty);
    const entry = parseFloat(p.entryPrice ?? p.avgPrice);
    // Prefer the explicit positionType Shark returns; fall back to the sign
    // of the quantity when it isn't present.
    const rawSide = String(p.positionType ?? '').toUpperCase();
    const side = (rawSide === 'LONG' || rawSide === 'SHORT')
      ? rawSide
      : (isFinite(rawQty) && rawQty < 0 ? 'SHORT' : 'LONG');
    if (isFinite(qty) && qty > 0 && isFinite(entry) && entry > 0) {
      exchangePos = { qty, entryPrice: entry, side, ts: Date.now() };
    }
    return;
  }
  exchangePos = null;
}

/** Detects a position closed outside the bot, so it stops managing a ghost. */
async function reconcile() {
  if (DRY_RUN || openLongs.length === 0) return;
  if (exiting || placing) return;
  if (Date.now() < reconcileSuppressedUntil) return;
  if (Date.now() - lastReconcile < 30000) return;
  lastReconcile = Date.now();

  const snap = await accountSnapshot({ maxAgeMs: 2000 });
  if (snap === null) return;                       // unknown — never act on a guess
  applyPositionSnapshot(snap);

  const actual = exchangePos ? exchangePos.qty : 0;
  const expected = aggregate().totalQty;
  if (actual >= expected * 0.95) return;

  if (actual === 0) {
    // Declaring a position gone is destructive: it cancels the resting
    // take-profit and clears the book. A shared snapshot can be stale or
    // mid-write, so confirm against the exchange before acting on it.
    const confirmed = await ex.positionSize(SYMBOL).catch(() => null);
    if (confirmed === null) return;                 // unknown: try again later
    if (confirmed > 0) {
      warn(`snapshot said ${SYMBOL} was flat but the exchange holds ${confirmed} — ` +
           `ignoring the stale reading and keeping the position managed`);
      return;
    }

    // This is the normal path by which a resting order's fill gets noticed
    // when nothing else was already watching for it (no add was mid-flight
    // — that race is handled directly in openLevel instead). Check which
    // one actually vanished before clearing either, purely for the log.
    const tpGone = restingTp && !(await tpStillResting());
    const slGone = restingSl && !(await slStillResting());
    warn(`position on ${SYMBOL} is GONE (expected ${expected}) — ` +
         (tpGone && slGone ? 'both resting orders are gone (unclear which filled first)'
          : tpGone ? 'the resting take-profit filled'
          : slGone ? 'the resting stop loss filled'
          : 'closed outside the bot'));
    // Most take-profits are noticed HERE rather than watched to completion,
    // so recording them all as 'external' would hide nearly every genuine TP
    // from the MAE study — which exists precisely to measure what winners
    // endured on the way to target. Label by which order actually vanished.
    const closeReason = (tpGone && slGone) ? 'ambiguous'
                      : tpGone ? 'tp'
                      : slGone ? 'sl'
                      : 'external';
    restingTp = null;
    restingSl = null;
    // realisedPnlInr() can take up to ~16s (it polls the position history
    // until the close is recorded) before finishEpisode() actually clears
    // openLongs. Reusing the `exiting` flag for that whole window stops
    // onPrice()'s reactive fallback (gated on !exiting) from firing a
    // second, redundant close on the same already-closing position in
    // the meantime — it would otherwise see restingTp already null and
    // openLongs still stale, and race finishEpisode with its own.
    exiting = true;
    try {
      const settled = await realisedPnlInr(episodeStartTs);
      if (settled !== null) info(`realised PnL from the position history: ${signed(settled)} INR`);
      try {
        const r = await ex.cancelAllOrders(SYMBOL);
        if (r.found > 0) warn(`cancelled ${r.cancelled}/${r.found} orphaned order(s)`);
      } catch (e) {
        error(`cleanup failed: ${e.message} — check open orders manually`);
      }
      writeTrade({
        level: 'EXTERNAL', side: exitSide(), qty: expected, price: lastPrice ?? '',
        notional: '', dipPct: null, pnl: settled ?? '', clientOrderId: '',
        note: 'closed outside the bot',
      });
      finishEpisode(settled, lastPrice ?? 0, { reason: closeReason });
    } finally {
      exiting = false;
    }
  } else {
    warn(`size mismatch on ${SYMBOL}: exchange ${actual}, bot expected ${expected} — syncing`);
    const scale = actual / expected;
    for (const p of openLongs) p.qty = ex.floorTo(p.qty * scale, 8);
    if (restingTp) {
      await replaceRestingTp('resyncing the resting take-profit after a size mismatch')
        .catch(e => error(`could not resync the resting take-profit: ${e.message}`));
    }
    if (restingSl) {
      await replaceRestingSl('resyncing the resting stop loss after a size mismatch')
        .catch(e => error(`could not resync the resting stop loss: ${e.message}`));
    }
  }
}

// ─── Trade log ───────────────────────────────────────────────────────────

function writeTrade({ level: n, side, qty, price, notional, dipPct, pnl, clientOrderId, note }) {
  const row = [
    new Date().toISOString(), SYMBOL, episode, direction, n, side, qty, price,
    typeof notional === 'number' ? notional.toFixed(4) : notional,
    dipPct === null || dipPct === undefined ? '' : dipPct.toFixed(4),
    dipBarPct().toFixed(4),
    typeof pnl === 'number' ? pnl.toFixed(2) : pnl,
    clientOrderId, String(note).replace(/,/g, ';'), DRY_RUN,
  ];
  try { fs.appendFileSync(TRADE_LOG, row.join(',') + '\n'); } catch (e) { /* keep trading */ }
}

// ─── Websocket ───────────────────────────────────────────────────────────

function startFeed() {
  socket = io(WS_PUBLIC, {
    transports: ['websocket', 'polling'],
    reconnection: true, reconnectionDelay: 500, reconnectionDelayMax: 5000,
    reconnectionAttempts: Infinity, timeout: 20000,
  });

  socket.on('connect', () => {
    info('feed: connected');
    socket.emit('subscribe', { params: ['markPriceArr'] });
  });
  socket.on('disconnect', () => warn('feed: disconnected — reconnecting'));
  socket.on('connect_error', e => warn(`feed error: ${e.message}`));

  socket.on('markPriceArr', msg => {
    const arr = Array.isArray(msg) ? msg : (msg && (msg.data || msg.result));
    if (!Array.isArray(arr)) return;
    // The feed already carries EVERY symbol. Cache them all: pricing other
    // bots' open positions for the account-equity maths used to cost one REST
    // call per position per check, which blew the 60 req/min limit outright
    // once several bots were running.
    for (const item of arr) {
      const raw = item.s || item.symbol || item.contractPair || item.pair;
      if (!raw) continue;
      const sym = String(raw).toUpperCase().replace(/[-_]/g, '');
      const price = parseFloat(item.p || item.markPrice || item.price || item.c);
      if (!isFinite(price) || price <= 0) continue;
      feedPrices.set(sym, price);
      if (sym === SYMBOL) onPrice(price);
    }
  });
}

/**
 * How much this bot may close: never more than IT opened.
 *
 * Every exit used to size from ex.positionSize(), i.e. everything the
 * account holds on this symbol. With two bots on one symbol that is both
 * positions, so each tried to close the other's too — 231 units became 462,
 * then 924, then 2772, and the overshoot flipped into a fresh position going
 * the other way. Clamping to the bot's own book makes a duplicate merely
 * wasteful instead of destructive.
 */
function closableQty(exchangeQty) {
  const mine = aggregate().totalQty;
  if (!(mine > 0)) return 0;
  if (exchangeQty === null || !isFinite(exchangeQty)) return mine;
  const q = Math.min(exchangeQty, mine);
  if (exchangeQty > mine * 1.01) {
    warn(`exchange holds ${exchangeQty} ${SYMBOL} but this bot opened ${mine} — ` +
         `closing only its own ${q}. Something else is trading this symbol.`);
  }
  return q;
}

/**
 * Publishes this bot's live state for the dashboard. Best-effort and
 * completely non-blocking: a failure here must never affect trading.
 */
function writeStatus() {
  try {
    const { totalQty, avgEntry, totalNotional } = openLongs.length ? book() : { totalQty: 0, avgEntry: 0, totalNotional: 0 };
    const pnl = (totalQty > 0 && lastPrice !== null) ? pnlInrAt(lastPrice) : 0;
    const snap = {
      symbol: SYMBOL,
      pid: process.pid,
      ts: Date.now(),
      startedAt: BOT_STARTED_AT,
      live: !DRY_RUN,
      halted,
      episode,
      direction,
      level,
      maxLevels: MAX_LEVELS,
      lastPrice,
      position: totalQty > 0
        ? { qty: totalQty, avgEntry, notionalUsdt: totalNotional, pnlInr: pnl,
            openedAt: firstEntryTs }
        : null,
      exits: {
        tpTargetInr: exitThresholdInr(),
        tpPrice: totalQty > 0 ? targetPrice() : null,
        restingTp: restingTp ? { price: restingTp.price, qty: restingTp.qty } : null,
        restingSl: restingSl
          ? { stopPrice: restingSl.stopPrice, limitPrice: restingSl.limitPrice ?? null, qty: restingSl.qty }
          : null,
        slInr: SL_INR,
        slLimitInr: SL_LIMIT_INR,
        maxHoldMin: MAX_HOLD_MIN,
        nextHoldCheckTs: nextHoldCheckTs,
        onlyRed: ONLY_RED,
        onlyRedUsdt: ONLY_RED_USDT,
        holdChecksSurvived,
      },
      session: {
        realisedInr: sessionRealisedInr,
        closedEpisodes,
        bankedRounds,
      },
      inrRate: INR_RATE,
    };
    const tmp = statusFile() + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(snap));
    fs.renameSync(tmp, statusFile());
  } catch (e) { /* never let telemetry break the bot */ }
}

// ─── Automatic symbol selection ──────────────────────────────────────────

/**
 * Ranks every USDT contract by how far it has moved over the last
 * --autosymbols-window hours, biggest absolute move first. Gainers and
 * losers both qualify: the ladder trades either direction, and what it needs
 * is a symbol that is MOVING, not one that is rising.
 *
 * ~330 requests at the 60/min limit, so the result is cached and shared.
 * Whichever bot finds the cache stale does the scan behind a lock; the rest
 * wait for it rather than each running their own.
 */
async function scanMovers() {
  const cached = readAutoCache();
  if (cached) return cached;

  let holdingLock = false;
  try {
    fs.writeFileSync(AUTO_LOCK, String(process.pid), { flag: 'wx' });
    holdingLock = true;
  } catch (e) {
    // Another bot is scanning. Wait for it — a second scan would double the
    // request rate for an identical answer.
    info('another bot is scanning for movers — waiting for its result…');
    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const c = readAutoCache();
      if (c) return c;
      if (!fs.existsSync(AUTO_LOCK)) break;      // it died; fall through and scan
    }
    try { fs.unlinkSync(AUTO_LOCK); } catch (e2) { /* ignore */ }
    try { fs.writeFileSync(AUTO_LOCK, String(process.pid), { flag: 'wx' }); holdingLock = true; }
    catch (e2) { /* someone else got it; scan anyway */ }
  }

  try {
    const contracts = await ex.loadContracts();
    const syms = [...contracts.keys()].filter(k => k.endsWith('USDT')).sort();
    const since = Date.now() - Math.max(1, AUTO_WINDOW_H) * 3600000;
    info(`scanning ${syms.length} symbols for the biggest ${AUTO_WINDOW_H}h movers ` +
         `(~${Math.ceil(syms.length * 1.15 / 60)} min — cached ${AUTO_CACHE_TTL_MS / 60000} min for every bot)`);

    const rows = [];
    let done = 0;
    for (const sym of syms) {
      done++;
      try {
        const c = ex.contract(sym);
        if (c && AUTO_MIN_LEV > 0 && +c.maxLeverage < AUTO_MIN_LEV) { await sleep(1150); continue; }
        const k = await ex.klines({ pair: sym, interval: '1h', priceType: 'LAST_PRICE',
                                    startTime: since, endTime: Date.now(), limit: 6 });
        const bars = (k || []).map(r => ({ t: +r.startTime, o: +r.open, h: +r.high, l: +r.low, c: +r.close }))
          .filter(x => [x.o, x.h, x.l, x.c].every(isFinite) && x.o > 0)
          .sort((a, b) => a.t - b.t);
        if (bars.length) {
          const open = bars[0].o, close = bars[bars.length - 1].c;
          const chg = ((close - open) / open) * 100;
          const range = bars.reduce((m, x) => Math.max(m, ((x.h - x.l) / x.o) * 100), 0);
          rows.push({ sym, chg, absChg: Math.abs(chg), range,
                      lev: c ? +c.maxLeverage : 0, price: close });
        }
      } catch (e) { /* skip a bad symbol rather than abort the scan */ }
      if (done % 60 === 0) info(`  …${done}/${syms.length}`);
      await sleep(1150);
    }

    rows.sort((a, b) => b.absChg - a.absChg);
    const payload = { ts: Date.now(), windowH: AUTO_WINDOW_H, rows: rows.slice(0, 40) };
    try {
      const tmp = AUTO_CACHE + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(payload));
      fs.renameSync(tmp, AUTO_CACHE);
    } catch (e) { warn(`could not cache the mover scan: ${e.message}`); }
    return payload;
  } finally {
    if (holdingLock) { try { fs.unlinkSync(AUTO_LOCK); } catch (e) { /* ignore */ } }
  }
}

function readAutoCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(AUTO_CACHE, 'utf8'));
    if (raw && Array.isArray(raw.rows) && Date.now() - raw.ts < AUTO_CACHE_TTL_MS) return raw;
  } catch (e) { /* absent or mid-write */ }
  return null;
}

/**
 * Claims one of the top-N movers for this bot, skipping any already locked
 * by another. Returns the symbol, or null when every candidate is taken.
 *
 * Spread is checked before claiming, because a symbol whose spread is a
 * large fraction of the take-profit target cannot pay out: the entry rests
 * passively and either never fills, or fills and needs the spread back
 * before the target is even reachable.
 */
async function claimAutoSymbol(n) {
  const scan = await scanMovers();
  if (!scan || !scan.rows.length) { error('mover scan produced nothing'); return null; }

  const targetPct = (TP_INR / INR_RATE) / NOTIONAL * 100;   // move needed for --tp
  const shortlist = scan.rows.slice(0, Math.max(n * 3, n + 4));

  info(`top ${n} of ${shortlist.length} candidates (${scan.windowH}h move, ` +
       `${((Date.now() - scan.ts) / 60000).toFixed(0)} min old):`);

  let claimed = 0;
  for (const r of shortlist) {
    if (claimed >= 1) break;
    // Only consider the top n by move; the rest of the shortlist exists so a
    // spread rejection does not leave a slot empty.
    const q = await ex.bestQuote(r.sym).catch(() => null);
    const spread = q ? ((q.ask - q.bid) / q.bid) * 100 : null;
    const spreadPct = spread === null ? null : (spread / targetPct) * 100;
    const bad = spreadPct !== null && spreadPct > 40;

    info(`  ${r.sym.padEnd(15)}${(r.chg >= 0 ? '+' : '') + r.chg.toFixed(2)}%`.padEnd(28) +
         (spread === null ? 'spread n/a' : `spread ${spread.toFixed(3)}% = ${spreadPct.toFixed(0)}% of target`) +
         (bad ? '  SKIP (spread too wide)' : ''));
    if (bad) { await sleep(300); continue; }

    SYMBOL = r.sym;
    if (acquireSymbolLock()) {
      ok(`--autosymbols picked ${SYMBOL} (${(r.chg >= 0 ? '+' : '') + r.chg.toFixed(2)}% over ${scan.windowH}h)`);
      return SYMBOL;
    }
    dim(`  ${r.sym} is already taken by another bot — trying the next`);
    SYMBOL = '';
    await sleep(300);
  }
  return null;
}

// ─── Single-instance lock ────────────────────────────────────────────────

let lockHeld = false;

/**
 * Refuses to start if another bot already owns this symbol.
 *
 * An exclusive create is the only cross-process atomic operation available
 * here, so the lock is a file whose name carries the symbol and whose body
 * carries the owner's PID. A lock left behind by a crashed bot is detected
 * by checking whether that PID is still alive, so a hard kill cannot wedge
 * the symbol permanently.
 */
function acquireSymbolLock() {
  const file = symbolLockFile();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
      lockHeld = true;
      return true;
    } catch (e) {
      let owner = null;
      try { owner = parseInt(fs.readFileSync(file, 'utf8').trim(), 10); } catch (e2) { /* unreadable */ }

      if (owner && owner !== process.pid && processAlive(owner)) {
        error('='.repeat(70));
        error(`${SYMBOL} is ALREADY being traded by another finalepicbot (PID ${owner}).`);
        error('  Running two bots on one symbol makes them fight over the same');
        error('  position and compound each exit against the other. Refusing to start.');
        error(`  If that process is gone, delete ${path.basename(file)} and retry.`);
        error('='.repeat(70));
        return false;
      }
      // Stale: the owner is dead (or the file is corrupt). Take it over.
      warn(`clearing a stale lock for ${SYMBOL} (PID ${owner || 'unknown'} is not running)`);
      try { fs.unlinkSync(file); } catch (e2) { /* raced with another bot; retry */ }
    }
  }
  error(`could not acquire the lock for ${SYMBOL} — refusing to start`);
  return false;
}

function releaseSymbolLock() {
  if (!lockHeld) return;
  try {
    const owner = parseInt(fs.readFileSync(symbolLockFile(), 'utf8').trim(), 10);
    if (owner === process.pid) fs.unlinkSync(symbolLockFile());
  } catch (e) { /* already gone */ }
  lockHeld = false;
}

/** True if a PID is a live process. Windows-safe: signal 0 only tests. */
function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }   // EPERM = alive but not ours
}

// ─── Shutdown ────────────────────────────────────────────────────────────

async function halt(reason, { keepOrders = false } = {}) {
  if (halted) return;
  halted = true;
  error(`HALTED — ${reason}`);

  if (keepOrders) {
    warn('PARKED: leaving every resting order live on the exchange. Any take-profit ' +
         'or stop already placed stays active and can still fill — but NOTHING will ' +
         're-price or replace it, and no new orders will be placed.');
  }
  if (!DRY_RUN && !keepOrders) {
    try {
      const r = await Promise.race([
        ex.cancelAllOrders(SYMBOL),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
      ]);
      if (r.found > 0) {
        warn(`cancelled ${r.cancelled}/${r.found} pending order(s) on exit`);
        if (r.failed && r.failed.length) {
          error(`COULD NOT CANCEL: ${r.failed.join(' | ')} — cancel them on Shark NOW`);
        }
      } else {
        info('no pending orders to cancel');
      }
    } catch (e) {
      error(`could not cancel pending orders on exit: ${e.message} — CHECK ${SYMBOL} ON SHARK`);
    }
  }

  if (openLongs.length > 0) {
    const { totalQty, avgEntry, totalNotional } = aggregate();
    error('='.repeat(66));
    error(`${SYMBOL} POSITION STILL OPEN: ${totalQty} units @ avg ${fmt(avgEntry)} ` +
          `(${totalNotional.toFixed(2)} USDT)`);
    error('  This bot has NO stop loss and is now stopping. Nothing is watching this trade.');
    error('  Close it on Shark, or restart the bot.');
    error('='.repeat(66));
  }
  if (closedEpisodes > 0) {
    info(`session: ${closedEpisodes} episode(s) · ${signed(sessionRealisedInr)} INR · ` +
         `avg ${signed(sessionRealisedInr / closedEpisodes)} per episode`);
  }
  if (socket) socket.close();
  // Hand the symbol back explicitly. A lock left behind is recovered on the
  // next start anyway (the owning PID is checked), but releasing it here
  // means a normal restart needs no recovery step at all.
  releaseSymbolLock();
  try { fs.unlinkSync(statusFile()); } catch (e) { /* already gone */ }
  setTimeout(() => process.exit(0), 3000);
}

async function reportCrash(kind, err) {
  try {
    error(`${kind}: ${err && err.message}`);
    if (err && err.stack) error(err.stack.split('\n').slice(0, 5).join(' | '));
    let cleanupFailed = false;
    if (!DRY_RUN) {
      try {
        const r = await Promise.race([
          ex.cancelAllOrders(SYMBOL),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000)),
        ]);
        if (r.found > 0) error(`cancelled ${r.cancelled}/${r.found} pending order(s) after the crash`);
      } catch (e) {
        cleanupFailed = true;
        error(`CRASH: could not cancel pending orders (${e.message}) — CHECK ${SYMBOL} ON SHARK NOW`);
      }
    }
    if (openLongs.length > 0) {
      const { totalQty, avgEntry, totalNotional } = aggregate();
      // A crash with a position still open is the single worst state this bot
      // can reach: nothing is managing the exit and there is no stop loss.
      // This one is worth waking someone up for.
      alert(`CRASH with a POSITION STILL OPEN — ${totalQty} @ ${fmt(avgEntry)} ` +
            `(${totalNotional.toFixed(2)} USDT). ${kind}: ${err && err.message}. ` +
            `Nothing is managing this exit. Check Shark now.`);
      error('='.repeat(66));
      error(`POSITION STILL OPEN ON ${SYMBOL}: ${totalQty} @ ${fmt(avgEntry)} (${totalNotional.toFixed(2)} USDT)`);
      error('  The bot is dead.' + (!slEnabled()
        ? ' There is NO stop loss. Close this manually.'
        : cleanupFailed
          ? ' The cleanup above failed, so the resting stop loss / take-profit MAY still be' +
            ' live on the exchange — check before assuming nothing is protecting this.'
          : ' The resting stop loss was just cancelled along with everything else. Close this manually.'));
      error('='.repeat(66));
    }
  } catch (e) {
    console.error('crash handler failed:', e && e.message);
  }
  process.exit(1);
}

process.on('uncaughtException', e => { reportCrash('UNCAUGHT EXCEPTION', e).catch(() => process.exit(1)); });
process.on('unhandledRejection', e => { reportCrash('UNHANDLED REJECTION', e).catch(() => process.exit(1)); });
process.on('exit', releaseSymbolLock);
process.on('SIGINT', () => { halt('SIGINT (Ctrl-C)').catch(e => console.error(e)); });
process.on('SIGTERM', () => { halt('SIGTERM').catch(e => console.error(e)); });

// ─── Interactive prompts ─────────────────────────────────────────────────

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, a => resolve(a.trim())));
}

async function promptMissing() {
  // --autosymbols supplies the symbol later, from the mover scan.
  const symbolSatisfied = SYMBOL || AUTOSYMBOLS !== null;
  if (symbolSatisfied && isFinite(NOTIONAL) && isFinite(TP_INR)) return;
  if (!process.stdin.isTTY) {
    usage(AUTOSYMBOLS !== null
      ? '--usdt and --tp are required alongside --autosymbols'
      : '--symbol, --usdt and --tp are all required when stdin is not a terminal');
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (!SYMBOL) {
      const a = await ask(rl, 'Symbol (e.g. BTCUSDT): ');
      SYMBOL = a.toUpperCase().replace(/[-_]/g, '');
    }
    while (!isFinite(NOTIONAL) || NOTIONAL <= 0) {
      const a = await ask(rl, 'Starting USDT per buy (level 1, e.g. 10): ');
      NOTIONAL = parseFloat(a);
    }
    while (!isFinite(TP_INR) || TP_INR <= 0) {
      const a = await ask(rl, 'Take-profit target in INR (e.g. 30): ');
      TP_INR = parseFloat(a);
    }
  } finally {
    rl.close();
  }
}

// ─── Boot ────────────────────────────────────────────────────────────────

function validate() {
  // --autosymbols fills SYMBOL in later, from the mover scan.
  if (!SYMBOL && AUTOSYMBOLS === null) usage('--symbol is required');
  if (!['LONG', 'SHORT'].includes(START_SIDE)) usage("--start-side must be 'long' or 'short'");
  if (!['flip', 'hourlybias'].includes(DIRECTION_MODE)) usage("--direction must be 'flip' or 'hourlybias'");
  if (!isFinite(NOTIONAL) || NOTIONAL <= 0) usage('--usdt must be a positive number');
  if (!isFinite(TP_INR) || TP_INR <= 0) usage('--tp must be a positive number');
  if (!Number.isInteger(MAX_LEVELS) || MAX_LEVELS < 1) usage('--levels must be a positive integer');
  if (!Number.isInteger(LEVERAGE) || LEVERAGE < 1) usage('--leverage must be a positive integer');
  if (!isFinite(BUCKET_SEC) || BUCKET_SEC < 5) usage('--bucket-sec must be at least 5');
  if (!Number.isInteger(MIN_BUCKETS) || MIN_BUCKETS < 0) usage('--min-buckets must be 0 or a positive integer');
  if (!isFinite(MIN_DIP_PCT) || MIN_DIP_PCT < 0) usage('--min-dip must be 0 or positive');
  if (!isFinite(EXIT_BUFFER_PCT) || EXIT_BUFFER_PCT < 0) usage('--exit-buffer must be 0 or positive');
  if (AUTOSYMBOLS !== null) {
    if (!isFinite(AUTOSYMBOLS) || AUTOSYMBOLS < 1) usage('--autosymbols must be a positive whole number');
    if (args.symbol) usage('--autosymbols and --symbol are alternatives — pass one, not both');
  }
  if (BAIL_AT_INR !== null && (!isFinite(BAIL_AT_INR) || BAIL_AT_INR <= 0))
    usage('--bail-at must be a non-zero number of INR');
  if (BAIL_FLOATING_INR !== null && (!isFinite(BAIL_FLOATING_INR) || BAIL_FLOATING_INR <= 0))
    usage('--bail-floating must be a non-zero number of INR');
  if (SL_INR !== null && (!isFinite(SL_INR) || SL_INR <= 0)) usage('--sl must be a non-zero number');
  if (SL_LIMIT_INR !== null && (!isFinite(SL_LIMIT_INR) || SL_LIMIT_INR <= 0))
    usage('--sl-stop-limit must be a non-zero number of INR');
  if (SL_INR !== null && SL_LIMIT_INR !== null)
    usage('--sl and --sl-stop-limit are alternatives — pass one, not both. ' +
          '--sl always closes at whatever price the market gives; --sl-stop-limit closes at ' +
          'exactly the price you asked for, or not at all.');
  if (SL_LIMIT_INR !== null && SL_TRIGGER_BUFFER_INR >= SL_LIMIT_INR)
    usage(`--sl-trigger-buffer (${SL_TRIGGER_BUFFER_INR}) must be smaller than ` +
          `--sl-stop-limit (${SL_LIMIT_INR}), or the stop would trigger at a profit`);
  if (MAX_HOLD_MIN !== null && (!isFinite(MAX_HOLD_MIN) || MAX_HOLD_MIN <= 0))
    usage('--max-hold-min must be a non-zero number of minutes');
  if (!isFinite(COOLDOWN_MIN) || COOLDOWN_MIN < 0) usage('--cooldown-min must be 0 or positive');
  if (!Number.isInteger(MAX_EPISODES) || MAX_EPISODES < 0) usage('--max-episodes must be 0 or a positive integer');
  if (MAX_LOSS_INR !== null && (!isFinite(MAX_LOSS_INR) || MAX_LOSS_INR <= 0)) usage('--max-loss must be a non-zero number');
  if (MAX_GAIN_INR !== null && (!isFinite(MAX_GAIN_INR) || MAX_GAIN_INR <= 0)) usage('--max-gain must be a non-zero number');
  if (!isFinite(ENTRY_BUFFER_PCT) || ENTRY_BUFFER_PCT < 0) usage('--entry-buffer-pct must be 0 or positive');
  if (BANK_AT_INR !== null && (!isFinite(BANK_AT_INR) || BANK_AT_INR <= 0)) usage('--bank-at must be a non-zero number');
  if (!isFinite(ENTRY_TIMEOUT_MIN) || ENTRY_TIMEOUT_MIN <= 0) usage('--entry-timeout-min must be a positive number');
}

async function main() {
  await promptMissing();
  validate();

  console.log('');
  info(`FINAL EPIC BOT · ${DRY_RUN ? 'DRY RUN' : '\x1b[31mLIVE\x1b[0m'}`);
  info(`symbol ${SYMBOL} · start ${NOTIONAL} USDT · take profit ${TP_INR} INR ` +
       `(${NET_TARGET ? 'net of fees' : 'gross, as shown in Shark Active P&L'})`);
  if (DIRECTION_MODE === 'hourlybias') {
    info('direction: read fresh from the previous hourly candle before every episode ' +
         '(bearish -> short, bullish -> long) — overrides --start-side and --no-alternate');
    if (START_SIDE_EXPLICIT) warn('--start-side was also passed but has no effect under --direction hourlybias');
  } else {
    info((START_SIDE_EXPLICIT
        ? `direction: starting ${direction} (--start-side)`
        : `direction: warming up ${BUCKET_SEC}s to pick a starting side (dip -> long, rally -> short)`) +
         ' · ' + (ALTERNATE ? 'flips side after every completed episode' : 'stays on this side (--no-alternate)'));
  }
  info(`add rule: enter again when the last ${BUCKET_SEC}s moves against the position ` +
       `further than any ${BUCKET_SEC}s window recorded this episode`);
  info(`  (a long ladders into dips, a short into rallies) · after ${MIN_BUCKETS} window(s) ` +
       `of observation · ignoring moves below ${MIN_DIP_PCT}%`);
  info(`entries: passive at the touch (buy at bid, sell at ask)` +
       (ENTRY_BUFFER_PCT > 0 ? ` + ${(ENTRY_BUFFER_PCT * 100).toFixed(3)}% further onto the passive side` : '') +
       ` — MAKER fee, no entry slippage, up to ${ENTRY_TIMEOUT_MIN}min to fill before giving up on that level`);
  info(DRY_RUN
    ? 'take profit: reduce-only LIMIT into the book, re-priced until filled'
    : 'take profit: a resting reduce-only LIMIT (SELL when long, BUY when short) lives on the ' +
      'exchange at all times, re-priced after every level add — survives the bot crashing');
  if (DIRECTION_MODE === 'hourlybias') {
    info('hourlybias: the candle sets DIRECTION and the ENTRY invalidation (price crossing the ' +
         'prior high/low makes the bot re-read the hour instead of opening). It does NOT place a ' +
         'stop — use --sl or --sl-stop-limit for that, same as any other mode.');
  }
  if (SL_LIMIT_INR !== null) {
    info(`stop loss: a resting STOP_LIMIT capping the loss at EXACTLY -${SL_LIMIT_INR} INR. ` +
         `The trigger fires ${SL_TRIGGER_BUFFER_INR} INR earlier (at -${(SL_LIMIT_INR - SL_TRIGGER_BUFFER_INR).toFixed(2)} INR) ` +
         `so the limit is already marketable when it fires`);
    warn(`  it can FAIL TO FILL: if price gaps past -${SL_LIMIT_INR} INR the order rests unfilled and ` +
         `the position stays open. That is the trade this flag makes.`);
  } else if (SL_INR !== null) {
    info(`stop loss: -${SL_INR} INR, ` + (DRY_RUN
      ? 'checked reactively (dry run has no resting orders)'
      : 'a resting reduce-only STOP_MARKET — fires immediately once triggered, same lifecycle as the take-profit'));
  } else if (MAX_HOLD_MIN === null) {
    error('NO STOP LOSS — pass --sl N to cap the loss at N INR. Without it this ladder has no exit on the downside.');
  } else {
    warn('no --sl: the only exit on the downside is the time stop below.');
  }

  if (MAX_HOLD_MIN !== null) {
    if (ONLY_RED) {
      info(`time stop (--only-red): every ${MAX_HOLD_MIN} min, close the position ONLY if it is ` +
           `worse than -${ONLY_RED_USDT} USDT. Anything green — or barely red — is left alone and ` +
           `re-checked ${MAX_HOLD_MIN} min later, so winners keep running`);
    } else {
      info(`time stop: close whatever is open ${MAX_HOLD_MIN} min after the FIRST entry of an ` +
           `episode, at whatever PnL it is showing — independent of --sl, both can be armed at once`);
    }
  }
  if (REENTRY_BETTER) {
    info(`re-entry: each new episode rests its entry at that side's last entry price` +
         (REENTRY_EDGE_PCT > 0 ? `, ${REENTRY_EDGE_PCT}% further out` : '') +
         ` — a SHORT rests higher, a LONG lower. The order waits in the book.`);
    if (!ALTERNATE) {
      info(`  with --no-alternate this is what stops repeated ${START_SIDE}s walking the price down`);
    }
  }
  if (BAIL_AT_INR !== null) {
    info(`bail-out: if ACCOUNT net (realised since the baseline + floating) drops past ` +
         `-${BAIL_AT_INR} INR, EVERY bot closes its position and stops. ` +
         `Unlike --max-loss this actually gets you flat.`);
  }
  if (BAIL_FLOATING_INR !== null) {
    info(`bail-out (floating): if the net of OPEN POSITIONS drops past -${BAIL_FLOATING_INR} INR, `
       + `EVERY bot closes its position and stops. Realised history is NOT counted, so `
       + `banked profit cannot mask a drawdown on what is open.`);
  }
  if (BANK_AT_INR !== null) {
    info(`bank-and-restart: flatten everything and re-baseline each time ACCOUNT net profit ` +
         `(banked minus floating loss) clears ${BANK_AT_INR} INR — the bot keeps trading`);
  }
  if (MAX_LOSS_INR !== null || MAX_GAIN_INR !== null) {
    info(`session circuit breaker: stop once realised PnL hits ` +
         `${MAX_LOSS_INR !== null ? `-${MAX_LOSS_INR}` : 'no floor'} / ` +
         `${MAX_GAIN_INR !== null ? `+${MAX_GAIN_INR}` : 'no ceiling'} INR (this run only, resets on restart)`);
  }

  if (killSwitchActive()) {
    error(`kill switch file "${killSwitchName()}" present — remove it to start`);
    process.exit(1);
  }
  if (parkSwitchActive()) {
    error(`park switch file "${parkSwitchName()}" present — remove it to start`);
    process.exit(1);
  }
  if (fs.existsSync(BAIL_FILE)) {
    error('='.repeat(70));
    error(`${path.basename(BAIL_FILE)} present — a previous session bailed out.`);
    try {
      for (const l of fs.readFileSync(BAIL_FILE, 'utf8').trim().split(/\r?\n/)) error('  ' + l);
    } catch (e) { /* unreadable; the filename alone is the signal */ }
    error('  Check the account, then delete that file to start again.');
    error('='.repeat(70));
    process.exit(1);
  }

  // Claim the symbol before anything else can place an order. Two bots on
  // one symbol is not a duplicate, it is a corruption: they read each
  // other's fills as their own position and compound their exits.
  if (AUTOSYMBOLS === null && !acquireSymbolLock()) process.exit(1);
  ok(`holding the ${SYMBOL} lock (PID ${process.pid}) — no second bot can trade this symbol`);

  console.log('');
  info('ladder plan:');
  const plan = ladderPlan();
  for (const r of plan) {
    info(`  L${r.level}: x${r.mult} = ${r.notional.toFixed(2)} USDT · ` +
         `cumulative ${r.cumNotional.toFixed(2)} USDT · margin ${r.margin.toFixed(2)} USDT at ${LEVERAGE}x`);
  }
  const full = plan[plan.length - 1];
  info(`fully filled: ${full.cumNotional.toFixed(2)} USDT notional, ${full.margin.toFixed(2)} USDT margin`);
  console.log('');

  error('='.repeat(66));
  if (!slEnabled()) {
    error('NO STOP LOSS. Nothing in this bot closes a losing trade.');
    error(`On a LONG episode: if ${SYMBOL} keeps falling, the ladder buys ` +
          `${full.cumNotional.toFixed(0)} USDT of it and holds. At ${LEVERAGE}x isolated it`);
    error(`liquidates roughly ${(100 / LEVERAGE).toFixed(0)}% BELOW the average entry.`);
    if (ALTERNATE || !isLong()) {
      error('On a SHORT episode the same ladder sells into a rally and liquidates about');
      error(`${(100 / LEVERAGE).toFixed(0)}% ABOVE the average entry. This side is worse: a long's`);
      error('loss stops when price reaches zero, a short\'s has no such ceiling.');
    }
  } else if (SL_LIMIT_INR !== null) {
    error(`STOP LOSS is set at EXACTLY -${SL_LIMIT_INR} INR as a resting STOP_LIMIT, triggered`);
    error(`${SL_TRIGGER_BUFFER_INR} INR earlier. It can never fill worse than that price — but it`);
    error('can FAIL TO FILL ENTIRELY. If price gaps straight past the limit, the order rests');
    error('unfilled and the position stays open with no protection, exactly as if there were');
    error(`no stop at all. Worst case is then the full ladder (${full.cumNotional.toFixed(0)} USDT).`);
    error('That is the trade: a known price, or no exit. --sl is the opposite trade.');
  } else {
    error(DIRECTION_MODE === 'hourlybias'
      ? 'STOP LOSS is the hourly invalidation level, as a resting STOP_MARKET — once triggered it'
      : `STOP LOSS is set at -${SL_INR} INR as a resting STOP_MARKET — once triggered it`);
    error('executes immediately against whatever price is available, so unlike a stop-limit');
    error('it will actually close the position. The remaining risk is SLIPPAGE, not non-fill:');
    error('on a violent, thin-book move the fill can land meaningfully worse than the trigger');
    error(`price. Worst case is still the full ladder (${full.cumNotional.toFixed(0)} USDT) if the`);
    error('order itself fails to place (a real, separate failure mode — not just a market one).');
  }
  error('='.repeat(66));
  console.log('');

  if (!DRY_RUN && (!process.env.SHARK_API_KEY || !process.env.SHARK_API_SECRET)) {
    error('LIVE mode needs SHARK_API_KEY and SHARK_API_SECRET in .env');
    process.exit(1);
  }

  info('loading contract metadata…');
  const contracts = await ex.loadContracts();
  ok(`${contracts.size} contracts loaded via ${ex.loadMethod()}`);

  const liveRate = ex.inrPerUsdt();
  if (liveRate && args['inr-rate'] === undefined) {
    INR_RATE = liveRate;
    info(`INR rate from exchangeInfo: ${INR_RATE}`);
  } else {
    info(`INR rate: ${INR_RATE} (${args['inr-rate'] !== undefined ? '--inr-rate' : 'fallback default'})`);
  }

  if (AUTOSYMBOLS !== null) {
    const picked = await claimAutoSymbol(AUTOSYMBOLS);
    if (!picked) {
      error('='.repeat(66));
      error(`--autosymbols ${AUTOSYMBOLS}: every candidate is already being traded by`);
      error('  another bot, or was skipped for a spread too wide to pay the target.');
      error(`  Raise --autosymbols above ${AUTOSYMBOLS}, or run fewer bots.`);
      error('='.repeat(66));
      process.exit(1);
    }
  }

  const c = ex.contract(SYMBOL);
  if (!c) { error(`${SYMBOL} is not a listed contract`); process.exit(1); }
  info(`${SYMBOL}: qtyPrec=${c.quantityPrecision} pricePrec=${c.pricePrecision} ` +
       `minQty=${c.minQty} minNotional=${c.minNotional} maxLev=${c.maxLeverage} ` +
       `takerFee=${(takerFeeRate() * 100).toFixed(4)}%`);

  if (NOTIONAL < c.minNotional) {
    error(`starting size ${NOTIONAL} USDT is below ${SYMBOL}'s minimum notional of ${c.minNotional}`);
    process.exit(1);
  }
  if (LEVERAGE > c.maxLeverage) {
    warn(`requested ${LEVERAGE}x but ${SYMBOL} caps at ${c.maxLeverage}x — the exchange will clamp it`);
  }

  // What the target is worth against the fees at each rung. A small INR
  // target on a large ladder can settle as a net loss, and the gross figure
  // on screen will not show that.
  console.log('');
  info(`take-profit target vs estimated round-trip taker fees (${(takerFeeRate() * 100).toFixed(4)}% per side) — ` +
       `a worst-case estimate: entries now fill passively and may pay the lower MAKER fee instead:`);
  for (const r of plan) {
    const feeInrLevel = r.cumNotional * takerFeeRate() * 2 * INR_RATE;
    const net = TP_INR - feeInrLevel;
    const movePct = (TP_INR / INR_RATE) / r.cumNotional * 100;
    const line = `  at L${r.level} (${r.cumNotional.toFixed(0)} USDT open): fees ~${feeInrLevel.toFixed(1)} INR · ` +
                 `gross ${TP_INR} = net ${signed(net)} INR · needs a ${movePct.toFixed(3)}% move`;
    net < 0 ? warn(line) : info(line);
  }
  if (!NET_TARGET) {
    const worstFee = full.cumNotional * takerFeeRate() * 2 * INR_RATE;
    if (TP_INR < worstFee) {
      warn(`your ${TP_INR} INR target is smaller than the ~${worstFee.toFixed(1)} INR of fees on a full ` +
           `ladder — exits taken there would settle at a LOSS. Pass --net to make the target net of fees.`);
    }
  }
  console.log('');

  if (!DRY_RUN) {
    try {
      const w = await ex.walletBalance();
      if (w !== null) {
        info(`futures wallet: ${w.toFixed(2)} USDT`);
        if (full.margin > w) {
          error(`a full ladder needs ${full.margin.toFixed(2)} USDT margin but the wallet holds ${w.toFixed(2)}.`);
          const affordable = plan.filter(r => r.margin <= w).length;
          error(`only ${affordable} of ${MAX_LEVELS} level(s) are fundable — lower --usdt or --levels.`);
          process.exit(1);
        }
        if (full.margin > w * 0.5) {
          warn(`a full ladder would commit ${(full.margin / w * 100).toFixed(0)}% of the wallet`);
        }
      }
    } catch (e) {
      warn(`could not verify the wallet balance (${e.message}) — continuing without the capital check`);
    }

    // The caps measure realised PnL booked since a moment in time, plus what
    // is floating right now. Several bots share one account and one baseline,
    // so a bot joining a round in progress must adopt it rather than start
    // its own — otherwise they measure different nets and stop banking
    // together.
    if (MAX_LOSS_INR !== null || MAX_GAIN_INR !== null ||
        BANK_AT_INR !== null || BAIL_AT_INR !== null || BAIL_FLOATING_INR !== null) {
      const shared = readSharedBaseline();
      if (shared && Date.now() - shared.ts < 12 * 3600000) {
        bankedRounds = shared.round || 0;
        info(`joining the round already running: started ${new Date(shared.ts).toISOString().slice(11, 19)} UTC ` +
             `(round ${bankedRounds}) — delete bank-baseline.json to start a fresh session`);
      } else {
        writeSharedBaseline(Date.now(), 0);
        info(`starting a fresh round from now`);
      }
      info(`caps count REALISED PnL from the exchange since that moment, plus floating ` +
           `PnL on what is open — re-checked every 20s, so they can fire while a ` +
           `position is still losing`);
      info(`deposits and withdrawals do NOT count as profit or loss`);
    }

    const existing = await ex.hasOpenPosition(SYMBOL);
    if (existing === true) {
      error(`${SYMBOL} already has an open position. This bot tracks its own entries and would ` +
            `mismanage one it did not open. Close it first, or run a different symbol.`);
      process.exit(1);
    }

    warn('REAL orders in 10 seconds. Ctrl-C to abort.');
    await new Promise(r => setTimeout(r, 10000));
  }

  setInterval(writeStatus, 3000);
  writeStatus();
  setInterval(closeBucket, BUCKET_MS);
  setInterval(() => { refreshExchangePos().catch(() => {}); }, 20000);
  setInterval(() => { checkAccountCaps().catch(e => warn(`cap check failed: ${e.message}`)); }, 20000);

  info(START_SIDE_EXPLICIT
    ? 'waiting for the first tick — the opening entry goes in as soon as one arrives'
    : `waiting for the first tick — then a ${BUCKET_SEC}s warm-up before the opening entry`);
  startFeed();
}

main().catch(e => { error(`fatal: ${e.message}`); process.exit(1); });
