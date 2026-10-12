'use strict';

const { io } = require('socket.io-client');
const EventEmitter = require('events');
const cfg = require('../config');

/**
 * Public market-data feed. Mirrors the browser scanner's logic:
 * session anchor price, session high, and continuous time spent at or above
 * the hold threshold. Emits 'tick' after each batch of prices.
 */
class Feed extends EventEmitter {
  constructor() {
    super();
    this.state = new Map();      // symbol -> {price, anchor, high, aboveSince, lastSeen}
    this.startedAt = Date.now();
    this.connected = false;
    this.ticks = 0;
  }

  start() {
    this.socket = io(cfg.WS_PUBLIC, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: Infinity,
      timeout: 20000,
    });

    this.socket.on('connect', () => {
      this.connected = true;
      this.socket.emit('subscribe', { params: ['markPriceArr'] });
      this.emit('status', 'connected');
    });

    this.socket.on('disconnect', () => {
      this.connected = false;
      this.emit('status', 'disconnected');
    });

    this.socket.on('connect_error', (e) => this.emit('status', `error: ${e.message}`));
    this.socket.on('markPriceArr', (msg) => this._ingest(msg));

    return this;
  }

  stop() {
    if (this.socket) this.socket.close();
  }

  /** Payload shape is undocumented, so field names are probed defensively. */
  _ingest(msg) {
    const arr = Array.isArray(msg) ? msg : (msg && (msg.data || msg.result));
    if (!Array.isArray(arr)) return;

    const now = Date.now();
    for (const item of arr) {
      const rawSym = item.s || item.symbol || item.contractPair || item.pair;
      const rawPrice = item.p || item.markPrice || item.price || item.c;
      if (!rawSym) continue;

      const symbol = String(rawSym).toUpperCase().replace(/[-_]/g, '');
      if (!symbol.endsWith(cfg.QUOTE_SUFFIX)) continue;

      const price = parseFloat(rawPrice);
      if (!isFinite(price) || price <= 0) continue;

      let s = this.state.get(symbol);
      if (!s) {
        s = { price, anchor: price, high: price, aboveSince: null, lastSeen: now };
        this.state.set(symbol, s);
      }

      s.price = price;
      s.lastSeen = now;
      if (price > s.high) s.high = price;

      const changePct = ((price - s.anchor) / s.anchor) * 100;
      if (changePct >= cfg.HOLD_THRESHOLD_PCT) {
        if (s.aboveSince === null) s.aboveSince = now;
      } else {
        s.aboveSince = null;
      }
    }

    this.ticks++;
    this.emit('tick', this.state);
  }

  snapshot(symbol) {
    const s = this.state.get(symbol);
    if (!s) return null;
    const now = Date.now();
    return {
      symbol,
      price: s.price,
      anchor: s.anchor,
      changePct: ((s.price - s.anchor) / s.anchor) * 100,
      high: s.high,
      pullbackPct: ((s.high - s.price) / s.high) * 100,
      heldMs: s.aboveSince ? now - s.aboveSince : 0,
    };
  }

  /**
   * Symbols currently at or above the hold threshold for long enough,
   * ranked by session change (strongest first).
   */
  qualified() {
    const out = [];
    for (const symbol of this.state.keys()) {
      const s = this.snapshot(symbol);
      if (s && s.heldMs >= cfg.HOLD_DURATION_MS) out.push(s);
    }
    return out.sort((a, b) => b.changePct - a.changePct);
  }

  /** Symbols close to qualifying, for progress reporting during the wait. */
  nearlyQualified(n = 8) {
    const out = [];
    for (const symbol of this.state.keys()) {
      const s = this.snapshot(symbol);
      if (s && s.heldMs > 0) out.push(s);
    }
    return out.sort((a, b) => b.heldMs - a.heldMs).slice(0, n);
  }
}

module.exports = Feed;
