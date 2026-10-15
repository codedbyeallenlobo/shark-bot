'use strict';

const crypto = require('crypto');
const axios = require('axios');
const cfg = require('../config');

const KEY = process.env.SHARK_API_KEY;
const SECRET = process.env.SHARK_API_SECRET;

/**
 * Endpoints under /v1/market are public and take no signature.
 * Everything else is HMAC-SHA256 signed:
 *   GET/DELETE -> sign the query string
 *   POST/PATCH -> sign JSON.stringify(body)
 */
function isPublic(endpoint) {
  return endpoint.startsWith('/v1/market');
}

function sign(payload) {
  if (!SECRET) throw new Error('SHARK_API_SECRET not set');
  return crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
}

function authHeaders(signature) {
  return { 'api-key': KEY, signature, 'Content-Type': 'application/json' };
}

/** Turns an axios failure into a message that includes the API's own reason. */
function describe(e, endpoint) {
  if (e.response) {
    const b = e.response.data;
    const body = typeof b === 'string' ? b : JSON.stringify(b);
    return `${endpoint} -> HTTP ${e.response.status}: ${String(body).slice(0, 300)}`;
  }
  return `${endpoint} -> ${e.message}`;
}

/**
 * Cloudflare sits in front of this API and rate limits PER IP, separately from
 * the exchange's own per-account limit. A 429 from it means "stop asking", and
 * a retry is itself another request against the same counter — so retrying at
 * full speed guarantees the limit stays tripped.
 *
 * This gate is global to the process: once a 429 is seen, every call waits out
 * a shared cooldown that doubles with each consecutive 429 (1s, 2s, 4s … 60s)
 * and clears on the first success. It costs nothing when the API is healthy.
 */
let rateLimitedUntil = 0;
let rateLimitStreak = 0;

function rateLimitGate() {
  const wait = rateLimitedUntil - Date.now();
  if (wait <= 0) return null;
  return new Promise(r => setTimeout(r, wait));
}

function noteRateLimit(e) {
  const status = e && e.response && e.response.status;
  if (status !== 429) { rateLimitStreak = 0; return false; }
  rateLimitStreak = Math.min(rateLimitStreak + 1, 6);
  const backoff = Math.min(60000, 1000 * Math.pow(2, rateLimitStreak - 1));
  rateLimitedUntil = Date.now() + backoff;
  return true;
}

async function get(endpoint, params = {}) {
  const gate = rateLimitGate();
  if (gate) await gate;
  try {
    if (isPublic(endpoint)) {
      const { data } = await axios.get(`${cfg.REST_BASE}${endpoint}`, { timeout: 10000 });
      rateLimitStreak = 0;
      return data;
    }
    params.timestamp = Date.now().toString();
    const qs = new URLSearchParams(params).toString();
    const { data } = await axios.get(`${cfg.REST_BASE}${endpoint}?${qs}`, {
      headers: authHeaders(sign(qs)),
      timeout: 10000,
    });
    rateLimitStreak = 0;
    return data;
  } catch (e) {
    noteRateLimit(e);
    throw new Error(describe(e, `GET ${endpoint}`));
  }
}

async function post(endpoint, params = {}) {
  const gate = rateLimitGate();
  if (gate) await gate;
  try {
    params.timestamp = Date.now().toString();
    const body = JSON.stringify(params);
    const { data } = await axios.post(`${cfg.REST_BASE}${endpoint}`, params, {
      headers: authHeaders(sign(body)),
      timeout: 10000,
    });
    rateLimitStreak = 0;
    return data;
  } catch (e) {
    noteRateLimit(e);
    throw new Error(describe(e, `POST ${endpoint}`));
  }
}

async function del(endpoint, params = {}) {
  const gate = rateLimitGate();
  if (gate) await gate;
  try {
    params.timestamp = Date.now().toString();
    const body = JSON.stringify(params);
    const { data } = await axios.delete(`${cfg.REST_BASE}${endpoint}`, {
      headers: authHeaders(sign(body)),
      data: params,
      timeout: 10000,
    });
    rateLimitStreak = 0;
    return data;
  } catch (e) {
    noteRateLimit(e);
    throw new Error(describe(e, `DELETE ${endpoint}`));
  }
}

// ─── Contract metadata ───────────────────────────────────────────────────

let contractCache = null;
let conversionRates = null;

