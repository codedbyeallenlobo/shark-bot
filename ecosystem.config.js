// pm2 launch config for finalepicbot on the Oracle VPS.
//
// This is the Linux stand-in for traybot.pyw: --symbols A,B,C fans out into one
// process per symbol there, and pm2 does the same job here, plus restarts and
// boot persistence.
//
//   pm2 start ecosystem.config.js     start all nine
//   pm2 stop all                      stop them (positions stay open)
//   pm2 logs bot-TIAUSDT              follow one symbol
//   pm2 ls                            status table
//
// Symbol set replaced 2026-10-11. Every symbol below was checked against
// ex.sizeOrder(sym, 6, price) before going live, which is the check that would
// have caught INJUSDT: at 6 USDT its quantity rounded down to a notional of
// 5.30, under the 5.75 minimum, and it rejected ~479 orders in 8 minutes.
//
// CAUTION - TIAUSDT. It trades in whole units and 6 USDT buys only 10 of them,
// so each rounding step is 10% of the notional. At 0.5847 it sizes to 5.85,
// barely over the 5.75 minimum. Above roughly 0.639 the quantity drops to 9,
// the notional falls under the minimum, and it will reject every order the way
// INJUSDT did. Watch it, or give it its own larger --usdt.

const SYMBOLS = [
  'SUSDT', 'STRKUSDT', 'CHIPUSDT', 'MAGICUSDT', 'LUMIAUSDT',
  'GRASSUSDT', 'BATUSDT', 'MANTAUSDT', 'TIAUSDT',
];

// --max-hold-min 180 --only-red added 2026-10-12, from 92 trades in
// finalepic-mae.csv (86 winners +275.1 INR, 6 losers -134.7, net +140.4).
//
// Every loser ran long; winners finish fast (median 9.1 min, p75 62 min).
// One trade, GRASSUSDT at 570 min for -100.36, was 75% of all losses.
// At 180 min only ~13% of winners reach a checkpoint at all, putting 33.3 INR
// of winner profit at risk against 116.3 INR of losses addressed. Shorter
// thresholds catch only three trivial losers (-17.8 INR total) while exposing
// a third more winners.
//
// --only-red is what makes this safe: the deadline becomes a REPEATING
// checkpoint that closes a position only if it is worse than -0.05 USDT.
// Green positions are spared and re-checked at 360, 540, ... minutes.
// Without it, every position closes at 180 minutes regardless of PnL.
const FLAGS = [
  '--usdt', '6',
  '--tp', '4',
  // Two different jobs, deliberately both armed:
  //
  //   --bail-floating 200  drawdown cap on the OPEN book alone. Realised
  //                        history is excluded, so banked profit cannot mask
  //                        a developing loss. This is the one that matches
  //                        "when the net of positions is past -200, close
  //                        everything".
  //   --bail-at 200        session equity floor: realised since the baseline
  //                        PLUS floating. Lets winnings absorb losses and
  //                        only fires when the whole session is underwater.
  //
  // With +172 INR realised against the 17:32 baseline, --bail-at alone would
  // not have fired until the open book was 372 INR down. That gap is why
  // --bail-floating exists.
  '--bail-floating', '200',
  '--bail-at', '200',
  '--max-hold-min', '180',
  '--only-red',
  '--start-side', 'short',
  '--no-alternate',
  '--reentry-better',
  '--levels', '1',
  '--live',
].join(' ');

module.exports = {
  apps: SYMBOLS.map((symbol) => ({
    name: `bot-${symbol}`,
    script: 'finalepicbot.js',
    args: `--symbol ${symbol} ${FLAGS}`,
    cwd: '/home/opc/shark-bot',
    interpreter: '/opt/node22/bin/node',

    // One process per symbol, never more: the bot's own symbol lock is the
    // real guarantee, but there is no reason for pm2 to fight it.
    instances: 1,
    exec_mode: 'fork',

    autorestart: true,

    // halt() exits 0 (finalepicbot.js:3140). That covers the deliberate stops:
    // --bail-at firing, --max-loss, a clean shutdown. None of those should ever
    // be restarted, so pm2 must treat exit 0 as final.
    //
    // This is not theoretical. On 2026-10-11 the bail tripped at -303.41 INR,
    // every bot halted with exit 0, pm2 restarted them, each one hit the
    // FINALEPIC_BAIL guard at :3349 and exited 1, and pm2 restarted them again
    // - about 125 times per bot, every cycle making API calls at boot.
    // max_restarts: 10 did NOT stop it.
    stop_exit_codes: [0],

    // For genuine crashes, back off instead of hammering. Rising delay means a
    // persistent failure costs a handful of requests an hour, not thousands.
    exp_backoff_restart_delay: 5000,

    // Belt and braces behind stop_exit_codes. Do not rely on these alone.
    min_uptime: '60s',
    max_restarts: 10,

    // A bot sits at ~22-30 MB. 100 MB means something is leaking, and on a
    // 498 MB box one runaway process would take the other eight down with it.
    // Restart it instead - the bot reconciles with the exchange on boot.
    max_memory_restart: '100M',

    error_file: `/home/opc/shark-bot/logs/${symbol}-err.log`,
    out_file: `/home/opc/shark-bot/logs/${symbol}-out.log`,
    time: true,
  })),
};
