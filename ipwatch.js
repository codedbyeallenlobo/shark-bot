'use strict';

/**
 * IP WATCH — pops a Windows notification the moment the API stops accepting
 * this machine's IP, and again when it comes back.
 *
 * Shark pins the API key to a whitelisted IP. When a consumer ISP rotates the
 * address, every signed call starts returning 403 while the PUBLIC websocket
 * feed keeps working — so the bots carry on looking healthy, keep placing
 * orders into a wall, and their books silently drift away from what the
 * exchange actually holds. Nothing in the bots' own logs makes that obvious:
 * the cause is buried under thousands of identical retry errors.
 *
 * This watches one cheap signed endpoint and tells you, once per state
 * change, with the new IP address ready to paste into the whitelist.
 *
 * Usage:
 *   node ipwatch.js
 *   node ipwatch.js --interval 20
 *   node ipwatch.js --park            also park the bots while blocked
 *
 *   --interval N   seconds between checks              (default 30)
 *   --park         write FINALEPIC_PARK while blocked, remove it on
 *                  recovery. Parking stops the bots placing NEW orders but
 *                  leaves resting take-profits live, so open positions keep
 *                  their exits. Off by default: it stops trading, which is a
 *                  bigger decision than sending a notification.
 *   --no-toast     log only, no Windows notification
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
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
const INTERVAL_S = Math.max(5, parseFloat(args.interval ?? 30));
const DO_PARK = args.flags.has('park');
const DO_TOAST = !args.flags.has('no-toast');

const PARK_FILE = path.join(__dirname, 'FINALEPIC_PARK');
const LOG = path.join(__dirname, 'ipwatch.log');
const TOAST = path.join(__dirname, 'toast.ps1');

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
function log(msg) {
  const line = `[${stamp()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch (e) { /* never throw from logging */ }
}

function toast(title, message) {
  if (!DO_TOAST) return;
  execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', TOAST,
                          '-Title', title, '-Message', message],
    { timeout: 15000 },
    (err, stdout) => {
      if (err) log(`toast failed: ${err.message}`);
      else if (String(stdout).trim() !== 'ok') log(`toast said: ${String(stdout).trim()}`);
    });
}

/** Pulls the offending address out of Shark's 403 body. */
function extractIp(msg) {
  const m = String(msg).match(/IP address not whitelisted:\s*([0-9a-fA-F.:]+)/);
  return m ? m[1] : null;
}

let blocked = null;          // null = unknown, true/false once established
let blockedSince = null;
let lastIp = null;

async function check() {
  let nowBlocked = false, ip = null, detail = '';
  try {
    await ex.walletBalance();
  } catch (e) {
    // Only a 403 means "not whitelisted". A timeout or a 5xx is the exchange
    // being unreachable, which is a different problem and must not raise a
    // whitelist alarm.
    if (/HTTP 403/.test(e.message) || /4009/.test(e.message)) {
      nowBlocked = true;
      ip = extractIp(e.message);
      detail = e.message.slice(0, 160);
    } else {
      log(`check failed (not a whitelist problem): ${e.message.slice(0, 120)}`);
      return;
    }
  }

  if (blocked === null) {
    // First reading: report the starting state so the log has a baseline.
    blocked = nowBlocked;
    if (nowBlocked) {
      blockedSince = Date.now(); lastIp = ip;
      log(`STARTING BLOCKED — IP ${ip || 'unknown'} is not whitelisted`);
      toast('Shark API blocked', `Whitelist this IP: ${ip || 'see ipwatch.log'}`);
    } else {
      log('starting OK — API accepts this IP');
    }
    return;
  }

  if (nowBlocked && !blocked) {
    blocked = true; blockedSince = Date.now(); lastIp = ip;
    log(`BLOCKED — IP ${ip || 'unknown'} is not whitelisted. ${detail}`);
    toast('Shark API blocked', `Bots cannot trade. Whitelist: ${ip || 'see ipwatch.log'}`);
    if (DO_PARK) {
      try {
        fs.writeFileSync(PARK_FILE, `parked by ipwatch at ${stamp()} — IP ${ip || 'unknown'}\n`);
        log('wrote FINALEPIC_PARK — bots will stop placing new orders (resting exits stay live)');
      } catch (e) { log(`could not write the park file: ${e.message}`); }
    }
    return;
  }

  if (nowBlocked && blocked && ip && ip !== lastIp) {
    // The address rotated again while still blocked — worth a fresh alert,
    // because the one you whitelisted a minute ago is already stale.
    lastIp = ip;
    log(`STILL BLOCKED, new IP — ${ip}`);
    toast('Shark IP changed again', `Now: ${ip}`);
    return;
  }

  if (!nowBlocked && blocked) {
    blocked = false;
    const mins = blockedSince ? ((Date.now() - blockedSince) / 60000).toFixed(0) : '?';
    log(`RESTORED after ${mins} min — API accepts this IP again`);
    toast('Shark API restored', `Whitelisted again after ${mins} min. Bots can trade.`);
    if (DO_PARK) {
      try {
        if (fs.existsSync(PARK_FILE)) {
          fs.unlinkSync(PARK_FILE);
          log('removed FINALEPIC_PARK — note that PARKED bots have ALREADY EXITED and need relaunching');
        }
      } catch (e) { log(`could not remove the park file: ${e.message}`); }
    }
  }
}

(async () => {
  if (DO_TOAST && !fs.existsSync(TOAST)) {
    log(`toast.ps1 not found at ${TOAST} — running with --no-toast`);
  }
  log(`ip watch started · checking every ${INTERVAL_S}s` +
      (DO_PARK ? ' · will PARK the bots while blocked' : '') +
      (DO_TOAST ? '' : ' · notifications off'));
  if (DO_PARK) {
    log('  note: parking makes each bot EXIT. Removing the park file does not');
    log('  bring them back — you still have to relaunch them.');
  }

  await check();
  setInterval(() => { check().catch(e => log(`watch error: ${e.message}`)); }, INTERVAL_S * 1000);
})();