/** USDT->INR rate from exchangeInfo, or null if unavailable. */
function inrPerUsdt() {
  if (!conversionRates) return null;
  const r = parseFloat(conversionRates.INR_MARGIN_USDT ?? conversionRates.INR_SETTLEMENT_USDT);
  return isFinite(r) && r > 0 ? r : null;
}

/**
 * Fetches and flattens exchangeInfo into a lookup of symbol -> constraints.
 * Needed for quantity rounding, minimum sizes and per-symbol max leverage.
 *
 * Tries the signed request first, then falls back to unsigned — exchangeInfo
 * is reference data and is often readable without auth. This lets DRY_RUN
 * paper-trade before API credentials are sorted out.
 */
/**
 * Recursively walks the exchangeInfo response looking for contract objects.
 * The response shape is undocumented and varies, so rather than assume a
 * path we identify contracts by their distinguishing fields.
 */
function extractContracts(node, out = [], depth = 0) {
  if (!node || depth > 8) return out;

  if (Array.isArray(node)) {
    for (const item of node) extractContracts(item, out, depth + 1);
    return out;
  }
  if (typeof node !== 'object') return out;

  const isContract = node.name && (
    node.baseAsset || node.quoteAsset || node.filters ||
    node.maxLeverage || node.contractType || node.quantityPrecision !== undefined
  );
  if (isContract) { out.push(node); return out; }

  for (const v of Object.values(node)) extractContracts(v, out, depth + 1);
  return out;
}

async function loadContracts() {
  const attempts = [];

  if (KEY && SECRET) {
    attempts.push(['signed + market', () => get('/v1/exchange/exchangeInfo', { market: cfg.QUOTE_SUFFIX })]);
    attempts.push(['signed, no market', () => get('/v1/exchange/exchangeInfo', {})]);
  }
  attempts.push(['unsigned + market', async () =>
    (await axios.get(`${cfg.REST_BASE}/v1/exchange/exchangeInfo?market=${cfg.QUOTE_SUFFIX}`, { timeout: 10000 })).data]);
  attempts.push(['unsigned, no market', async () =>
    (await axios.get(`${cfg.REST_BASE}/v1/exchange/exchangeInfo`, { timeout: 10000 })).data]);

  let info = null;
  const failures = [];
  for (const [label, fn] of attempts) {
    try {
      info = await fn();
      if (info) { lastLoadMethod = label; break; }
    } catch (e) {
      failures.push(`${label}: ${e.message.slice(0, 160)}`);
    }
  }

  if (!info) {
    const err = new Error('exchangeInfo unavailable\n  ' + failures.join('\n  '));
    err.allAttemptsFailed = true;
    throw err;
  }

  // Stash conversion rates if the response carries them.
  (function findRates(node, depth = 0) {
    if (!node || depth > 6 || typeof node !== 'object') return;
    if (node.conversionRates && typeof node.conversionRates === 'object') {
      conversionRates = node.conversionRates;
      return;
    }
    for (const v of Object.values(node)) findRates(v, depth + 1);
  })(info);

  const found = extractContracts(info);

  if (found.length === 0) {
    const keys = info && typeof info === 'object' ? Object.keys(info) : typeof info;
    const sample = JSON.stringify(info).slice(0, 500);
    const err = new Error(
      `exchangeInfo returned data but no contracts were recognised.\n` +
      `  top-level keys: ${JSON.stringify(keys)}\n` +
      `  sample: ${sample}`
    );
    err.parseFailure = true;
    throw err;
  }

  const map = new Map();
  for (const c of found) {
    const filters = {};
    const rawFilters = Array.isArray(c.filters) ? c.filters
                     : (c.filters ? Object.values(c.filters) : []);
    for (const f of rawFilters) if (f && f.filterType) filters[f.filterType] = f;

    const qtyFilter = filters.LIMIT_QTY_SIZE || filters.MARKET_QTY_SIZE || {};

    map.set(String(c.name).toUpperCase(), {
      name: c.name,
      quantityPrecision: c.quantityPrecision ?? 3,
      pricePrecision: c.pricePrecision ?? 6,
      maxLeverage: parseFloat(c.maxLeverage) || 10,
      minQty: parseFloat(qtyFilter.minQty ?? 0) || 0,
      maxQty: parseFloat(qtyFilter.maxQty ?? Infinity) || Infinity,
      minNotional: parseFloat(filters.MIN_NOTIONAL?.notional ?? 0) || 0,
      makerFee: parseFloat(c.makerFee) || cfg.MAKER_FEE,
      takerFee: parseFloat(c.takerFee) || cfg.TAKER_FEE,
      // Max fractional distance a limit order may sit from the reference
      // price (e.g. 0.2 = 20%). Orders outside this band are rejected.
      limitPriceVarAllowed: parseFloat(c.limitPriceVarAllowed ?? 0.2) || 0.2,
      synthetic: false,
    });
  }

  contractCache = map;
  return map;
}

