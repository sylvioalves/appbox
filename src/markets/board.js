'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const https = require('https');
const path = require('path');
const config = require('../main/config');
const { guard, guardOn } = require('../main/ipc');

const YF = 'https://query1.finance.yahoo.com';
const STATE_DIR = path.join(config.paths.state, 'markets');
const DEFAULT_LIST = ['BTC-USD', 'ETH-USD', '^BVSP', 'USDBRL=X'];
const CURRENCIES = ['native', 'BRL', 'USD', 'EUR'];
const LIVE_MS = 60 * 1000;
const QUIET_MS = 5 * 60 * 1000;
const HIDDEN_MS = 30 * 60 * 1000;
const RETRY_MS = 2 * 60 * 1000;
const PARALLEL = 4;
const LIST_MAX = 50;
const MAX_POINTS = 400;
const SPARK_POINTS = 80;
const SYMBOL_RE = /^[A-Za-z0-9^=.-]{1,24}$/;
const FETCH_TIMEOUT_MS = 20 * 1000;
const MAX_BODY = 4 * 1024 * 1024;
const RANGES = {
  '1D': { range: '1d', interval: '5m', ttl: 60 * 1000, span: 86400, spanInterval: '5m' },
  '1W': { range: '5d', interval: '15m', ttl: 5 * 60 * 1000, span: 7 * 86400, spanInterval: '30m' },
  '1M': { range: '1mo', interval: '1h', ttl: 30 * 60 * 1000 },
  '1Y': { range: '1y', interval: '1d', ttl: 6 * 3600 * 1000 },
  '5Y': { range: '5y', interval: '1wk', ttl: 12 * 3600 * 1000 },
};
const KINDS = {
  EQUITY: 'Stock',
  ETF: 'ETF',
  CRYPTOCURRENCY: 'Crypto',
  INDEX: 'Index',
  CURRENCY: 'Currency',
  MUTUALFUND: 'Fund',
  FUTURE: 'Future',
};
const MINOR_UNITS = { GBp: 'GBP', GBX: 'GBP', ILA: 'ILS', ZAc: 'ZAR' };

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'appbox', Accept: 'application/json' }, timeout: FETCH_TIMEOUT_MS }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          req.destroy(new Error('response too large'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (err) {
          reject(err);
        }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

function thin(pts, max) {
  if (pts.length <= max) {
    return pts;
  }
  const step = (pts.length - 1) / (max - 1);
  const out = [];
  for (let i = 0; i < max; i++) {
    out.push(pts[Math.round(i * step)]);
  }
  return out;
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function scale(v, k) {
  return v === null ? null : v * k;
}

/* Price in a minor unit (pence, agorot, cents) -> major unit. */
function major(currency) {
  const cur = MINOR_UNITS[currency];
  return cur ? { currency: cur, k: 0.01 } : { currency: currency || 'USD', k: 1 };
}

/* Rate at time t from an ascending [t, rate] series: last known rate. */
function rateAt(series, t) {
  let lo = 0;
  let hi = series.length - 1;
  if (t <= series[0][0]) {
    return series[0][1];
  }
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (series[mid][0] <= t) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return series[lo][1];
}

function marketState(q, now = Date.now() / 1000) {
  if (q.kind === 'Crypto') {
    return 'always';
  }
  const in_ = (p) => p && now >= p.start && now < p.end;
  if (in_(q.session)) {
    return 'open';
  }
  if (in_(q.pre)) {
    return 'pre';
  }
  if (in_(q.post)) {
    return 'post';
  }
  return 'closed';
}

class MarketBoard extends EventEmitter {
  constructor(svc, ctx) {
    super();
    this.svc = svc;
    this.ctx = ctx;
    this.stateFile = path.join(STATE_DIR, `${svc.id}.json`);
    this.state = { list: null, currency: 'native', quotes: {}, fetchedAt: 0 };
    this.cache = new Map();
    this.inflight = new Map();
    this.visible = false;
    this.loading = false;
    this.error = null;
    this.stopped = false;
  }

  init() {
    const saved = readJson(this.stateFile, {}) || {};
    const list = Array.isArray(saved.list) ? saved.list
      : (Array.isArray(this.svc.symbols) ? this.svc.symbols : DEFAULT_LIST);
    this.state = {
      list: [...new Set(list.map(String).filter((s) => SYMBOL_RE.test(s)))].slice(0, LIST_MAX),
      currency: CURRENCIES.includes(saved.currency) ? saved.currency : 'native',
      quotes: saved.quotes && typeof saved.quotes === 'object' && !Array.isArray(saved.quotes) ? saved.quotes : {},
      fetchedAt: Number(saved.fetchedAt) || 0,
    };
    this.schedule(0);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  forget() {
    this.stop();
    fs.rmSync(this.stateFile, { force: true });
  }

  save() {
    if (this.stopped) {
      return;
    }
    try {
      writeJson(this.stateFile, this.state);
    } catch (err) {
      console.error(`${this.svc.id}: save state: ${err.message}`);
    }
  }

  schedule(ms) {
    if (this.stopped) {
      return;
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.poll(), ms);
  }

  refresh() {
    for (const key of this.cache.keys()) {
      if (key.endsWith('|1D')) {
        this.cache.delete(key);
      }
    }
    this.schedule(0);
  }

  setActive(on) {
    const was = this.visible;
    this.visible = Boolean(on);
    if (this.visible && !was && Date.now() - this.state.fetchedAt > LIVE_MS) {
      this.schedule(0);
    }
  }

  nextDelay() {
    if (this.error) {
      return RETRY_MS;
    }
    if (!this.visible) {
      return HIDDEN_MS;
    }
    const live = this.state.list.some((s) => this.state.quotes[s] && marketState(this.state.quotes[s]) !== 'closed');
    return live ? LIVE_MS : QUIET_MS;
  }

  async poll() {
    if (this.loading || this.stopped) {
      return;
    }
    this.loading = true;
    this.error = null;
    this.emit('status', this.status());
    const syms = [...this.state.list];
    let failed = 0;
    let next = 0;
    const worker = async () => {
      while (next < syms.length) {
        const sym = syms[next++];
        try {
          await this.series(sym, '1D', true);
        } catch (err) {
          failed++;
          console.error(`${this.svc.id}: ${sym}: ${err.message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    await this.loadRates().catch((err) => {
      failed++;
      console.error(`${this.svc.id}: rates: ${err.message}`);
    });
    this.loading = false;
    if (failed > 0 && failed >= syms.length) {
      this.error = 'Market data could not be fetched';
    } else {
      this.state.fetchedAt = Date.now();
      this.error = failed > 0 ? `${failed} symbol${failed === 1 ? '' : 's'} could not be fetched` : null;
    }
    this.save();
    this.emit('status', this.status());
    this.emit('data');
    this.schedule(this.error && failed >= syms.length ? RETRY_MS : this.nextDelay());
  }

  url(sym, rk, crypto) {
    const r = RANGES[rk];
    const base = `${YF}/v8/finance/chart/${encodeURIComponent(sym)}`;
    if (crypto && r.span) {
      const now = Math.floor(Date.now() / 1000);
      return `${base}?period1=${now - r.span}&period2=${now}&interval=${r.spanInterval}`;
    }
    return `${base}?range=${r.range}&interval=${r.interval}`;
  }

  /* Raw chart for one symbol and range, cached for the range TTL. */
  async series(sym, rk, force = false) {
    const key = `${sym}|${rk}`;
    const hit = this.cache.get(key);
    if (hit && !force && Date.now() - hit.at < RANGES[rk].ttl) {
      return hit;
    }
    if (this.inflight.has(key)) {
      return this.inflight.get(key);
    }
    const job = (async () => {
      const known = this.state.quotes[sym];
      const crypto = known ? known.kind === 'Crypto' : /-USD$/.test(sym);
      const body = await fetchJson(this.url(sym, rk, crypto));
      const chart = body && body.chart;
      const result = chart && chart.result && chart.result[0];
      if (!result) {
        const msg = chart && chart.error ? chart.error.description : 'no data';
        throw new Error(msg);
      }
      const meta = result.meta || {};
      const ts = result.timestamp || [];
      const ind = (((result.indicators || {}).quote || [])[0] || {});
      const close = ind.close || [];
      const firstOpen = (ind.open || []).find((v) => num(v) !== null);
      const { k } = major(meta.currency);
      const pts = [];
      for (let i = 0; i < ts.length; i++) {
        if (num(close[i]) !== null) {
          pts.push([ts[i], close[i] * k]);
        }
      }
      const price = num(meta.regularMarketPrice);
      if (price !== null && pts.length > 0 && rk !== '5Y') {
        const t = num(meta.regularMarketTime) || pts[pts.length - 1][0];
        if (t > pts[pts.length - 1][0]) {
          pts.push([t, price * k]);
        } else {
          pts[pts.length - 1] = [pts[pts.length - 1][0], price * k];
        }
      }
      const out = { at: Date.now(), meta, pts: thin(pts, MAX_POINTS) };
      this.cache.set(key, out);
      if (rk === '1D') {
        this.state.quotes[sym] = this.quoteFrom(sym, meta, pts, firstOpen);
      }
      return out;
    })();
    this.inflight.set(key, job);
    try {
      return await job;
    } finally {
      this.inflight.delete(key);
    }
  }

  quoteFrom(sym, meta, pts, firstOpen) {
    const { currency, k } = major(meta.currency);
    const kind = KINDS[meta.instrumentType] || 'Stock';
    const tp = meta.currentTradingPeriod || {};
    const period = (p) => (p && num(p.start) && num(p.end) ? { start: p.start, end: p.end } : null);
    const crypto = kind === 'Crypto' && pts.length > 0;
    const vals = pts.map((p) => p[1]);
    const prev = crypto ? pts[0][1] : scale(num(meta.previousClose) ?? num(meta.chartPreviousClose), k);
    const name = meta.longName || meta.shortName || sym;
    return {
      symbol: sym,
      name: kind === 'Crypto' ? name.replace(/\s+USD$/, '') : name,
      kind,
      currency,
      exchange: kind === 'Crypto' ? 'Crypto' : (meta.fullExchangeName || meta.exchangeName || ''),
      tz: meta.exchangeTimezoneName || null,
      price: scale(num(meta.regularMarketPrice), k),
      prevClose: prev,
      open: num(firstOpen) !== null ? firstOpen * k : (pts.length > 0 ? pts[0][1] : null),
      high: crypto ? Math.max(...vals) : scale(num(meta.regularMarketDayHigh), k),
      low: crypto ? Math.min(...vals) : scale(num(meta.regularMarketDayLow), k),
      volume: num(meta.regularMarketVolume),
      low52: scale(num(meta.fiftyTwoWeekLow), k),
      high52: scale(num(meta.fiftyTwoWeekHigh), k),
      time: num(meta.regularMarketTime),
      session: period(tp.regular),
      pre: period(tp.pre),
      post: period(tp.post),
      spark: thin(pts, SPARK_POINTS),
    };
  }

  target(cur) {
    const t = this.state.currency;
    return t === 'native' || t === cur ? null : t;
  }

  pairs() {
    const out = new Set();
    for (const sym of this.state.list) {
      const q = this.state.quotes[sym];
      const t = q && this.target(q.currency);
      if (t) {
        out.add(`${q.currency}${t}=X`);
      }
    }
    return [...out];
  }

  async loadRates() {
    await Promise.all(this.pairs().map((p) => this.series(p, '1D', true)));
  }

  rate(from) {
    const to = this.target(from);
    if (!to) {
      return { now: 1, prev: 1, to: from };
    }
    const q = this.state.quotes[`${from}${to}=X`];
    if (!q || !q.price) {
      return null;
    }
    return { now: q.price, prev: q.prevClose || q.price, to };
  }

  view(q) {
    const r = this.rate(q.currency);
    const out = { ...q, spark: q.spark || [], state: marketState(q), native: q.currency, nativePrice: q.price };
    if (!r || r.to === q.currency) {
      return out;
    }
    const k = r.now;
    return {
      ...out,
      currency: r.to,
      price: scale(q.price, k),
      prevClose: scale(q.prevClose, r.prev),
      open: scale(q.open, k),
      high: scale(q.high, k),
      low: scale(q.low, k),
      low52: scale(q.low52, k),
      high52: scale(q.high52, k),
      spark: out.spark.map(([t, v]) => [t, v * k]),
    };
  }

  status() {
    return {
      state: this.loading ? 'loading' : (this.error ? 'error' : 'idle'),
      error: this.error,
      fetchedAt: this.state.fetchedAt,
    };
  }

  data() {
    return {
      status: this.status(),
      currency: this.state.currency,
      currencies: CURRENCIES,
      list: this.state.list.map((sym) => {
        const q = this.state.quotes[sym];
        return q ? this.view(q) : { symbol: sym, name: sym, pending: true };
      }),
    };
  }

  /* One range for the chart, in the display currency. */
  async chart(sym, rk) {
    if (!RANGES[rk] || !SYMBOL_RE.test(sym)) {
      throw new Error('bad request');
    }
    const s = await this.series(sym, rk);
    const q = this.state.quotes[sym] || this.quoteFrom(sym, s.meta, s.pts);
    let pts = s.pts;
    let base = rk === '1D' ? q.prevClose : (pts.length > 0 ? pts[0][1] : null);
    let currency = q.currency;
    const to = this.target(q.currency);
    if (to && pts.length > 0) {
      const fx = await this.series(`${q.currency}${to}=X`, rk).catch(() => ({ pts: [] }));
      if (fx.pts.length > 0) {
        pts = pts.map(([t, v]) => [t, v * rateAt(fx.pts, t)]);
        const r = this.rate(q.currency);
        base = rk === '1D' ? scale(q.prevClose, r ? r.prev : rateAt(fx.pts, pts[0][0])) : pts[0][1];
        currency = to;
      }
    }
    let start = pts.length > 0 ? pts[0][0] : 0;
    let end = pts.length > 0 ? pts[pts.length - 1][0] : 0;
    if (rk === '1D' && q.kind !== 'Crypto' && q.session && pts.length > 0 && pts[0][0] >= q.session.start - 3600) {
      start = q.session.start;
      end = Math.max(end, q.session.end);
    }
    return { symbol: sym, range: rk, pts, base, start, end, currency, tz: q.kind === 'Crypto' ? null : q.tz };
  }

  async search(text) {
    const q = String(text || '').trim();
    if (!q) {
      return [];
    }
    const url = `${YF}/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0&listsCount=0`;
    const body = await fetchJson(url);
    return ((body && body.quotes) || [])
      .filter((r) => r.symbol && KINDS[r.quoteType] && SYMBOL_RE.test(r.symbol))
      .map((r) => ({
        symbol: r.symbol,
        name: r.longname || r.shortname || r.symbol,
        kind: KINDS[r.quoteType],
        exchange: r.quoteType === 'CRYPTOCURRENCY' ? 'Crypto' : (r.exchDisp || r.exchange || ''),
        listed: this.state.list.includes(r.symbol),
      }));
  }

  async add(sym) {
    const s = String(sym || '').trim().toUpperCase();
    if (!SYMBOL_RE.test(s)) {
      throw new Error('Not a symbol');
    }
    if (!this.state.list.includes(s)) {
      if (this.state.list.length >= LIST_MAX) {
        throw new Error(`At most ${LIST_MAX} symbols`);
      }
      await this.series(s, '1D', true);
      this.state.list.push(s);
      await this.loadRates().catch(() => {});
      this.save();
      this.emit('data');
    }
    return s;
  }

  remove(sym) {
    this.state.list = this.state.list.filter((s) => s !== sym);
    delete this.state.quotes[sym];
    this.save();
    this.emit('data');
  }

  move(sym, index) {
    const list = this.state.list.filter((s) => s !== sym);
    if (list.length === this.state.list.length) {
      return;
    }
    list.splice(Math.max(0, Math.min(list.length, Number(index) || 0)), 0, sym);
    this.state.list = list;
    this.save();
    this.emit('data');
  }

  async setCurrency(cur) {
    if (!CURRENCIES.includes(cur) || cur === this.state.currency) {
      return;
    }
    this.state.currency = cur;
    this.save();
    await this.loadRates().catch((err) => console.error(`${this.svc.id}: rates: ${err.message}`));
    this.emit('data');
  }
}

function registerMarketsIpc(ipcMain, boardFor) {
  ipcMain.handle('mkt:data', guard(boardFor, (b) => b.data()));
  ipcMain.handle('mkt:chart', guard(boardFor, (b, sym, rk) => b.chart(String(sym), String(rk))));
  ipcMain.handle('mkt:search', guard(boardFor, (b, text) => b.search(String(text).slice(0, 100))));
  ipcMain.handle('mkt:add', guard(boardFor, (b, sym) => b.add(String(sym))));
  ipcMain.handle('mkt:remove', guard(boardFor, (b, sym) => b.remove(String(sym))));
  ipcMain.handle('mkt:move', guard(boardFor, (b, sym, index) => b.move(String(sym), Number(index))));
  ipcMain.handle('mkt:currency', guard(boardFor, (b, cur) => b.setCurrency(String(cur))));
  ipcMain.handle('mkt:refresh', guard(boardFor, (b) => {
    b.refresh();
    return b.status();
  }));
  ipcMain.on('mkt:active', guardOn(boardFor, (b, on) => b.setActive(on)));
}

module.exports = { MarketBoard, registerMarketsIpc, thin, rateAt, marketState, major, SYMBOL_RE, LIST_MAX };
