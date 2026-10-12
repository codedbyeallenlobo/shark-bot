'use strict';

/**
 * LOCAL DASHBOARD for finalepicbot — one page showing every running bot.
 *
 * Deliberately local-only. It reads your status files and calls the exchange
 * with your API keys, so it binds to 127.0.0.1 and is never exposed.
 *
 * Data comes from three places:
 *   finalepic-status-<SYM>.json  each bot publishes its own state every 3s.
 *                                The event log cannot be used for this: its
 *                                heartbeat lines carry no symbol, so nine
 *                                bots are indistinguishable in it.
 *   /v1/positions/OPEN           what the exchange actually holds, which is
 *                                the check against a bot's own book.
 *   /v1/positions/history        realised PnL, exact, fee-adjusted here.
 *
 * Usage:
 *   node dashboard.js                 http://127.0.0.1:7070
 *   node dashboard.js --port 8080
 *   node dashboard.js --since 3       count realised PnL over the last 3h
 */

require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const ex = require('./lib/exchange');

function parseArgs(argv) {
  const out = { flags: new Set() };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2), n = argv[i + 1];
    if (n === undefined || n.startsWith('--')) out.flags.add(k);
    else { out[k] = n; i++; }
  }
  return out;
}
const args = parseArgs(process.argv);
const PORT = parseInt(args.port ?? 7070, 10);
const SINCE_H = parseFloat(args.since ?? 6);
const INR = 102;

/** A bot is alive if its PID still is — status files outlive a hard kill. */
function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

function readStatuses() {
  const out = [];
  for (const f of fs.readdirSync(__dirname)) {
    const m = f.match(/^finalepic-status-(.+)\.json$/);
    if (!m) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8'));
      s.alive = processAlive(s.pid);
      s.stale = Date.now() - s.ts > 15000;
      out.push(s);
    } catch (e) { /* mid-write; it'll be there next refresh */ }
  }
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

let contractsReady = false;
async function snapshot() {
  if (!contractsReady) { await ex.loadContracts().then(() => { contractsReady = true; }).catch(() => {}); }
  const bots = readStatuses();

  const res = { ts: Date.now(), bots, account: null, positions: [], realised: null, error: null };

  try {
    const wallet = await ex.walletBalance();
    const pos = await ex.positions('OPEN');
    const list = Array.isArray(pos) ? pos : (pos.data || pos.positions || []);
    let floating = 0;
    for (const p of list) {
      const sym = String(p.contractPair || p.symbol || '').toUpperCase();
      const qty = Math.abs(+p.quantity), entry = +p.entryPrice;
      const bot = bots.find(b => b.symbol === sym);
      // Prefer the bot's own live feed price; only call the API if no bot has it.
      const mark = bot && bot.lastPrice ? bot.lastPrice : await ex.lastTradedPrice(sym).catch(() => null);
      const long = String(p.positionType || '').toUpperCase() !== 'SHORT';
      const pnl = mark === null ? null : (long ? mark - entry : entry - mark) * qty * INR;
      if (pnl !== null) floating += pnl;
      res.positions.push({
        symbol: sym, side: long ? 'LONG' : 'SHORT', qty, entry, mark, pnl,
        notionalUsdt: qty * entry, openedAt: Date.parse(p.createdAt) || null,
        managed: !!(bot && bot.alive),
      });
    }
    res.account = { walletUsdt: wallet, floatingInr: floating };

    const since = Date.now() - SINCE_H * 3600000;
    const hist = await ex.positionHistory({ startTimestamp: since });
    let gross = 0, fees = 0, n = 0, wins = 0, liq = 0;
    for (const r of hist) {
      if (r.positionStatus === 'OPEN' || Date.parse(r.updatedAt) < since) continue;
      const rate = +r.marginSettlementRate || INR;
      const g = r.realizedProfitInMarginAsset != null ? +r.realizedProfitInMarginAsset : +r.realizedProfit * rate;
      const c = ex.contract(String(r.contractPair).toUpperCase());
      const notl = Math.abs(+r.quantity * +r.entryPrice) * rate;
      if (isFinite(notl)) fees += notl * (((c ? +c.makerFee : 0.02) + (c ? +c.takerFee : 0.06)) / 100);
      gross += g; n++; if (g > 0) wins++;
      if (r.positionStatus === 'LIQUIDATED') liq++;
    }
    res.realised = { hours: SINCE_H, n, wins, gross, fees, net: gross - fees, liq };
  } catch (e) {
    res.error = e.message.slice(0, 200);
  }
  return res;
}

const PAGE = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');

http.createServer(async (req, res) => {
  if (req.url === '/api') {
    try {
      const data = await snapshot();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`finalepicbot dashboard -> http://127.0.0.1:${PORT}`);
  console.log(`  realised PnL window: last ${SINCE_H}h   (--since N to change)`);
  console.log('  bound to 127.0.0.1 only — it reads your API keys, so it is not exposed.');
});