let lastLoadMethod = null;
function loadMethod() { return lastLoadMethod; }

/**
 * DRY-RUN ONLY fallback. If exchangeInfo can't be reached, derive plausible
 * precision from the observed price so paper trading can still run.
 * Approximate by design — never use this for live orders.
 */
function syntheticContract(symbol, price) {
  const mag = Math.floor(Math.log10(price));
  const pricePrecision = Math.max(0, Math.min(8, 5 - mag));
  const quantityPrecision = Math.max(0, Math.min(6, mag + 3));
  const c = {
    name: symbol, pricePrecision, quantityPrecision,
    maxLeverage: 10, minQty: 0, maxQty: Infinity, minNotional: 0,
    makerFee: cfg.MAKER_FEE, takerFee: cfg.TAKER_FEE,
    limitPriceVarAllowed: 0.2,
    synthetic: true,
  };
  if (!contractCache) contractCache = new Map();
  contractCache.set(symbol.toUpperCase(), c);
  return c;
}

function contract(symbol) {
  return contractCache ? contractCache.get(String(symbol).toUpperCase()) : null;
}

/** Test-only: inject contract metadata without hitting the network. */
function __setContracts(map) {
  contractCache = map;
}

// ─── Market data ─────────────────────────────────────────────────────────

/** Best bid / ask from the order book, plus spread as a percentage. */
async function bestQuote(symbol) {
  const res = await get(`/v1/market/depth/${symbol}`);
  const d = res.data || res;
  const bid = parseFloat(d.b?.[0]?.[0]);
  const ask = parseFloat(d.a?.[0]?.[0]);
  if (!isFinite(bid) || !isFinite(ask)) return null;
  return { bid, ask, spreadPct: ((ask - bid) / bid) * 100 };
}

/**
 * Last traded price — the price of the most recent executed trade, not
 * mark price and not the current best bid/ask. Historical by definition:
 * on a fast-moving symbol it can already be stale by the time an order
 * reaches the exchange. See ENTRY_PRICE_MODE in config for the tradeoff.
 */
async function lastTradedPrice(symbol) {
  const res = await get(`/v1/market/ticker24Hr/${symbol}`);
  const d = res.data || res;
  const price = parseFloat(d.c);
  return isFinite(price) ? price : null;
}

/**
 * Klines are public (under /v1/market) but the endpoint is POST, so the
 * generic signed post() (which requires SHARK_API_SECRET and always signs)
 * doesn't fit — this mirrors get()'s isPublic() branch instead.
 */
async function klines({ pair, interval, startTime, endTime, limit, priceType }) {
  const qs = priceType ? `?priceType=${priceType}` : '';
  const { data } = await axios.post(`${cfg.REST_BASE}/v1/market/klines${qs}`,
    { pair, interval, startTime, endTime, limit }, { timeout: 10000 });
  return Array.isArray(data) ? data : (data.data || []);
}

/**
 * The last FULLY COMPLETED hourly candle for a symbol — not the current,
 * still-forming hour. Returns null if no candle is available.
 */
async function previousHourlyCandle(symbol) {
  const HOUR = 60 * 60 * 1000;
  const currentHourStart = Math.floor(Date.now() / HOUR) * HOUR;
  const rows = await klines({
    pair: symbol, interval: '1h', priceType: 'LAST_PRICE',
    startTime: currentHourStart - HOUR, endTime: currentHourStart - 1, limit: 2,
  });
  if (!rows.length) return null;
  const k = rows[rows.length - 1];
  const open = parseFloat(k.open), high = parseFloat(k.high), low = parseFloat(k.low), close = parseFloat(k.close);
  if (![open, high, low, close].every(isFinite)) return null;
  return { open, high, low, close, startTime: k.startTime, endTime: k.endTime };
}

// ─── Sizing helpers ──────────────────────────────────────────────────────

function floorTo(value, precision) {
  const f = Math.pow(10, precision);
  return Math.floor(value * f) / f;
}

function roundTo(value, precision) {
  const f = Math.pow(10, precision);
  return Math.round(value * f) / f;
}

