'use strict';

const $ = (id) => document.getElementById(id);

const RANGES = ['1D', '1W', '1M', '1Y', '5Y'];
const RANGE_LABEL = { '1D': 'today', '1W': 'past week', '1M': 'past month', '1Y': 'past year', '5Y': 'past 5 years' };
const CUR_LABEL = { native: 'Native', BRL: 'BRL', USD: 'USD', EUR: 'EUR' };
const STATE_LABEL = { open: 'Open', pre: 'Pre-market', post: 'After hours', closed: 'Closed', always: '24/7' };
const NAV_MIN = 220;
const NAV_MAX = 480;
const NAV_DEF = 300;
const SVG_NS = 'http://www.w3.org/2000/svg';

let data = { list: [], currency: 'native', currencies: ['native'], status: { state: 'idle' } };
let sel = store('mkt.sel', null);
let range = RANGES.includes(store('mkt.range', '1M')) ? store('mkt.range', '1M') : '1M';
let chart = null;
let chartRaw = null;
let chartSeq = 0;
let geo = null;
let measure = null;
let results = [];
let resIdx = 0;
let searchSeq = 0;
let dragSym = null;
let menuSym = null;

function store(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v === null || v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* per-viewer convenience only */
  }
}

function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    t.hidden = true;
  }, 3000);
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) {
    e.className = cls;
  }
  if (text !== undefined) {
    e.textContent = text;
  }
  return e;
}

/* ---- formatting ---- */

function digits(v, q) {
  const a = Math.abs(v);
  if (q && q.kind === 'Currency') {
    return 4;
  }
  return a >= 1 ? 2 : a >= 0.01 ? 4 : 6;
}

function plain(v, d) {
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
}

function money(v, q, cur) {
  if (v === null || v === undefined || !Number.isFinite(v)) {
    return '-';
  }
  const d = digits(v, q);
  const c = cur || (q && q.currency);
  if (!c || (q && q.kind === 'Index')) {
    return plain(v, d);
  }
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency: c, currencyDisplay: 'narrowSymbol', minimumFractionDigits: d, maximumFractionDigits: d,
    }).format(v);
  } catch {
    return `${plain(v, d)} ${c}`;
  }
}

function signedMoney(v, q, cur) {
  return `${v >= 0 ? '+' : '-'}${money(Math.abs(v), q, cur)}`;
}

function pct(v) {
  return Number.isFinite(v) ? `${v >= 0 ? '+' : '-'}${Math.abs(v).toFixed(2)}%` : '';
}

function compact(v) {
  return v ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(v) : '-';
}

function short(sym) {
  return sym.replace(/-USD$/, '').replace(/\.SA$/, '').replace(/=X$/, '').replace(/^\^/, '');
}

function fmtTime(t, opts, tz) {
  const d = new Date(t * 1000);
  try {
    return d.toLocaleString('en-GB', { ...opts, timeZone: tz || undefined });
  } catch {
    return d.toLocaleString('en-GB', opts);
  }
}

function hm(ms) {
  return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function tone(up) {
  return getComputedStyle(document.documentElement).getPropertyValue(up ? '--up' : '--down').trim();
}

function quote(sym) {
  return data.list.find((q) => q.symbol === sym) || null;
}

function dayChange(q) {
  if (!q || !q.price || !q.prevClose) {
    return null;
  }
  return { abs: q.price - q.prevClose, pct: ((q.price - q.prevClose) / q.prevClose) * 100 };
}

/* ---- charts ---- */

function niceTicks(lo, hi, n) {
  const span = hi - lo || Math.abs(hi) || 1;
  const raw = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= raw);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) {
    out.push(v);
  }
  return { ticks: out, step };
}

