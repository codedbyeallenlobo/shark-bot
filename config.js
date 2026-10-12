'use strict';

/**
 * All strategy parameters live here. Nothing is hard-coded elsewhere.
 * Read every value before switching DRY_RUN to false.
 */
module.exports = {

  // ─── SAFETY ────────────────────────────────────────────────────────────
  // true  = simulate everything, place no real orders (paper trading)
  // false = send real orders to Shark Exchange
  DRY_RUN: false,

  // Bot halts immediately if a file named STOP exists in the project root.
  // Create it from another terminal: `touch STOP`
  KILL_SWITCH_FILE: 'STOP',

  // Cumulative realised loss for the day at which the bot stops for good.
  DAILY_LOSS_LIMIT_USDT: -6,
  MAX_CYCLES_PER_DAY: 3,

  // ─── SIZING ────────────────────────────────────────────────────────────
  // Matches the size in your positions screenshot: ~20 USDT notional,
  // ~2 USDT locked margin at 10x.
  NOTIONAL_PER_POSITION: 20,   // USDT of position value, NOT margin
  LEVERAGE: 10,                // capped per-symbol by maxLeverage
  MARGIN_MODE: 'ISOLATED',
  MARGIN_ASSET: 'INR',         // Shark's docs show INR for every example, even
                                // USDT-quoted contracts (see marginAssetsSupported
                                // and INR_MARGIN_USDT conversion rate in exchangeInfo).
                                // Auto-tries the other value if this is rejected.

  // Attaches a stop-loss to each order ON THE EXCHANGE at entry time.
  // This is the backstop that survives the bot crashing, losing network, or
  // being killed. Normal exits still use limit orders as you specified —
  // this only fires if everything else has already failed.
  ATTACH_EXCHANGE_STOP: true,

  MAX_POSITIONS: 5,

  // 'rolling' — enter each symbol the moment it qualifies, up to MAX_POSITIONS.
  //             Slots refill as they open. MIN_QUALIFIED is ignored.
  // 'batch'   — wait until MIN_QUALIFIED symbols qualify, then enter together.
  ENTRY_MODE: 'rolling',
  MIN_QUALIFIED: 5,            // batch mode only

  // After a failed entry (pullback too deep, spread too wide), wait this long
  // before reconsidering the same symbol — it may recover.
  ENTRY_RETRY_COOLDOWN_MS: 60 * 1000,

  // Aggregate target/stop are fixed USDT amounts. With rolling entry the
  // position count varies, so the same 2.5 USDT means a 12.5% move on one
  // position but only a 2.5% average move on five. Set true to scale the
  // thresholds in proportion to how many positions are actually open.
  SCALE_THRESHOLDS_BY_POSITIONS: false,

  // ─── ENTRY CRITERIA ────────────────────────────────────────────────────
  HOLD_THRESHOLD_PCT: 2.0,               // must be >= this since session start
  HOLD_DURATION_MS: 5 * 60 * 1000,       // ...continuously, for this long
  MAX_SPREAD_PCT: 0.45,                  // reject illiquid books

  // Must still be near its session high at entry. Hold duration alone lets a
  // coin qualify while bleeding down from a spike — this catches that. A
  // genuine trend sits close to its high; a fading pump drifts away from it.
  // Set to 100 to disable.
  MAX_PULLBACK_PCT: 1.5,

  // ─── EXIT RULES ────────────────────────────────────────────────────────
  AGG_TARGET_USDT: 2.5,                  // aggregate profit target
  AGG_STOP_USDT: -1.8,                   // aggregate stop
  POSITION_STOP_USDT: -2.0,              // per-position disaster brake
  TARGET_CONFIRM_WAIT_MS: 5 * 60 * 1000, // hold-and-recheck after target hit
  MAX_HOLD_MS: 3 * 60 * 60 * 1000,       // time-based flat-out

  // Triggers measured on GROSS price PnL, matching the "Active P&L" column
  // you watch manually. Net-of-fees is logged alongside for comparison.
  PNL_BASIS: 'gross',                    // 'gross' | 'net'

  // ─── ORDER MANAGEMENT ──────────────────────────────────────────────────
  // Where to price an entry limit order:
  //   'ask' — at the best ask. Marketable, fills immediately, pays taker fee.
  //   'bid' — at the best bid. Maker fee, but on a rising coin it often
  //           never fills and the entry is skipped.
  //   'mid' — midpoint. Compromise; may or may not fill.
  // At 20 USDT notional the fee difference is 0.005 USDT — half a paisa.
  // Missing the trade costs far more than crossing the spread.
  ENTRY_PRICE_MODE: 'ask',

  ENTRY_FILL_TIMEOUT_MS: 60 * 1000,
  ENTRY_UNFILLED_ACTION: 'skip',         // 'skip' | 'chase'
  EXIT_RETRY_MS: 5 * 60 * 1000,
  EXIT_MAX_RETRIES: 2,                   // then escalate to WhatsApp

  // ─── FEES (from your fee schedule) ─────────────────────────────────────
  MAKER_FEE: 0.00016,
  TAKER_FEE: 0.0004,

  // ─── DASHBOARD ─────────────────────────────────────────────────────────
  DASHBOARD_ENABLED: true,
  DASHBOARD_PORT: 3000,

  // ─── NOTIFICATIONS ─────────────────────────────────────────────────────
  // 'console'  — coloured banner + terminal bell, no setup, always works
  // 'telegram' — free; needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID
  // 'webhook'  — Make.com / n8n / your own; needs NOTIFY_WEBHOOK_URL
  // Telegram is listed by default but costs nothing when unconfigured:
  // viaTelegram() returns false the moment TELEGRAM_BOT_TOKEN or
  // TELEGRAM_CHAT_ID is missing, so it is a no-op until you set them.
  // Override with NOTIFY_CHANNELS=console,telegram,webhook in .env.
  NOTIFY_CHANNELS: (process.env.NOTIFY_CHANNELS || 'console,telegram')
    .split(',').map(s => s.trim()).filter(Boolean),

  // ─── ENDPOINTS ─────────────────────────────────────────────────────────
  REST_BASE: 'https://api.sharkexchange.in',
  WS_PUBLIC: 'https://fawss.sharkexchange.in/',
  WS_AUTH: 'https://fawss-uds.sharkexchange.in/auth-stream',

  // ─── MISC ──────────────────────────────────────────────────────────────
  QUOTE_SUFFIX: 'USDT',
  TICK_LOG_INTERVAL_MS: 60 * 1000,
  TRADE_LOG: 'trades.csv',
  EVENT_LOG: 'events.log',
};
