'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'appbox-markets-'));
const home = path.join(root, 'home');
fs.mkdirSync(home);
process.env.HOME = home;
for (const name of ['CONFIG', 'DATA', 'STATE', 'CACHE']) {
  process.env[`XDG_${name}_HOME`] = path.join(root, name.toLowerCase());
}
delete process.env.APPBOX_CONFIG;
const config = require('../src/main/config.js');
const catalog = require('../src/main/catalog.js');
const { MarketBoard, thin, rateAt, marketState, major, quoteUrl, SYMBOL_RE, LIST_MAX } = require('../src/markets/board.js');

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const ctx = { onBadge() {}, notify() {} };
const board = (extra) => {
  const b = new MarketBoard({ id: 'mk', ...extra }, ctx);
  b.state.list = [];
  return b;
};

test('thin keeps both ends and caps the length', () => {
  const pts = Array.from({ length: 1000 }, (_, i) => [i, i * 2]);
  const out = thin(pts, 100);
  assert.equal(out.length, 100);
  assert.deepEqual(out[0], [0, 0]);
  assert.deepEqual(out[out.length - 1], [999, 1998]);
  assert.equal(thin(pts.slice(0, 10), 100).length, 10);
});

test('rateAt takes the last rate known at that time', () => {
  const fx = [[100, 5], [200, 6], [300, 7]];
  assert.equal(rateAt(fx, 50), 5);
  assert.equal(rateAt(fx, 100), 5);
  assert.equal(rateAt(fx, 250), 6);
  assert.equal(rateAt(fx, 999), 7);
});

test('marketState follows the trading periods', () => {
  const q = {
    kind: 'Stock',
    pre: { start: 0, end: 100 },
    session: { start: 100, end: 200 },
    post: { start: 200, end: 300 },
  };
  assert.equal(marketState(q, 50), 'pre');
  assert.equal(marketState(q, 150), 'open');
  assert.equal(marketState(q, 250), 'post');
  assert.equal(marketState(q, 400), 'closed');
  assert.equal(marketState({ kind: 'Crypto' }, 400), 'always');
});

test('minor currency units become the major unit', () => {
  assert.deepEqual(major('GBp'), { currency: 'GBP', k: 0.01 });
  assert.deepEqual(major('USD'), { currency: 'USD', k: 1 });
  assert.deepEqual(major(undefined), { currency: 'USD', k: 1 });
});

test('the quote page address escapes the symbol', () => {
  assert.equal(quoteUrl('PETR4.SA'), 'https://finance.yahoo.com/quote/PETR4.SA/');
  assert.equal(quoteUrl('^BVSP'), 'https://finance.yahoo.com/quote/%5EBVSP/');
});

test('symbols are limited to ticker characters', () => {
  for (const s of ['AAPL', 'PETR4.SA', '^BVSP', 'USDBRL=X', 'BTC-USD']) {
    assert.ok(SYMBOL_RE.test(s), s);
  }
  for (const s of ['', 'A B', 'x/y', '<a>', 'A'.repeat(25)]) {
    assert.ok(!SYMBOL_RE.test(s), s);
  }
});

test('quotes are converted to the display currency', () => {
  const b = board();
  b.state.list = ['AAPL', 'PETR4.SA'];
  b.state.quotes = {
    AAPL: { symbol: 'AAPL', kind: 'Stock', currency: 'USD', price: 100, prevClose: 90, open: 95, high: 101, low: 94, low52: 50, high52: 120, spark: [[1, 99], [2, 100]] },
    'PETR4.SA': { symbol: 'PETR4.SA', kind: 'Stock', currency: 'BRL', price: 40, prevClose: 41, spark: [] },
    'USDBRL=X': { symbol: 'USDBRL=X', kind: 'Currency', currency: 'BRL', price: 5, prevClose: 4 },
  };
  assert.equal(b.data().list[0].price, 100);
  b.state.currency = 'BRL';
  assert.deepEqual(b.pairs(), ['USDBRL=X']);
  const [aapl, petr] = b.data().list;
  assert.equal(aapl.currency, 'BRL');
  assert.equal(aapl.native, 'USD');
  assert.equal(aapl.nativePrice, 100);
  assert.equal(aapl.price, 500);
  assert.equal(aapl.prevClose, 360);
  assert.deepEqual(aapl.spark, [[1, 495], [2, 500]]);
  assert.equal(petr.price, 40);
  assert.equal(petr.currency, 'BRL');
});

test('a quote without its exchange rate stays in its own currency', () => {
  const b = board();
  b.state.list = ['AAPL'];
  b.state.currency = 'EUR';
  b.state.quotes = { AAPL: { symbol: 'AAPL', kind: 'Stock', currency: 'USD', price: 100, prevClose: 90, spark: [] } };
  const [aapl] = b.data().list;
  assert.equal(aapl.currency, 'USD');
  assert.equal(aapl.price, 100);
});

