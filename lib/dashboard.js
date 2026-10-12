'use strict';

const http = require('http');
const cfg = require('../config');

/**
 * Serves a live dashboard on localhost. The bot is the single source of
 * truth — the browser only renders what the bot already knows, so the
 * anchors and hold timers shown here are exactly the ones driving trades.
 *
 * Transport is Server-Sent Events: one-way push, auto-reconnecting,
 * no dependencies.
 */

const clients = new Set();

function start(getState, port = cfg.DASHBOARD_PORT) {
  const server = http.createServer((req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
  });

  server.listen(port, () => {
    console.log(`\n  \x1b[36mDashboard: http://localhost:${port}\x1b[0m\n`);
  });

  setInterval(() => {
    if (clients.size === 0) return;
    let payload;
    try {
      payload = JSON.stringify(getState());
    } catch (e) {
      return;
    }
    const frame = `data: ${payload}\n\n`;
    for (const c of clients) {
      try { c.write(frame); } catch (e) { clients.delete(c); }
    }
  }, 1000);

  return server;
}

const HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Shark Bot — live</title>
<style>
:root{--bg:#0b1016;--panel:#111927;--line:#1d2939;--text:#dbe4f0;--dim:#7d8ba1;
--up:#2dd4a7;--down:#ff5c7a;--accent:#4da3ff;--warn:#ffb020;--mono:'Consolas','SF Mono',monospace}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;padding:14px;font-size:13px}
header{display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
h1{font-size:16px;font-weight:600}
h1 span{color:var(--accent)}
.pill{font-size:11px;padding:4px 10px;border-radius:20px;border:1px solid var(--line);color:var(--dim);font-family:var(--mono)}
.pill.live{color:var(--up);border-color:var(--up)}
.pill.warn{color:var(--warn);border-color:var(--warn)}
.pill.down{color:var(--down);border-color:var(--down)}
.stats{margin-left:auto;display:flex;gap:8px;flex-wrap:wrap}
.grid{display:grid;grid-template-columns:1fr 380px;gap:12px}
@media(max-width:1100px){.grid{grid-template-columns:1fr}}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:9px;overflow:hidden;margin-bottom:12px}
.panel h2{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--dim);padding:9px 13px;border-bottom:1px solid var(--line)}
table{width:100%;border-collapse:collapse}
th{font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.5px;text-align:right;padding:7px 10px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--panel);cursor:pointer;user-select:none}
th:first-child,td:first-child{text-align:left}
th:hover{color:var(--text)}
th.active{color:var(--accent)}
td{padding:6px 10px;border-bottom:1px solid var(--line);font-family:var(--mono);text-align:right;white-space:nowrap}
td.sym{font-family:'Segoe UI',sans-serif;font-weight:600}
.up{color:var(--up)}.down{color:var(--down)}.flat{color:var(--dim)}.warn{color:var(--warn)}
.scroll{max-height:62vh;overflow-y:auto}
.badge{padding:2px 7px;border-radius:4px;font-size:11px;font-family:var(--mono)}
.b-qual{background:rgba(255,176,32,.15);color:var(--warn)}
.b-order{background:rgba(77,163,255,.18);color:var(--accent)}
.b-pos{background:rgba(45,212,167,.15);color:var(--up)}
.b-closed{background:rgba(125,139,161,.15);color:var(--dim)}
.ev{padding:6px 12px;border-bottom:1px solid var(--line);font-size:12px;font-family:var(--mono);display:flex;gap:8px}
.ev .t{color:var(--dim);flex-shrink:0}
.ev.trade{color:#c98cff}.ev.error{color:var(--down)}.ev.warn{color:var(--warn)}
.ev.ok{color:var(--up)}.ev.dim{color:var(--dim)}.ev.info{color:var(--text)}
.empty{padding:16px;color:var(--dim)}
.bar{height:3px;background:var(--line);border-radius:2px;overflow:hidden;width:60px;display:inline-block;vertical-align:middle;margin-left:6px}
.bar i{display:block;height:100%;background:var(--warn)}
</style></head><body>

<header>
  <h1>SHARK <span>BOT</span></h1>
  <span class="pill" id="conn">connecting…</span>
  <span class="pill" id="mode">—</span>
  <span class="pill" id="state">—</span>
  <div class="stats">
    <span class="pill" id="qual">qualified 0/5</span>
    <span class="pill" id="agg">PnL —</span>
    <span class="pill" id="daily">day —</span>
  </div>
</header>

<div class="grid">
  <div>
    <div class="panel">
      <h2>Market — hold progress toward entry</h2>
      <div class="scroll"><table>
        <thead><tr>
          <th data-k="sym">Symbol</th><th data-k="price">Price</th>
          <th data-k="changePct">Since start</th><th data-k="heldMs">Held above</th>
          <th data-k="pullbackPct">Off high</th><th data-k="status">Status</th>
        </tr></thead>
        <tbody id="rows"></tbody>
      </table></div>
    </div>
  </div>

  <div>
    <div class="panel">
      <h2>Open positions</h2>
      <table><thead><tr><th>Symbol</th><th>Entry</th><th>Mark</th><th>PnL</th></tr></thead>
      <tbody id="pos"></tbody></table>
      <div id="posEmpty" class="empty">none</div>
    </div>
    <div class="panel">
      <h2>Event log</h2>
      <div class="scroll" style="max-height:44vh" id="events"></div>
    </div>
  </div>
</div>

<script>
let sortKey='heldMs', sortDir=-1, last=null;

document.querySelectorAll('th[data-k]').forEach(th=>{
  th.onclick=()=>{
    const k=th.dataset.k;
    if(sortKey===k) sortDir=-sortDir; else {sortKey=k; sortDir=(k==='sym')?1:-1;}
    document.querySelectorAll('th').forEach(x=>x.classList.remove('active'));
    th.classList.add('active');
    if(last) render(last);
  };
});

function dur(ms){
  if(!ms) return '—';
  const s=Math.floor(ms/1000);
  if(s<60) return s+'s';
  const m=Math.floor(s/60);
  return m<60 ? m+'m '+(s%60)+'s' : Math.floor(m/60)+'h '+(m%60)+'m';
}
function pct(v){return (v>0?'+':'')+v.toFixed(2)+'%';}
function cls(v){return v>0.001?'up':v<-0.001?'down':'flat';}
function price(p){return p>=1000?p.toLocaleString('en-IN',{maximumFractionDigits:2}):String(Number(p.toPrecision(6)));}

function badge(s){
  if(!s || s.state==='none') return '<span class="flat">—</span>';
  if(s.state==='qualified') return '<span class="badge b-qual">QUALIFIED</span>';
  if(s.state==='order') return '<span class="badge b-order">ORDER '+s.at+'</span>';
  if(s.state==='position') return '<span class="badge b-pos">IN '+s.at+'</span>';
  if(s.state==='closed') return '<span class="badge b-closed">CLOSED '+s.at+'</span>';
  if(s.state==='skipped') return '<span class="badge b-closed">SKIP</span>';
  return '—';
}

function render(d){
  last=d;
  document.getElementById('conn').textContent='● live';
  document.getElementById('conn').className='pill live';
  document.getElementById('mode').textContent=d.dryRun?'DRY RUN':'LIVE';
  document.getElementById('mode').className='pill '+(d.dryRun?'':'down');
  document.getElementById('state').textContent=d.botState;
  document.getElementById('qual').textContent=
    (d.entryMode==='rolling' ? 'slots '+d.slots+' · qualified '+d.qualified
                             : 'qualified '+d.qualified+'/'+d.needed);
  document.getElementById('qual').className='pill'+(d.positions.length?' live':'');

  const a=document.getElementById('agg');
  if(d.positions.length){
    a.textContent='PnL '+d.agg.gross.toFixed(3)+' / net '+d.agg.net.toFixed(3)+
      '  [T '+d.thresholds.target.toFixed(2)+' S '+d.thresholds.stop.toFixed(2)+']';
    a.className='pill '+(d.agg.gross>=0?'live':'down');
  } else { a.textContent='PnL —'; a.className='pill'; }

  document.getElementById('daily').textContent=
    'day '+d.dailyRealised.toFixed(3)+' · cycle '+d.cycle+'/'+d.maxCycles;

  const rows=[...d.symbols].sort((x,y)=>{
    const va=x[sortKey], vb=y[sortKey];
    if(typeof va==='string') return String(va).localeCompare(String(vb))*sortDir;
    if(sortKey==='status') return 0;
    return (va-vb)*sortDir;
  });

  document.getElementById('rows').innerHTML=rows.map(r=>{
    const prog=Math.min(100,(r.heldMs/d.holdNeededMs)*100);
    return '<tr>'+
      '<td class="sym">'+r.sym+'</td>'+
      '<td>'+price(r.price)+'</td>'+
      '<td class="'+cls(r.changePct)+'">'+pct(r.changePct)+'</td>'+
      '<td class="'+(r.heldMs?'warn':'flat')+'">'+dur(r.heldMs)+
        (r.heldMs?'<span class="bar"><i style="width:'+prog+'%"></i></span>':'')+'</td>'+
      '<td class="'+(r.pullbackPct<1?'up':r.pullbackPct>5?'down':'flat')+'">-'+r.pullbackPct.toFixed(2)+'%</td>'+
      '<td>'+badge(r.status)+'</td></tr>';
  }).join('');

  document.getElementById('pos').innerHTML=d.positions.map(p=>
    '<tr><td class="sym">'+p.sym+'</td><td>'+price(p.entry)+'</td><td>'+price(p.mark)+'</td>'+
    '<td class="'+cls(p.pnl)+'">'+p.pnl.toFixed(4)+'</td></tr>').join('');
  document.getElementById('posEmpty').style.display=d.positions.length?'none':'block';

  document.getElementById('events').innerHTML=d.events.map(e=>
    '<div class="ev '+e.level+'"><span class="t">'+
    new Date(e.ts).toLocaleTimeString()+'</span><span>'+
    e.msg.replace(/[<>]/g,'')+'</span></div>').join('');
}

const es=new EventSource('/events');
es.onmessage=e=>render(JSON.parse(e.data));
es.onerror=()=>{
  document.getElementById('conn').textContent='reconnecting…';
  document.getElementById('conn').className='pill warn';
};
</script></body></html>`;

module.exports = { start };