/**
 * Converts a USDT notional target into a base-asset quantity that satisfies
 * the contract's precision and minimum-size filters.
 * CRITICAL: the API takes quantity in BASE units (0.002 BTC), not USDT.
 */
function sizeOrder(symbol, notionalUsdt, price) {
  const c = contract(symbol);
  if (!c) return { ok: false, reason: 'contract not found' };

  const rawQty = notionalUsdt / price;
  const qty = floorTo(rawQty, c.quantityPrecision);

  if (qty <= 0) return { ok: false, reason: 'quantity rounds to zero' };
  if (qty < c.minQty) return { ok: false, reason: `below minQty ${c.minQty}` };
  if (qty > c.maxQty) return { ok: false, reason: `above maxQty ${c.maxQty}` };

  const notional = qty * price;
  if (notional < c.minNotional) {
    return { ok: false, reason: `notional ${notional.toFixed(4)} below min ${c.minNotional}` };
  }
  return { ok: true, qty, notional, price: roundTo(price, c.pricePrecision) };
}

// ─── Trading ─────────────────────────────────────────────────────────────

/** Leverage and margin mode must be set BEFORE any order exists (err 2305/2306). */
async function setPreference(symbol, leverage) {
  const c = contract(symbol);
  const lev = Math.min(leverage, c ? c.maxLeverage : leverage);
  const body = {
    contractName: symbol,
    marginMode: cfg.MARGIN_MODE,
    leverage: Math.floor(lev),
  };
  // Logged unconditionally so a future rejection shows exactly what left
  // the machine, not just what config.js says.
  console.log(`  [preference request] ${JSON.stringify(body)}`);
  return post('/v1/exchange/update/preference', body);
}

let resolvedMarginAsset = null;
function marginAssetInUse() { return resolvedMarginAsset || cfg.MARGIN_ASSET; }

/**
 * Places a limit order. The correct marginAsset for USDT-M contracts is
 * undocumented (every Shark template shows "INR"), so on a margin-asset
 * rejection we transparently retry with the alternative and remember
 * whichever one the exchange accepts.
 */
async function placeLimit({ symbol, side, quantity, price, reduceOnly = false, stopLossPrice = null }) {
  const candidates = resolvedMarginAsset
    ? [resolvedMarginAsset]
    : [cfg.MARGIN_ASSET, cfg.MARGIN_ASSET === 'USDT' ? 'INR' : 'USDT'];

  // Shark's error reporting for this endpoint is unreliable: an unsupported
  // marginAsset has been observed returning a generic 500 (error 3029,
  // "Order placement failed") instead of the documented 3012. So rather
  // than pattern-match the error text to decide whether to retry, every
  // candidate is tried unconditionally before giving up.
  let lastErr;
  for (const asset of candidates) {
    const body = {
      placeType: 'ORDER_FORM',
      symbol,
      side,
      type: 'LIMIT',
      quantity,
      price,
      reduceOnly,
      marginAsset: asset,
    };
    if (stopLossPrice !== null) body.stopLossPrice = stopLossPrice;

    console.log(`  [order attempt] marginAsset=${asset} ${JSON.stringify(body)}`);
    try {
      const res = await post('/v1/order/place-order', body);
      if (resolvedMarginAsset !== asset) {
        resolvedMarginAsset = asset;
        console.log(`  [margin asset resolved] ${symbol} accepts marginAsset=${asset}`);
      }
      return res;
    } catch (e) {
      lastErr = e;
      console.log(`  [order attempt failed] marginAsset=${asset}: ${e.message}`);

      // Error 3015: the exchange treats this order as reducing an existing
      // position, so it won't accept an attached stop. Retry the same order
      // without one rather than losing the entry entirely. The stop is only
      // dropped when the exchange actually refuses it — not pre-emptively.
      if (stopLossPrice !== null && /3015|reducing position|Take profit\/Stop loss/i.test(e.message)) {
        const retry = { ...body };
        delete retry.stopLossPrice;
        console.log(`  [retry without stop] exchange rejected the attached stop (3015)`);
        try {
          const res = await post('/v1/order/place-order', retry);
          if (resolvedMarginAsset !== asset) resolvedMarginAsset = asset;
          res.__stopDropped = true;
          return res;
        } catch (e2) {
          lastErr = e2;
          console.log(`  [retry without stop failed] ${e2.message}`);
        }
      }
    }
  }
  throw lastErr;
}

