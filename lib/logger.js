'use strict';

const fs = require('fs');
const path = require('path');
const cfg = require('../config');

const ROOT = path.join(__dirname, '..');
const EVENT_PATH = path.join(ROOT, cfg.EVENT_LOG);
const TRADE_PATH = path.join(ROOT, cfg.TRADE_LOG);

const TRADE_HEADER =
  'cycle,symbol,side,qty,entry_price,exit_price,entry_ts,exit_ts,' +
  'gross_pnl_usdt,fees_usdt,net_pnl_usdt,exit_reason,dry_run\n';

if (!fs.existsSync(TRADE_PATH)) fs.writeFileSync(TRADE_PATH, TRADE_HEADER);

const COLOURS = {
  info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m',
  trade: '\x1b[35m', ok: '\x1b[32m', dim: '\x1b[90m',
};
const RESET = '\x1b[0m';

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

const ring = [];
const RING_MAX = 200;

function log(level, msg) {
  const line = `[${stamp()}] ${level.toUpperCase().padEnd(5)} ${msg}`;
  console.log(`${COLOURS[level] || ''}${line}${RESET}`);
  fs.appendFileSync(EVENT_PATH, line + '\n');

  ring.push({ ts: Date.now(), level, msg });
  if (ring.length > RING_MAX) ring.shift();
}

/** Most recent events, newest first — consumed by the dashboard. */
function recent(n = 60) {
  return ring.slice(-n).reverse();
}

const info  = (m) => log('info', m);
const warn  = (m) => log('warn', m);
const error = (m) => log('error', m);
const trade = (m) => log('trade', m);
const ok    = (m) => log('ok', m);
const dim   = (m) => log('dim', m);

/** Appends one closed position to trades.csv for later analysis. */
function recordTrade(t) {
  const row = [
    t.cycle, t.symbol, t.side, t.qty,
    t.entryPrice, t.exitPrice,
    new Date(t.entryTs).toISOString(), new Date(t.exitTs).toISOString(),
    t.grossPnl.toFixed(6), t.fees.toFixed(6), t.netPnl.toFixed(6),
    t.exitReason, cfg.DRY_RUN,
  ].join(',');
  fs.appendFileSync(TRADE_PATH, row + '\n');
}

const CANDIDATE_PATH = path.join(ROOT, 'candidates.csv');
const CANDIDATE_HEADER =
  'symbol,qualified_at,hold_minutes,change_at_qual_pct,pullback_at_qual_pct,' +
  'horizon_min,price_at_qual,price_later,move_after_qual_pct\n';

if (!fs.existsSync(CANDIDATE_PATH)) fs.writeFileSync(CANDIDATE_PATH, CANDIDATE_HEADER);

/**
 * Records what a qualifying symbol did AFTER it qualified. Logged whether or
 * not the bot traded it, so the filter can be tuned on real outcomes.
 */
function recordCandidate(c) {
  const row = [
    c.symbol,
    new Date(c.qualifiedAt).toISOString(),
    (c.holdMs / 60000).toFixed(1),
    c.changePct.toFixed(3),
    c.pullbackPct.toFixed(3),
    c.horizonMin,
    c.priceAtQual,
    c.priceLater,
    c.moveAfterPct.toFixed(3),
  ].join(',');
  fs.appendFileSync(CANDIDATE_PATH, row + '\n');
}

module.exports = { info, warn, error, trade, ok, dim, recordTrade, recordCandidate, recent };
