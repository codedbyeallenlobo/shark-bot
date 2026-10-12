'use strict';

const axios = require('axios');
const cfg = require('../config');
const log = require('./logger');

/**
 * Multi-channel alerting. Every channel is optional and independent —
 * a failure in one never blocks the others, and none can crash the bot.
 * Position management must never depend on a notification succeeding.
 */

// ─── console + terminal bell (always on, zero setup) ─────────────────────

function viaConsole(text) {
  const bar = '='.repeat(64);
  // \x07 rings the terminal bell — audible if your terminal has it enabled
  process.stdout.write('\x07');
  console.log(`\x1b[41m\x1b[97m${bar}\x1b[0m`);
  console.log(`\x1b[41m\x1b[97m  ALERT: ${text}\x1b[0m`);
  console.log(`\x1b[41m\x1b[97m${bar}\x1b[0m`);
  return true;
}

// ─── Telegram (free, no subscription) ────────────────────────────────────

async function viaTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;

  await axios.post(
    `https://api.telegram.org/bot${token}/sendMessage`,
    { chat_id: chatId, text: `[shark-bot] ${text}` },
    { timeout: 8000 }
  );
  return true;
}

// ─── Generic webhook (Make.com, n8n, Zapier, your own endpoint) ──────────

async function viaWebhook(text) {
  const url = process.env.NOTIFY_WEBHOOK_URL || process.env.MAKE_WEBHOOK_URL;
  if (!url) return false;

  await axios.post(url, { text, ts: new Date().toISOString() }, { timeout: 8000 });
  return true;
}

// ─── Dispatcher ──────────────────────────────────────────────────────────

const CHANNELS = { console: viaConsole, telegram: viaTelegram, webhook: viaWebhook };

async function send(text) {
  log.warn(`NOTIFY: ${text}`);

  const delivered = [];
  for (const name of cfg.NOTIFY_CHANNELS) {
    const fn = CHANNELS[name];
    if (!fn) {
      log.warn(`unknown notify channel "${name}"`);
      continue;
    }
    try {
      if (await fn(text)) delivered.push(name);
    } catch (e) {
      log.error(`notify via ${name} failed: ${e.message}`);
    }
  }

  if (delivered.length === 0) log.warn('no notification channel delivered — check .env');
  return delivered;
}

module.exports = { send };