/**
 * Places a standalone STOP_LIMIT order — triggers once the market reaches
 * stopPrice, then rests as a LIMIT at price. Unlike placeLimit's optional
 * stopLossPrice (an attached param Shark rejects once a position exists,
 * error 3015), this is its own independent order and isn't subject to that
 * restriction.
 */
async function placeStopLimit({ symbol, side, quantity, stopPrice, price, reduceOnly = false }) {
  const candidates = resolvedMarginAsset
    ? [resolvedMarginAsset]
    : [cfg.MARGIN_ASSET, cfg.MARGIN_ASSET === 'USDT' ? 'INR' : 'USDT'];

  let lastErr;
  for (const asset of candidates) {
    const body = {
      placeType: 'ORDER_FORM',
      symbol,
      side,
      type: 'STOP_LIMIT',
      quantity,
      stopPrice,
      price,
      reduceOnly,
      marginAsset: asset,
    };

    console.log(`  [stop-limit attempt] marginAsset=${asset} ${JSON.stringify(body)}`);
    try {
      const res = await post('/v1/order/place-order', body);
      if (resolvedMarginAsset !== asset) {
        resolvedMarginAsset = asset;
        console.log(`  [margin asset resolved] ${symbol} accepts marginAsset=${asset}`);
      }
      return res;
    } catch (e) {
      lastErr = e;
      console.log(`  [stop-limit attempt failed] marginAsset=${asset}: ${e.message}`);
    }
  }
  throw lastErr;
}

/**
 * Places a standalone STOP_MARKET order — triggers once the market reaches
 * stopPrice, then executes immediately at whatever price is available.
 * Unlike STOP_LIMIT, there is no separate limit leg that can fail to fill:
 * once triggered this always closes the position, trading price certainty
 * for execution certainty. No `price` field — STOP_MARKET doesn't take one.
 */
async function placeStopMarket({ symbol, side, quantity, stopPrice, reduceOnly = false }) {
  const candidates = resolvedMarginAsset
    ? [resolvedMarginAsset]
    : [cfg.MARGIN_ASSET, cfg.MARGIN_ASSET === 'USDT' ? 'INR' : 'USDT'];

  let lastErr;
  for (const asset of candidates) {
    const body = {
      placeType: 'ORDER_FORM',
      symbol,
      side,
      type: 'STOP_MARKET',
      quantity,
      stopPrice,
      reduceOnly,
      marginAsset: asset,
    };

    console.log(`  [stop-market attempt] marginAsset=${asset} ${JSON.stringify(body)}`);
    try {
      const res = await post('/v1/order/place-order', body);
      if (resolvedMarginAsset !== asset) {
        resolvedMarginAsset = asset;
        console.log(`  [margin asset resolved] ${symbol} accepts marginAsset=${asset}`);
      }
      return res;
    } catch (e) {
      lastErr = e;
      console.log(`  [stop-market attempt failed] marginAsset=${asset}: ${e.message}`);
    }
  }
  throw lastErr;
}

async function cancelOrder(clientOrderId) {
  return del('/v1/order/delete-order', { clientOrderId });
}

async function openOrders(symbol) {
  return get('/v1/order/open-orders', symbol ? { symbol } : {});
}

async function positions(status = 'OPEN') {
  return get(`/v1/positions/${status}`);
}

/**
 * Closed-position history, newest first.
 *
 * Each record carries `realizedProfit` (and `realizedProfitInMarginAsset`,
 * already in INR) as the exchange itself computed it, plus `positionStatus`
 * — which is where a LIQUIDATED position is visible. This is the only
 * trustworthy source of realised PnL: inferring it from wallet balances
 * cannot work, because the wallet figure is the FREE balance and moves
 * whenever margin locks or unlocks.
 *
 * Note it is GROSS of commission. Verified against the fills: it equals
 * (exit - entry) x qty to the paisa. Fees are charged separately and are
 * not reported by any endpoint, so callers must model them from the
 * contract's makerFee/takerFee.
 *
 * Supported filters (others return HTTP 400):
 *   symbol          e.g. 'AKEUSDT'  — one symbol only
 *   pageSize        row cap, MINIMUM 5 (smaller is rejected); the
 *                   unfiltered call returns ~2,900 rows / 2 MB
 *   startTimestamp  epoch ms lower bound
 */