function sparkSvg(q) {
  const w = 72;
  const h = 28;
  const pts = q.spark || [];
  if (pts.length < 2) {
    return `<svg class="mk-spark" width="${w}" height="${h}"></svg>`;
  }
  const session = q.kind !== 'Crypto' && q.session && pts[0][0] >= q.session.start - 3600;
  const t0 = session ? q.session.start : pts[0][0];
  const t1 = session ? Math.max(q.session.end, pts[pts.length - 1][0]) : pts[pts.length - 1][0];
  const vals = pts.map((p) => p[1]);
  if (q.prevClose) {
    vals.push(q.prevClose);
  }
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const x = (t) => ((t - t0) / (t1 - t0 || 1)) * w;
  const y = (v) => 2 + (1 - (v - lo) / (hi - lo || 1)) * (h - 4);
  const ch = dayChange(q);
  const color = tone(!(ch && ch.abs < 0));
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
  const xl = x(pts[pts.length - 1][0]).toFixed(1);
  const id = `s${q.symbol.replace(/[^A-Za-z0-9]/g, '_')}`;
  let s = `<svg class="mk-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
    + `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity="0.22"/>`
    + `<stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>`;
  if (q.prevClose) {
    const yb = y(q.prevClose).toFixed(1);
    s += `<line class="mk-sbase" x1="0" x2="${w}" y1="${yb}" y2="${yb}"/>`;
  }
  s += `<path d="${line}L${xl},${h}L${x(pts[0][0]).toFixed(1)},${h}Z" fill="url(#${id})"/>`;
  s += `<path d="${line}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
  return s;
}

/* Time scale for 1D (the session fills the width as the day goes on),
 * one slot per point for longer ranges so nights and weekends take no
 * room.
 */
function geometry(c, w, h, q) {
  const pts = c.pts;
  const n = pts.length;
  const timeScale = c.range === '1D';
  const vals = pts.map((p) => p[1]);
  if (c.range === '1D' && c.base) {
    vals.push(c.base);
  }
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.01 || 1;
  lo -= pad;
  hi += pad;
  const { ticks, step } = niceTicks(lo, hi, Math.max(3, Math.round(h / 80)));
  const yDigits = Math.min(6, Math.max(0, -Math.floor(Math.log10(step) + 1e-9)));
  const labels = ticks.map((v) => plain(v, yDigits));
  const last = pts[n - 1][1];
  const extra = [plain(last, digits(last, q)), c.base ? plain(c.base, digits(c.base, q)) : ''];
  const padR = Math.max(...labels.concat(extra).map((l) => l.length), 4) * 6.6 + 18;
  const padT = 12;
  const padB = 24;
  const W = Math.max(10, w - padR);
  const H = h - padB;
  const xi = (i) => (n > 1 ? (i / (n - 1)) * W : W / 2);
  const xt = (t) => ((t - c.start) / (c.end - c.start || 1)) * W;
  const x = (i) => (timeScale ? xt(pts[i][0]) : xi(i));
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT);
  const index = (px) => {
    if (!timeScale) {
      return Math.max(0, Math.min(n - 1, Math.round((px / W) * (n - 1))));
    }
    let best = 0;
    for (let i = 1; i < n; i++) {
      if (Math.abs(xt(pts[i][0]) - px) < Math.abs(xt(pts[best][0]) - px)) {
        best = i;
      }
    }
    return best;
  };
  return { pts, n, W, H, w, h, padR, padT, x, xt, y, index, ticks, labels, timeScale };
}

function xTicks(c, g) {
  const tz = c.tz;
  const out = [];
  if (g.timeScale) {
    const span = c.end - c.start;
    const stepH = span > 12 * 3600 ? (span > 20 * 3600 ? 4 : 2) : 1;
    const step = stepH * 3600;
    for (let t = Math.ceil(c.start / step) * step; t < c.end; t += step) {
      out.push({ x: g.xt(t), label: fmtTime(t, { hour: '2-digit', minute: '2-digit' }, tz) });
    }
  } else {
    const key = {
      '1W': (t) => fmtTime(t, { day: '2-digit' }, tz),
      '1M': (t) => fmtTime(t, { day: '2-digit', month: 'short' }, tz),
      '1Y': (t) => fmtTime(t, { month: 'short' }, tz),
      '5Y': (t) => fmtTime(t, { year: 'numeric' }, tz),
    }[c.range];
    const label = {
      '1W': (t) => fmtTime(t, { weekday: 'short', day: '2-digit' }, tz),
      '1M': (t) => fmtTime(t, { day: '2-digit', month: 'short' }, tz),
      '1Y': (t) => fmtTime(t, { month: 'short' }, tz),
      '5Y': (t) => fmtTime(t, { year: 'numeric' }, tz),
    }[c.range];
    let prev = key(g.pts[0][0]);
    for (let i = 1; i < g.n; i++) {
      const k = key(g.pts[i][0]);
      if (k !== prev) {
        out.push({ x: g.x(i), label: label(g.pts[i][0]) });
        prev = k;
      }
    }
  }
  const max = Math.max(2, Math.floor(g.W / 90));
  const every = Math.ceil(out.length / max);
  return out.filter((tk, i) => i % every === 0 && tk.x > 24 && tk.x < g.W - 24);
}

