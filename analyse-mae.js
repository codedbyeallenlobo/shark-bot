'use strict';

/**
 * STOP-LOSS STUDY — reads finalepic-mae.csv, appended by the bot as each
 * episode closes.
 *
 * The question a stop must answer is not "how far do losers fall?" but "how
 * much drawdown do WINNERS survive on their way to target?" A stop tighter
 * than that converts winners into losses, and this strategy's winners
 * routinely go underwater first — the target is roughly 0.45% while the
 * median winner dips ~0.73% before turning.
 *
 * By default this looks ONLY at episodes that closed on their take-profit,
 * because those are the trades a stop would have interfered with. Episodes
 * force-closed by a bank round never completed their journey, so their
 * drawdown says nothing about where a stop belongs.
 *
 * Usage:
 *   node analyse-mae.js                     TP-closed episodes (the default)
 *   node analyse-mae.js --all               every closed episode
 *   node analyse-mae.js --symbol AKEUSDT
 *   node analyse-mae.js --stops 0.5,1,2,5,10
 */

const fs = require('fs');
const path = require('path');

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
const FILE = path.join(__dirname, 'finalepic-mae.csv');
const ONLY = args.symbol ? String(args.symbol).toUpperCase() : null;
const ALL = args.flags.has('all');
const STOPS = String(args.stops ?? '0.5,0.75,1,1.5,2,3,5,8,10,15')
  .split(',').map(Number).filter(isFinite);

if (!fs.existsSync(FILE)) {
  console.error(`no ${path.basename(FILE)} yet — the bot writes it as episodes close.`);
  process.exit(1);
}

const lines = fs.readFileSync(FILE, 'utf8').trim().split('\n');
const idx = Object.fromEntries(lines[0].split(',').map((h, i) => [h, i]));
let rows = lines.slice(1).map(l => l.split(','))
  .map(c => ({
    sym: c[idx.symbol], side: c[idx.direction], reason: c[idx.exit_reason],
    mae: parseFloat(c[idx.mae_pct]), mfe: parseFloat(c[idx.mfe_pct]),
    pnl: parseFloat(c[idx.pnl_inr]), notional: parseFloat(c[idx.notional_inr]),
  }))
  .filter(r => isFinite(r.mae) && isFinite(r.pnl) && isFinite(r.notional))
  .filter(r => !ONLY || r.sym === ONLY);

const total = rows.length;
if (!ALL) rows = rows.filter(r => r.reason === 'tp' || r.reason === 'ambiguous');
if (!rows.length) {
  console.log(`(no ${ALL ? '' : 'TP-closed '}episodes recorded yet — ${total} row(s) in the file)`);
  process.exit(0);
}

const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const win = rows.filter(r => r.pnl > 0), los = rows.filter(r => r.pnl <= 0);

console.log(`${rows.length} ${ALL ? 'closed' : 'TP-closed'} episodes` +
            `${ONLY ? ' on ' + ONLY : ''}${ALL ? '' : ` (of ${total} total)`}: ` +
            `${win.length} winners, ${los.length} losers\n`);

console.log('MAE — drawdown before the trade resolved (% of average entry):');
console.log('              p50     p75     p90     p95     p99      max');
for (const [lbl, a] of [['winners', win], ['losers ', los]]) {
  if (!a.length) { console.log(`  ${lbl}  (none)`); continue; }
  const m = a.map(r => r.mae);
  console.log('  ' + lbl + '  ' + [0.5, 0.75, 0.9, 0.95, 0.99].map(p => (q(m, p).toFixed(2) + '%').padStart(7)).join(' ') +
              (Math.max(...m).toFixed(2) + '%').padStart(9));
}
if (win.length) {
  console.log(`\nWinners that went underwater at all: ` +
    `${(win.filter(r => r.mae > 0.05).length / win.length * 100).toFixed(0)}%`);
  console.log(`A stop must sit beyond the p95 (${q(win.map(r => r.mae), 0.95).toFixed(2)}%) ` +
              `to keep 95% of them.`);
}

console.log('\nSTOP SIMULATION — what each level would have done:\n');
console.log('  stop     winners cut    cost INR      saved INR       NET');
for (const D of STOPS) {
  let cost = 0, n = 0, saved = 0;
  for (const r of rows) {
    const atStop = -(D / 100) * r.notional;
    if (r.pnl > 0) { if (r.mae > D) { cost += r.pnl - atStop; n++; } }
    else if (r.mae > D && r.pnl < atStop) saved += atStop - r.pnl;
  }
  const net = saved - cost;
  console.log('  ' + (D + '%').padEnd(9) + (n + '/' + win.length).padEnd(15) +
    ('-' + cost.toFixed(0)).padStart(10) + ('+' + saved.toFixed(0)).padStart(14) +
    ((net >= 0 ? '+' : '') + net.toFixed(0)).padStart(10) + ' INR');
}
const actual = rows.reduce((s, r) => s + r.pnl, 0);
console.log(`\n  actually realised: ${actual >= 0 ? '+' : ''}${actual.toFixed(0)} INR`);
console.log('  NET positive = that stop would have helped. Negative = it would have cut');
console.log('  more from winners than it saved on losers.');

if (!ONLY) {
  const by = {};
  for (const r of rows) (by[r.sym] = by[r.sym] || []).push(r);
  console.log('\nBy symbol — a stop below "MAE p95" starts eating that symbol\'s winners:');
  console.log('  symbol            n   win%   MAE p50   MAE p95   MAE max');
  for (const [s, a] of Object.entries(by).sort((x, y) => y[1].length - x[1].length)) {
    const m = a.map(r => r.mae);
    console.log('  ' + s.padEnd(15) + String(a.length).padStart(4) +
      (a.filter(r => r.pnl > 0).length / a.length * 100).toFixed(0).padStart(6) + '%' +
      (q(m, 0.5).toFixed(2) + '%').padStart(10) + (q(m, 0.95).toFixed(2) + '%').padStart(10) +
      (Math.max(...m).toFixed(2) + '%').padStart(10));
  }
}