async function positionHistory({ symbol, pageSize, startTimestamp } = {}) {
  const params = {};
  if (symbol) params.symbol = symbol;
  if (pageSize) params.pageSize = String(Math.max(5, pageSize));
  if (startTimestamp) params.startTimestamp = String(startTimestamp);
  const res = await get('/v1/positions/history', params);
  return Array.isArray(res) ? res : (res && res.data) || [];
}

/**
 * Futures wallet balance in USDT terms, or null if it can't be determined.
 * Used to refuse ladders the account can't actually fund.
 */
/**
 * True if the account already holds a position in this symbol.
 * Matters because Shark rejects stopLossPrice/takeProfitPrice on any order
 * it classifies as reducing an existing position (error 3015), and refuses
 * margin-mode changes while a position is open (error 2313).
 */
async function hasOpenPosition(symbol) {
  try {
    const res = await positions('OPEN');
    const list = Array.isArray(res) ? res : (res.data || res.positions || []);
    const want = String(symbol).toUpperCase().replace(/[-_]/g, '');
    return list.some(p => {
      const sym = String(p.contractPair || p.symbol || p.name || '')
        .toUpperCase().replace(/[-_]/g, '');
      return sym === want;
    });
  } catch (e) {
    return null;   // unknown — caller decides how cautious to be
  }
}

/**
 * Cancels every open order on a symbol and reports how many were killed.
 * Critical for ladder bots: an unfilled reduce-only order can outlive the
 * position it was meant to close and later fill as a NEW position in the
 * opposite direction. It also blocks stop attachment (error 3015).
 */
async function cancelAllOrders(symbol) {
  const res = await openOrders(symbol);
  const list = Array.isArray(res) ? res : (res.data || res.orders || []);
  const want = String(symbol).toUpperCase().replace(/[-_]/g, '');

  const mine = list.filter(o => {
    const sym = String(o.symbol || o.contractPair || o.name || '')
      .toUpperCase().replace(/[-_]/g, '');
    return sym === want;
  });

  const results = { found: mine.length, cancelled: 0, failed: [] };
  for (const o of mine) {
    const id = o.clientOrderId || o.clientOrderID || o.linkId;
    if (!id) { results.failed.push('unknown-id'); continue; }
    try {
      await cancelOrder(id);
      results.cancelled++;
    } catch (e) {
      results.failed.push(`${id}: ${e.message.slice(0, 80)}`);
    }
  }
  return results;
}

/** Net position size for a symbol, or null if it can't be determined. */
async function positionSize(symbol) {
  try {
    const res = await positions('OPEN');
    const list = Array.isArray(res) ? res : (res.data || res.positions || []);
    const want = String(symbol).toUpperCase().replace(/[-_]/g, '');
    for (const p of list) {
      const sym = String(p.contractPair || p.symbol || p.name || '')
        .toUpperCase().replace(/[-_]/g, '');
      if (sym !== want) continue;
      const q = parseFloat(p.positionAmt ?? p.quantity ?? p.size ?? p.amount);
      if (isFinite(q)) return Math.abs(q);
    }
    return 0;
  } catch (e) {
    return null;
  }
}

async function walletBalance() {
  const res = await get('/v1/wallet/futures-wallet/details', {});
  const d = res && (res.data || res);
  if (!d) return null;
  const raw = d.walletBalance ?? d.marginBalance ?? d.inrBalance;
  const val = parseFloat(raw);
  if (!isFinite(val)) return null;
  // The endpoint reports in the wallet's margin asset. If that's INR,
  // convert to USDT so the comparison against notional figures is valid.
  const asset = String(d.marginAsset || '').toUpperCase();
  if (asset === 'INR') return val / 88;
  return val;
}

async function createListenKey() {
  return post('/v1/retail/listen-key', {});
}

async function keepAliveListenKey() {
  const params = { timestamp: Date.now().toString() };
  const body = JSON.stringify(params);
  const { data } = await axios.put(`${cfg.REST_BASE}/v1/retail/listen-key`, params, {
    headers: authHeaders(sign(body)),
    timeout: 10000,
  });
  return data;
}

module.exports = {
  loadContracts, contract, __setContracts, bestQuote, lastTradedPrice, sizeOrder, klines, previousHourlyCandle,
  syntheticContract, loadMethod, marginAssetInUse, inrPerUsdt,
  setPreference, placeLimit, placeStopLimit, placeStopMarket, cancelOrder, openOrders, positions, walletBalance, hasOpenPosition, cancelAllOrders, positionSize, positionHistory,
  createListenKey, keepAliveListenKey,
  floorTo, roundTo,
};