function tipTime(t, c) {
  const tz = c.tz;
  if (c.range === '1D') {
    return fmtTime(t, { weekday: 'short', hour: '2-digit', minute: '2-digit' }, tz);
  }
  if (c.range === '1W' || c.range === '1M') {
    return fmtTime(t, { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }, tz);
  }
  return fmtTime(t, { day: '2-digit', month: 'short', year: 'numeric' }, tz);
}

function drawChart() {
  const box = $('chart');
  const q = quote(sel);
  if (!chart || chart.symbol !== sel || chart.range !== range || chart.pts.length < 2) {
    geo = null;
    if (chart && chart.symbol === sel && chart.range === range) {
      box.innerHTML = '<div class="mk-msg">No data for this range</div>';
    }
    return;
  }
  const w = box.clientWidth;
  const h = box.clientHeight;
  if (w < 50 || h < 50) {
    return;
  }
  const c = chart;
  const g = geometry(c, w, h, q);
  const last = c.pts[c.pts.length - 1][1];
  const ref = c.base || c.pts[0][1];
  const color = tone(last >= ref);
  g.color = color;
  g.ref = ref;
  let s = `<svg class="mk-chart" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="${SVG_NS}">`
    + `<defs><linearGradient id="mkfill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity="0.28"/>`
    + `<stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>`;
  g.ticks.forEach((v, i) => {
    const yy = g.y(v).toFixed(1);
    s += `<line class="mk-grid" x1="0" x2="${g.W}" y1="${yy}" y2="${yy}"/>`;
    s += `<text x="${g.W + 10}" y="${+yy + 4}">${g.labels[i]}</text>`;
  });
  for (const tk of xTicks(c, g)) {
    s += `<text x="${tk.x.toFixed(1)}" y="${h - 6}" text-anchor="middle">${tk.label}</text>`;
  }
  const line = c.pts.map((p, i) => `${i ? 'L' : 'M'}${g.x(i).toFixed(1)},${g.y(p[1]).toFixed(1)}`).join('');
  const xl = g.x(g.n - 1);
  s += `<path d="${line}L${xl.toFixed(1)},${g.H}L${g.x(0).toFixed(1)},${g.H}Z" fill="url(#mkfill)"/>`;
  s += `<path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  if (c.range === '1D' && c.base) {
    const yb = g.y(c.base).toFixed(1);
    s += `<line class="mk-base" x1="0" x2="${g.W}" y1="${yb}" y2="${yb}"/>`;
    s += `<text class="mk-base-l" x="${g.W + 10}" y="${+yb + 4}">${plain(c.base, digits(c.base, q))}</text>`;
  }
  const yl = g.y(last);
  const live = c.range === '1D' && q && (q.state === 'open' || q.state === 'always');
  if (live) {
    s += `<circle class="mk-pulse" cx="${xl}" cy="${yl}" r="4" fill="${color}"/>`;
  }
  s += `<circle cx="${xl}" cy="${yl}" r="4" fill="${color}"/>`;
  s += '<g id="ov"></g></svg>';
  box.innerHTML = s;
  geo = g;
  if (measure) {
    drawMeasure();
  }
}

function tip(x, w, lines, g) {
  const tx = Math.min(Math.max(x - w / 2, 2), g.W - w - 2);
  let s = `<g transform="translate(${tx.toFixed(1)},${g.padT + 2})"><rect class="mk-tipbox" width="${w}" height="46" rx="8"/>`;
  for (const l of lines) {
    s += `<text x="${l.end ? w - 12 : (l.mid ? w / 2 : 12)}" y="${l.y}" ${l.end ? 'text-anchor="end"' : ''}${l.mid ? 'text-anchor="middle"' : ''} class="${l.cls}">${l.text}</text>`;
  }
  return `${s}</g>`;
}

function drawHover(i) {
  const g = geo;
  const ov = document.getElementById('ov');
  if (!g || !ov) {
    return;
  }
  if (i === null) {
    ov.innerHTML = '';
    return;
  }
  const q = quote(sel);
  const p = g.pts[i];
  const hx = g.x(i);
  const hy = g.y(p[1]);
  const d = ((p[1] - g.ref) / g.ref) * 100;
  let s = `<line class="mk-cross" x1="${hx}" x2="${hx}" y1="${g.padT}" y2="${g.H}"/>`
    + `<line class="mk-cross" x1="0" x2="${g.W}" y1="${hy}" y2="${hy}"/>`
    + `<rect x="${g.W + 2}" y="${hy - 10}" width="${g.padR - 4}" height="20" rx="4" fill="${g.color}"/>`
    + `<text class="mk-tag" x="${g.W + 10}" y="${hy + 4}">${plain(p[1], digits(p[1], q))}</text>`
    + `<circle cx="${hx}" cy="${hy}" r="5" class="mk-hdot" fill="${g.color}"/>`;
  s += tip(hx, 196, [
    { y: 20, cls: 'mk-tip-v', text: money(p[1], q, chart.currency) },
    { y: 20, cls: `mk-tip-c ${d >= 0 ? 'mk-up' : 'mk-down'}`, text: pct(d), end: true },
    { y: 37, cls: '', text: tipTime(p[0], chart) },
  ], g);
  ov.innerHTML = s;
}

function drawMeasure() {
  const g = geo;
  const ov = document.getElementById('ov');
  if (!g || !ov || !measure) {
    return;
  }
  const q = quote(sel);
  const [i0, i1] = measure.a <= measure.b ? [measure.a, measure.b] : [measure.b, measure.a];
  const a = g.pts[i0];
  const b = g.pts[i1];
  const xa = g.x(i0);
  const xb = g.x(i1);
  const d = b[1] - a[1];
  const c = tone(d >= 0);
  let s = `<rect x="${xa}" y="${g.padT}" width="${Math.max(1, xb - xa)}" height="${g.H - g.padT}" fill="${c}" opacity="0.08"/>`
    + `<line class="mk-cross" x1="${xa}" x2="${xa}" y1="${g.padT}" y2="${g.H}"/>`
    + `<line class="mk-cross" x1="${xb}" x2="${xb}" y1="${g.padT}" y2="${g.H}"/>`
    + `<circle cx="${xa}" cy="${g.y(a[1])}" r="4" class="mk-mdot" stroke="${c}"/>`
    + `<circle cx="${xb}" cy="${g.y(b[1])}" r="4" class="mk-mdot" stroke="${c}"/>`;
  s += tip((xa + xb) / 2, 280, [
    { y: 20, cls: `mk-tip-v ${d >= 0 ? 'mk-up' : 'mk-down'}`, mid: true, text: `${signedMoney(d, q, chart.currency)}  ${pct((d / a[1]) * 100)}` },
    { y: 37, cls: '', mid: true, text: `${tipTime(a[0], chart)}  to  ${tipTime(b[0], chart)}` },
  ], g);
  ov.innerHTML = s;
}

function chartIndex(ev) {
  if (!geo) {
    return null;
  }
  const r = $('chart').getBoundingClientRect();
  const px = ev.clientX - r.left;
  if (px < 0 || px > geo.W + 4) {
    return null;
  }
  return geo.index(px);
}

$('chart').addEventListener('pointerdown', (ev) => {
  const i = chartIndex(ev);
  if (ev.button !== 0 || i === null) {
    return;
  }
  $('chart').setPointerCapture(ev.pointerId);
  measure = { a: i, b: i, active: true };
  drawMeasure();
});

$('chart').addEventListener('pointermove', (ev) => {
  const i = chartIndex(ev);
  if (measure && measure.active) {
    if (i !== null) {
      measure.b = i;
      drawMeasure();
    }
    return;
  }
  if (measure) {
    return;
  }
  drawHover(i);
});

$('chart').addEventListener('pointerup', () => {
  if (!measure) {
    return;
  }
  if (measure.a === measure.b) {
    measure = null;
    drawHover(null);
    return;
  }
  measure.active = false;
});

$('chart').addEventListener('pointerleave', () => {
  if (measure && !measure.active) {
    measure = null;
  }
  if (!measure) {
    drawHover(null);
  }
});

new ResizeObserver(() => drawChart()).observe($('chart'));

/* ---- data ---- */

function withLive(c) {
  const q = quote(c.symbol);
  if (!q || !q.price || !q.time || c.range === '1D' || c.pts.length === 0 || q.currency !== c.currency) {
    return c;
  }
  const pts = c.pts.slice();
  if (q.time > pts[pts.length - 1][0]) {
    pts.push([q.time, q.price]);
  } else {
    pts[pts.length - 1] = [pts[pts.length - 1][0], q.price];
  }
  return { ...c, pts };
}

async function loadChart() {
  const sym = sel;
  const rk = range;
  if (!sym) {
    return;
  }
  const seq = ++chartSeq;
  $('chart').classList.add('loading');
  try {
    const c = await window.markets.chart(sym, rk);
    if (seq !== chartSeq) {
      return;
    }
    chartRaw = c;
    chart = withLive(c);
    if (!measure) {
      drawChart();
    }
    renderHead();
  } catch (err) {
    if (seq === chartSeq) {
      chart = null;
      $('chart').innerHTML = `<div class="mk-msg">${String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '').replace(/[<>&]/g, '')}</div>`;
    }
  } finally {
    if (seq === chartSeq) {
      $('chart').classList.remove('loading');
    }
  }
}

function renderStatus() {
  const st = data.status || {};
  const s = $('status');
  s.textContent = '';
  s.className = st.state === 'error' ? 'error' : '';
  s.append(el('span', 'mk-live'));
  if (st.state === 'loading') {
    s.append('Updating...');
  } else if (st.error) {
    s.append(st.error);
  } else if (st.fetchedAt) {
    s.append(`Updated ${hm(st.fetchedAt)}`);
  }
  $('refresh').classList.toggle('spin', st.state === 'loading');
}

function renderCurrency() {
  const box = $('currency');
  box.textContent = '';
  for (const c of data.currencies) {
    const b = el('button', c === data.currency ? 'on' : '', CUR_LABEL[c] || c);
    b.addEventListener('click', async () => {
      if (c === data.currency) {
        return;
      }
      await window.markets.currency(c);
      await reload();
      loadChart();
    });
    box.append(b);
  }
}

function renderWatch() {
  const box = $('watch');
  box.textContent = '';
  for (const q of data.list) {
    const row = el('div', `mk-row${q.symbol === sel ? ' sel' : ''}${q.pending ? ' pending' : ''}${q.symbol === menuSym ? ' menu' : ''}`);
    row.draggable = true;
    row.dataset.sym = q.symbol;
    const left = el('div', 'mk-who');
    left.append(el('div', 'mk-sym', short(q.symbol)), el('div', 'mk-nm', q.name || q.symbol));
    const spark = el('div');
    spark.innerHTML = q.pending ? '' : sparkSvg(q);
    const right = el('div', 'mk-px');
    const ch = dayChange(q);
    right.append(q.pending ? '...' : money(q.price, q), el('br'));
    if (ch) {
      right.append(el('span', `mk-pill ${ch.abs >= 0 ? 'mk-up' : 'mk-down'}`, pct(ch.pct)));
    }
    row.append(left, spark, right);
    row.addEventListener('click', () => select(q.symbol));
    row.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      openMenu(q.symbol, row, ev.clientX, ev.clientY);
    });
    row.addEventListener('dragstart', (ev) => {
      dragSym = q.symbol;
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', q.symbol);
      row.classList.add('drag');
    });
    row.addEventListener('dragend', () => {
      dragSym = null;
      row.classList.remove('drag');
      clearDrop();
    });
    row.addEventListener('dragover', (ev) => {
      if (!dragSym || dragSym === q.symbol) {
        return;
      }
      ev.preventDefault();
      const r = row.getBoundingClientRect();
      const after = ev.clientY > r.top + r.height / 2;
      clearDrop();
      row.classList.add(after ? 'drop-after' : 'drop-before');
    });
    row.addEventListener('drop', (ev) => {
      ev.preventDefault();
      if (!dragSym || dragSym === q.symbol) {
        return;
      }
      const r = row.getBoundingClientRect();
      const after = ev.clientY > r.top + r.height / 2;
      const rest = data.list.map((x2) => x2.symbol).filter((s) => s !== dragSym);
      const at = rest.indexOf(q.symbol) + (after ? 1 : 0);
      window.markets.move(dragSym, at);
      clearDrop();
    });
    box.append(row);
  }
}

function closeMenu() {
  const m = $('ctx');
  if (m.hidden) {
    return;
  }
  m.hidden = true;
  menuSym = null;
  for (const r of document.querySelectorAll('.mk-row.menu')) {
    r.classList.remove('menu');
  }
}

function openMenu(sym, row, x, y) {
  closeMenu();
  const m = $('ctx');
  m.textContent = '';
  const items = [
    ['Remove from watchlist', 'Del', () => remove(sym)],
    ['Move to top', '', () => window.markets.move(sym, 0)],
    null,
    ['Open on Yahoo Finance', '', () => window.markets.open(sym)],
  ];
  for (const it of items) {
    if (!it) {
      m.append(el('hr'));
      continue;
    }
    const b = el('button', '', it[0]);
    b.setAttribute('role', 'menuitem');
    if (it[1]) {
      b.append(el('span', '', it[1]));
    }
    b.addEventListener('click', () => {
      closeMenu();
      it[2]();
    });
    m.append(b);
  }
  menuSym = sym;
  row.classList.add('menu');
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
  m.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
  m.querySelector('button').focus();
}

document.addEventListener('pointerdown', (ev) => {
  if (!$('ctx').contains(ev.target)) {
    closeMenu();
  }
});
window.addEventListener('blur', closeMenu);
$('watch').addEventListener('scroll', closeMenu);

function clearDrop() {
  for (const r of document.querySelectorAll('.drop-before, .drop-after')) {
    r.classList.remove('drop-before', 'drop-after');
  }
}

function renderRanges() {
  const box = $('ranges');
  box.textContent = '';
  RANGES.forEach((r, i) => {
    const b = el('button', r === range ? 'on' : '', r);
    b.title = `${RANGE_LABEL[r]} (${i + 1})`;
    b.addEventListener('click', () => setRange(r));
    box.append(b);
  });
}

function stateText(q) {
  if (q.state === 'open' && q.session) {
    const m = Math.max(0, Math.round((q.session.end * 1000 - Date.now()) / 60000));
    return `Open, closes in ${m >= 60 ? `${Math.floor(m / 60)} h ` : ''}${m % 60} min`;
  }
  return STATE_LABEL[q.state] || '';
}

function rangeLabel(q) {
  return range === '1D' && q.kind === 'Crypto' ? 'past 24 hours' : RANGE_LABEL[range];
}

function renderHead() {
  const q = quote(sel);
  if (!q) {
    return;
  }
  $('d-name').textContent = q.name || q.symbol;
  $('d-sym').textContent = q.symbol;
  const meta = $('d-meta');
  meta.textContent = '';
  if (q.kind) {
    meta.append(el('span', `mk-chip k-${q.kind}`, q.kind));
  }
  if (q.state) {
    meta.append(el('span', `mk-chip s-${q.state}`, stateText(q)));
  }
  if (q.exchange && q.kind !== 'Crypto') {
    meta.append(el('span', '', q.exchange));
  }
  if (q.kind !== 'Index' && q.native) {
    meta.append(el('span', '', q.native === q.currency ? q.native : `${q.native} in ${q.currency}`));
  }
  const price = $('d-price');
  price.textContent = q.pending ? '...' : money(q.price, q);
  if (q.native && q.native !== q.currency && q.nativePrice) {
    price.append(el('span', 'mk-orig', money(q.nativePrice, q, q.native)));
  }
  const chg = $('d-chg');
  chg.textContent = '';
  let ch = null;
  if (range === '1D') {
    ch = dayChange(q);
  } else if (chart && chart.symbol === sel && chart.range === range && chart.base && q.price) {
    ch = { abs: q.price - chart.base, pct: ((q.price - chart.base) / chart.base) * 100 };
  }
  if (ch) {
    chg.className = `mk-dchg ${ch.abs >= 0 ? 'mk-up' : 'mk-down'}`;
    chg.append(`${signedMoney(ch.abs, q)} (${pct(ch.pct)}) `, el('span', 'mk-dim', rangeLabel(q)));
  }
  renderStats(q);
}

function renderStats(q) {
  const box = $('stats');
  box.textContent = '';
  const ch = dayChange(q);
  const items = q.kind === 'Crypto' ? [
    ['24h high', money(q.high, q)],
    ['24h low', money(q.low, q)],
    ['24h ago', money(q.prevClose, q)],
    ['24h change', ch ? pct(ch.pct) : '-'],
    ['Volume', compact(q.volume)],
  ] : [
    ['Open', money(q.open, q)],
    ['Day high', money(q.high, q)],
    ['Day low', money(q.low, q)],
    ['Prev close', money(q.prevClose, q)],
    ['Volume', compact(q.volume)],
  ];
  for (const [k, v] of items) {
    const s = el('div', 'mk-stat');
    s.append(el('div', 'mk-k', k), el('div', 'mk-v', v));
    box.append(s);
  }
  const s = el('div', 'mk-stat');
  s.append(el('div', 'mk-k', '52-week range'));
  if (q.low52 && q.high52 && q.price) {
    const track = el('div', 'mk-rtrack');
    const dot = el('div', 'mk-rdot');
    const f = Math.max(0, Math.min(1, (q.price - q.low52) / (q.high52 - q.low52 || 1)));
    dot.style.left = `${(f * 100).toFixed(1)}%`;
    track.append(dot);
    const rl = el('div', 'mk-rl');
    rl.append(el('span', '', money(q.low52, q)), el('span', '', money(q.high52, q)));
    s.append(track, rl);
  } else {
    s.append(el('div', 'mk-v', '-'));
  }
  box.append(s);
}

function render() {
  if (!data.list.some((q) => q.symbol === sel)) {
    sel = data.list.length > 0 ? data.list[0].symbol : null;
  }
  renderStatus();
  renderCurrency();
  renderWatch();
  $('detail').hidden = !sel;
  $('empty').hidden = Boolean(sel);
  if (sel) {
    renderRanges();
    renderHead();
  }
}

async function reload() {
  data = await window.markets.data();
  render();
}

function select(sym) {
  if (sym === sel) {
    return;
  }
  sel = sym;
  save('mkt.sel', sym);
  measure = null;
  chart = null;
  $('chart').innerHTML = '';
  render();
  loadChart();
  const row = document.querySelector(`.mk-row[data-sym="${CSS.escape(sym)}"]`);
  if (row) {
    row.scrollIntoView({ block: 'nearest' });
  }
}

function setRange(r) {
  if (r === range) {
    return;
  }
  range = r;
  save('mkt.range', r);
  measure = null;
  renderRanges();
  renderHead();
  loadChart();
}

async function remove(sym) {
  if (sym === sel) {
    const i = data.list.findIndex((q) => q.symbol === sym);
    const rest = data.list.filter((q) => q.symbol !== sym);
    const next = rest[Math.min(i, rest.length - 1)];
    sel = next ? next.symbol : null;
    save('mkt.sel', sel);
    chart = null;
    chartRaw = null;
    measure = null;
    $('chart').innerHTML = '';
  }
  await window.markets.remove(sym);
  toast(`Removed ${sym}`);
}

/* ---- search ---- */

function closeResults() {
  results = [];
  $('results').hidden = true;
}

function renderResults() {
  const box = $('results');
  box.textContent = '';
  if (results.length === 0) {
    box.hidden = true;
    return;
  }
  results.forEach((r, i) => {
    const row = el('div', `mk-res${i === resIdx ? ' on' : ''}${r.listed ? ' listed' : ''}`);
    row.append(el('b', '', r.symbol), el('span', 'mk-nm', r.name), el('span', `mk-chip k-${r.kind}`, r.kind), el('span', 'mk-ex', r.listed ? 'In list' : r.exchange));
    row.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      add(r);
    });
    row.addEventListener('mousemove', () => {
      if (resIdx !== i) {
        resIdx = i;
        renderResults();
      }
    });
    box.append(row);
  });
  box.append(el('div', 'mk-res-foot', 'Enter adds, Esc closes. Results from Yahoo Finance.'));
  box.hidden = false;
}

async function add(r) {
  closeResults();
  $('add-q').value = '';
  $('add-q').blur();
  if (r.listed) {
    select(r.symbol);
    return;
  }
  try {
    const sym = await window.markets.add(r.symbol);
    await reload();
    select(sym);
  } catch {
    toast(`Could not add ${r.symbol}`);
  }
}

$('add-q').addEventListener('input', () => {
  clearTimeout(renderResults.timer);
  const text = $('add-q').value.trim();
  if (!text) {
    closeResults();
    return;
  }
  renderResults.timer = setTimeout(async () => {
    const seq = ++searchSeq;
    try {
      const res = await window.markets.search(text);
      if (seq === searchSeq && $('add-q').value.trim() === text) {
        results = res;
        resIdx = 0;
        renderResults();
      }
    } catch {
      if (seq === searchSeq) {
        toast('Search failed');
      }
    }
  }, 250);
});

$('add-q').addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    closeResults();
    $('add-q').value = '';
    $('add-q').blur();
  } else if (ev.key === 'ArrowDown' && results.length) {
    ev.preventDefault();
    resIdx = (resIdx + 1) % results.length;
    renderResults();
  } else if (ev.key === 'ArrowUp' && results.length) {
    ev.preventDefault();
    resIdx = (resIdx - 1 + results.length) % results.length;
    renderResults();
  } else if (ev.key === 'Enter') {
    ev.preventDefault();
    if (results[resIdx]) {
      add(results[resIdx]);
    } else if ($('add-q').value.trim()) {
      add({ symbol: $('add-q').value.trim().toUpperCase() });
    }
  }
});

$('add-q').addEventListener('blur', () => setTimeout(closeResults, 100));

/* ---- keyboard, refresh, splitter ---- */

document.addEventListener('keydown', (ev) => {
  if (!$('ctx').hidden) {
    const items = [...$('ctx').querySelectorAll('button')];
    const i = items.indexOf(document.activeElement);
    if (ev.key === 'Escape') {
      ev.preventDefault();
      closeMenu();
    } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      items[(i + (ev.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
    }
    return;
  }
  if ((ev.target instanceof Element && ev.target.closest('input')) || ev.ctrlKey || ev.altKey || ev.metaKey) {
    return;
  }
  const i = data.list.findIndex((q) => q.symbol === sel);
  if (/^[1-5]$/.test(ev.key)) {
    setRange(RANGES[Number(ev.key) - 1]);
  } else if (ev.key === 'ArrowDown' && i < data.list.length - 1) {
    ev.preventDefault();
    select(data.list[i + 1].symbol);
  } else if (ev.key === 'ArrowUp' && i > 0) {
    ev.preventDefault();
    select(data.list[i - 1].symbol);
  } else if (ev.key === '/') {
    ev.preventDefault();
    $('add-q').focus();
  } else if (ev.key === 'Delete' && sel) {
    remove(sel);
  } else if (ev.key === 'r' || ev.key === 'R') {
    window.markets.refresh();
  } else if (ev.key === 'Escape' && measure) {
    measure = null;
    drawHover(null);
  }
});

$('refresh').addEventListener('click', async () => {
  data.status = await window.markets.refresh();
  renderStatus();
});

function applyNavWidth() {
  const w = Math.min(NAV_MAX, Math.max(NAV_MIN, Number(store('mkt.navWidth', NAV_DEF)) || NAV_DEF));
  $('app').style.setProperty('--nav-w', `${w}px`);
}

$('splitter').addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) {
    return;
  }
  ev.preventDefault();
  const splitter = $('splitter');
  const startX = ev.clientX;
  const startW = $('nav').getBoundingClientRect().width;
  splitter.setPointerCapture(ev.pointerId);
  splitter.classList.add('dragging');
  document.body.classList.add('resizing');
  const move = (e) => {
    const w = Math.min(NAV_MAX, Math.max(NAV_MIN, Math.round(startW + e.clientX - startX)));
    $('app').style.setProperty('--nav-w', `${w}px`);
  };
  const up = () => {
    splitter.removeEventListener('pointermove', move);
    splitter.removeEventListener('pointerup', up);
    splitter.removeEventListener('pointercancel', up);
    splitter.classList.remove('dragging');
    document.body.classList.remove('resizing');
    save('mkt.navWidth', Math.round($('nav').getBoundingClientRect().width));
  };
  splitter.addEventListener('pointermove', move);
  splitter.addEventListener('pointerup', up);
  splitter.addEventListener('pointercancel', up);
});

$('splitter').addEventListener('dblclick', () => {
  save('mkt.navWidth', NAV_DEF);
  applyNavWidth();
});

/* ---- start ---- */

window.markets.onEvent(async (ev) => {
  if (ev.type === 'status') {
    data.status = ev.status;
    renderStatus();
    return;
  }
  const before = chart;
  await reload();
  if (sel && (range === '1D' || !before || before.symbol !== sel)) {
    loadChart();
  } else if (chart && chartRaw) {
    chart = withLive(chartRaw);
    if (!measure) {
      drawChart();
    }
    renderHead();
  }
});

window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  requestAnimationFrame(() => {
    renderWatch();
    drawChart();
  });
});

const active = () => window.markets.active(document.visibilityState === 'visible');
document.addEventListener('visibilitychange', active);
setInterval(() => {
  const q = quote(sel);
  if (q && q.state === 'open') {
    renderHead();
  }
}, 60 * 1000);

applyNavWidth();
active();
reload().then(() => loadChart());