test('a chart is converted point by point with the rate series', async () => {
  const b = board();
  b.state.currency = 'BRL';
  b.state.quotes = {
    AAPL: { symbol: 'AAPL', kind: 'Stock', currency: 'USD', price: 12, prevClose: 10, tz: 'America/New_York' },
    'USDBRL=X': { symbol: 'USDBRL=X', kind: 'Currency', currency: 'BRL', price: 6, prevClose: 5 },
  };
  const series = {
    AAPL: { meta: {}, pts: [[100, 10], [200, 11], [300, 12]] },
    'USDBRL=X': { meta: {}, pts: [[100, 5], [250, 6]] },
  };
  b.series = async (sym) => series[sym];
  const c = await b.chart('AAPL', '1Y');
  assert.equal(c.currency, 'BRL');
  assert.deepEqual(c.pts, [[100, 50], [200, 55], [300, 72]]);
  assert.equal(c.base, 50);
  assert.equal(c.tz, 'America/New_York');
});

test('the day chart of a stock spans the trading session', async () => {
  const b = board();
  b.state.quotes = {
    AAPL: { symbol: 'AAPL', kind: 'Stock', currency: 'USD', price: 11, prevClose: 10, session: { start: 1000, end: 24400 } },
    'BTC-USD': { symbol: 'BTC-USD', kind: 'Crypto', currency: 'USD', price: 2, prevClose: 1, session: { start: 0, end: 86400 } },
  };
  b.series = async (sym) => (sym === 'AAPL'
    ? { meta: {}, pts: [[1000, 10], [1300, 11]] }
    : { meta: {}, pts: [[500, 1], [900, 2]] });
  const day = await b.chart('AAPL', '1D');
  assert.equal(day.start, 1000);
  assert.equal(day.end, 24400);
  assert.equal(day.base, 10);
  const crypto = await b.chart('BTC-USD', '1D');
  assert.equal(crypto.start, 500);
  assert.equal(crypto.end, 900);
  assert.equal(crypto.tz, null);
});

test('bad requests are refused before any fetch', async () => {
  const b = board();
  b.series = async () => {
    throw new Error('no fetch expected');
  };
  await assert.rejects(b.chart('AAPL', '2D'), /bad request/);
  await assert.rejects(b.chart('a b', '1D'), /bad request/);
  await assert.rejects(b.add('x/y'), /Not a symbol/);
});

test('the watchlist order is kept and saved', () => {
  const b = board();
  b.state.list = ['A', 'B', 'C'];
  b.move('C', 0);
  assert.deepEqual(b.state.list, ['C', 'A', 'B']);
  b.move('Z', 0);
  assert.deepEqual(b.state.list, ['C', 'A', 'B']);
  b.remove('A');
  assert.deepEqual(b.state.list, ['C', 'B']);
  const saved = JSON.parse(fs.readFileSync(path.join(config.paths.state, 'markets', 'mk.json'), 'utf8'));
  assert.deepEqual(saved.list, ['C', 'B']);
});

test('the configuration keeps a markets app and the catalog offers one', () => {
  const svc = config.normalize({ services: [{ id: 'm', type: 'markets', url: 'https://finance.yahoo.com/', links: 'window' }] }).services[0];
  assert.equal(svc.type, 'markets');
  assert.equal(svc.links, 'external');
  const built = catalog.build('markets', {}, []);
  assert.equal(built.type, 'markets');
  assert.equal(built.icon, 'markets.svg');
});

test('a damaged state file falls back to clean defaults', () => {
  const file = path.join(config.paths.state, 'markets', 'bad.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ list: ['AAPL', 'AAPL', 'a b', 7], quotes: null, currency: 'XYZ' }));
  const b = new MarketBoard({ id: 'bad' }, ctx);
  b.schedule = () => {};
  b.init();
  assert.deepEqual(b.state.list, ['AAPL', '7']);
  assert.deepEqual(b.state.quotes, {});
  assert.equal(b.state.currency, 'native');
});

test('the first watchlist comes from the service entry', () => {
  const b = new MarketBoard({ id: 'seed', symbols: ['PETR4.SA', '<x>'] }, ctx);
  b.schedule = () => {};
  b.init();
  assert.deepEqual(b.state.list, ['PETR4.SA']);
});

test('forget removes the state file and nothing writes it again', () => {
  const b = board({ id: 'gone' });
  b.state.list = ['A', 'B'];
  b.save();
  assert.ok(fs.existsSync(b.stateFile));
  b.forget();
  assert.ok(!fs.existsSync(b.stateFile));
  b.move('B', 0);
  assert.ok(!fs.existsSync(b.stateFile));
});

test('a chart stays in its own currency when the rates cannot be fetched', async () => {
  const b = board();
  b.state.currency = 'BRL';
  b.state.quotes = { AAPL: { symbol: 'AAPL', kind: 'Stock', currency: 'USD', price: 12, prevClose: 10 } };
  b.series = async (sym) => {
    if (sym !== 'AAPL') {
      throw new Error('offline');
    }
    return { meta: {}, pts: [[100, 10], [200, 12]] };
  };
  const c = await b.chart('AAPL', '1M');
  assert.equal(c.currency, 'USD');
  assert.deepEqual(c.pts, [[100, 10], [200, 12]]);
});

test('the watchlist has a size limit', async () => {
  const b = board();
  b.state.list = Array.from({ length: LIST_MAX }, (_, i) => `S${i}`);
  b.series = async () => {
    throw new Error('no fetch expected');
  };
  await assert.rejects(b.add('AAPL'), /At most/);
});
