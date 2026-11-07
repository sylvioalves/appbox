'use strict';

const $ = (id) => document.getElementById(id);

const ICONS = {
  inbox: 'M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 12h-4a3 3 0 0 1-6 0H5V5h14v10z',
  starred: 'M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z',
  important: 'M4 4h12l5 8-5 8H4l5-8z',
  sent: 'M2.01 21L23 12 2.01 3 2 10l15 2-15 2z',
  drafts: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
  all: 'M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z',
  spam: 'M12 2L1 21h22L12 2zm1 16h-2v-2h2v2zm0-4h-2v-4h2v4z',
  trash: 'M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
  label: 'M17.63 5.84A2 2 0 0 0 16 5H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h11c.67 0 1.27-.33 1.63-.84L22 12l-4.37-6.16z',
  archive: 'M20.54 5.23l-1.39-1.68A1.45 1.45 0 0 0 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6.5c0-.48-.17-.93-.46-1.27zM12 17.5L6.5 12H10v-2h4v2h3.5L12 17.5zM5.12 5l.81-1h12l.94 1H5.12z',
  read: 'M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z',
  unread: 'M21.99 8c0-.72-.37-1.35-.94-1.7L12 1 2.95 6.3C2.38 6.65 2 7.28 2 8v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2l-.01-10zM12 13L3.74 7.84 12 3l8.26 4.84L12 13z',
};
const CHEVRON = '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7z"/></svg>';
const STAR = `<svg viewBox="0 0 24 24"><path d="${ICONS.starred}"/></svg>`;
const MAIN_ROLES = ['inbox', 'starred', 'important', 'sent', 'drafts'];
const MORE_ROLES = ['all', 'spam', 'trash'];
const ACTIONS = {
  inbox: ['unread', 'star', 'archive', 'trash'],
  starred: ['unread', 'star', 'archive', 'trash'],
  important: ['unread', 'star', 'archive', 'trash'],
  label: ['unread', 'star', 'archive', 'trash'],
  sent: ['unread', 'star', 'trash'],
  drafts: ['unread', 'star', 'trash'],
  all: ['unread', 'star', 'trash'],
  spam: ['unread', 'star', 'inbox', 'delete'],
  trash: ['unread', 'star', 'inbox', 'delete'],
};
const AVATAR_COLORS = ['#1a73e8', '#d93025', '#188038', '#e37400', '#9334e6', '#007b83', '#b31412', '#5f6368', '#c5221f', '#3c4043'];
const PREFETCH = 40;

let status = { state: 'signed-out' };
let folders = [];
let currentBox = 'INBOX';
let listBox = 'INBOX';
let listRole = 'inbox';
let listTotal = 0;
let convs = [];
let hasMore = false;
let searchQuery = '';
let selected = new Set();
let thread = null;
let openThrid = null;
let expanded = new Set();
const remoteOn = new Set();
let lastPrefetch = '';
let lastWatch = null;

/* ---- helpers ---- */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtDate(value, short) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    return value || '';
  }
  if (!short) {
    return d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  }
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  }
  return d.toLocaleDateString([], { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function fmtSize(n) {
  if (n > 1024 * 1024) {
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }
  if (n > 1024) {
    return `${Math.round(n / 1024)} KB`;
  }
  return `${n} B`;
}

function fmtNum(n) {
  return Number(n || 0).toLocaleString();
}

function avatarColor(email) {
  let h = 0;
  for (const c of String(email || '')) {
    h = (h * 31 + c.charCodeAt(0)) >>> 0;
  }
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

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

/* ---- layout: nav width and row density ---- */

const NAV_MIN = 160;
const NAV_MAX = 480;

function applyLayout() {
  const w = Math.min(NAV_MAX, Math.max(NAV_MIN, Number(store('layout.navWidth', 232)) || 232));
  $('app').style.setProperty('--nav-w', `${w}px`);
  const d = store('layout.density', 'comfortable');
  $('app').dataset.density = ['compact', 'cozy', 'comfortable'].includes(d) ? d : 'comfortable';
}

applyLayout();

$('splitter').addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) {
    return;
  }
  ev.preventDefault();
  const splitter = $('splitter');
  const startX = ev.clientX;
  const startW = $('folders').getBoundingClientRect().width;
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
    save('layout.navWidth', Math.round($('folders').getBoundingClientRect().width));
  };
  splitter.addEventListener('pointermove', move);
  splitter.addEventListener('pointerup', up);
  splitter.addEventListener('pointercancel', up);
});

$('splitter').addEventListener('dblclick', () => {
  save('layout.navWidth', 232);
  applyLayout();
});

$('density').addEventListener('click', (ev) => {
  ev.stopPropagation();
  const menu = $('density-menu');
  const current = $('app').dataset.density;
  for (const b of menu.querySelectorAll('[data-density]')) {
    b.textContent = `${b.dataset.density === current ? '\u2713 ' : ''}${b.dataset.density[0].toUpperCase()}${b.dataset.density.slice(1)}`;
  }
  menu.hidden = !menu.hidden;
  const r = $('density').getBoundingClientRect();
  menu.style.left = `${Math.max(4, r.right - 170)}px`;
  menu.style.top = `${r.bottom + 4}px`;
});

$('density-menu').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-density]');
  if (b) {
    save('layout.density', b.dataset.density);
    applyLayout();
  }
  $('density-menu').hidden = true;
});

window.addEventListener('pointerdown', (ev) => {
  if (!ev.target.closest('#density-menu, #density')) {
    $('density-menu').hidden = true;
  }
}, true);

const collapsed = store('folders.collapsed', { labels: false, paths: {} });
let moreOpen = store('folders.more', false);
let pinned = store('folders.pinned', []);
if (!Array.isArray(pinned)) {
  pinned = [];
}

function currentFolder() {
  return folders.find((f) => f.path === currentBox) || { path: currentBox, name: currentBox, role: 'label', count: null };
}

/* ---- rendering: shell ---- */

function render() {
  const signedIn = status.state !== 'signed-out';
  $('signin').hidden = signedIn;
  $('app').hidden = !signedIn;
  $('keyring-warn').hidden = status.keyring !== false;
  if (!signedIn) {
    $('signin-error').hidden = !status.error;
    $('signin-error').textContent = status.error || '';
    return;
  }
  $('account').textContent = status.user || '';
  const st = $('state');
  st.classList.toggle('error', status.state === 'error');
  st.textContent = status.state === 'ready' ? ''
    : status.state === 'connecting' ? 'connecting...' : (status.error || status.state);
  renderFolders();
  renderList();
}

function showList() {
  $('thread-view').hidden = true;
  $('list-view').hidden = false;
}

function showThread() {
  $('list-view').hidden = true;
  $('thread-view').hidden = false;
}

/* ---- rendering: folders ---- */

function folderItem(f, depth, chev) {
  const el = document.createElement('div');
  const counted = f.count !== null && f.count > 0;
  el.className = `folder${f.path === currentBox && !searchQuery ? ' active' : ''}${counted && f.countKind === 'unseen' ? ' has-count' : ''}`;
  el.dataset.path = f.path;
  el.dataset.role = f.role;
  el.title = f.role === 'label' ? f.path : f.name;
  el.style.paddingLeft = `${22 + depth * 14}px`;
  el.innerHTML = `${chev}<svg viewBox="0 0 24 24"><path d="${ICONS[f.role] || ICONS.label}"/></svg><span class="name"></span><span class="count"></span>`;
  el.querySelector('.name').textContent = f.name;
  el.querySelector('.count').textContent = counted ? String(f.count) : '';
  return el;
}

function renderFolders() {
  const frag = document.createDocumentFragment();
  const byRole = (r) => folders.find((f) => f.role === r);
  for (const r of MAIN_ROLES) {
    const f = byRole(r);
    if (f) {
      frag.appendChild(folderItem(f, 0, ''));
    }
  }
  const more = document.createElement('div');
  more.className = 'folder';
  more.id = 'more-toggle';
  more.innerHTML = `<span class="chev${moreOpen ? ' open' : ''}">${CHEVRON}</span><span class="name"></span>`;
  more.querySelector('.name').textContent = moreOpen ? 'Less' : 'More';
  frag.appendChild(more);
  if (moreOpen) {
    for (const r of MORE_ROLES) {
      const f = byRole(r);
      if (f) {
        frag.appendChild(folderItem(f, 0, ''));
      }
    }
  }

  const labels = folders.filter((f) => f.role === 'label');
  const pinnedSet = new Set(pinned.filter((p) => labels.some((f) => f.path === p)));
  for (const p of pinned) {
    const pf = labels.find((x) => x.path === p);
    if (pf) {
      const el = folderItem(pf, 0, '');
      el.dataset.pinned = '1';
      frag.appendChild(el);
    }
  }

  if (labels.length > 0) {
    const head = document.createElement('div');
    head.className = 'folder-head';
    head.id = 'labels-head';
    const unseen = labels.reduce((a, f) => a + (f.count > 0 && f.countKind === 'unseen' ? f.count : 0), 0);
    head.innerHTML = `<span class="chev${collapsed.labels ? '' : ' open'}">${CHEVRON}</span><span>Labels</span><span class="count"></span>`;
    head.querySelector('.count').textContent = collapsed.labels && unseen > 0 ? String(unseen) : '';
    frag.appendChild(head);
  }
  if (!collapsed.labels) {
    const hiddenDepth = [];
    labels.forEach((f, i) => {
      const depth = f.depth || 0;
      while (hiddenDepth.length > 0 && hiddenDepth[hiddenDepth.length - 1] >= depth) {
        hiddenDepth.pop();
      }
      if (hiddenDepth.length > 0 || pinnedSet.has(f.path)) {
        return;
      }
      const next = labels[i + 1];
      const parent = Boolean(next && (next.depth || 0) > depth);
      const closed = parent && Boolean(collapsed.paths[f.path]);
      if (closed) {
        hiddenDepth.push(depth);
      }
      const chev = `<span class="chev${parent ? (closed ? '' : ' open') : ' none'}" data-toggle="${parent ? '1' : ''}">${CHEVRON}</span>`;
      frag.appendChild(folderItem(f, depth, chev));
    });
  }
  $('folders').replaceChildren(frag);
  renderListBar();
  const watchKey = pinned.join(',');
  if (watchKey !== lastWatch) {
    lastWatch = watchKey;
    window.mail.watch(pinned);
  }
}

function renderListBar() {
  const f = currentFolder();
  const n = selected.size;
  $('bulk').hidden = n === 0;
  $('select-all').checked = n > 0 && n === convs.length;
  $('select-all').indeterminate = n > 0 && n < convs.length;
  if (searchQuery) {
    $('list-title').textContent = n > 0 ? `${n} selected` : `Search: ${searchQuery}`;
    $('read-all').hidden = true;
    $('pager').textContent = `${fmtNum(convs.length)} result${convs.length === 1 ? '' : 's'}`;
    $('page-next').hidden = true;
    return;
  }
  $('list-title').textContent = n > 0 ? `${n} selected`
    : (f.count !== null && f.count > 0 ? `${f.name}: ${fmtNum(f.count)} ${f.countKind === 'total' ? '' : 'unread'}`.trim() : f.name);
  $('read-all').hidden = n > 0 || !((f.countKind === 'unseen' && f.count > 0) || convs.some((c) => !c.seen));
  $('pager').textContent = convs.length > 0 ? `1-${fmtNum(convs.length)} of ${fmtNum(Math.max(listTotal, convs.length))}` : '';
  $('page-next').hidden = !hasMore;
}

/* ---- rendering: conversation list ---- */

function renderList() {
  const frag = document.createDocumentFragment();
  const hideArchive = listRole === 'all' || listRole === 'spam' || listRole === 'trash';
  for (const c of convs) {
    const row = document.createElement('div');
    row.className = `row${c.seen ? '' : ' unread'}${selected.has(c.thrid) ? ' selected' : ''}`;
    row.dataset.thrid = c.thrid;
    row.innerHTML = `<label class="check"><input type="checkbox"${selected.has(c.thrid) ? ' checked' : ''}><span></span></label>`
      + `<button class="star${c.flagged ? ' on' : ''}" title="Star">${STAR}</button>`
      + '<span class="names"></span>'
      + '<span class="subj"><span class="s"></span><span class="snip"></span></span>'
      + `<span class="date">${c.att ? '<svg class="clip" viewBox="0 0 24 24"><path d="M16.5 6v11.5a4 4 0 0 1-8 0V5a2.5 2.5 0 0 1 5 0v10.5a1 1 0 0 1-2 0V6H10v9.5a2.5 2.5 0 0 0 5 0V5a4 4 0 0 0-8 0v12.5a5.5 5.5 0 0 0 11 0V6h-1.5z"/></svg>' : ''}<span class="d"></span></span>`
      + '<span class="acts">'
      + (hideArchive ? '' : `<button class="tool" data-act="archive" title="Archive"><svg viewBox="0 0 24 24"><path d="${ICONS.archive}"/></svg></button>`)
      + `<button class="tool" data-act="trash" title="Delete"><svg viewBox="0 0 24 24"><path d="${ICONS.trash}"/></svg></button>`
      + `<button class="tool" data-act="read" title="${c.seen ? 'Mark as unread' : 'Mark as read'}"><svg viewBox="0 0 24 24"><path d="${c.seen ? ICONS.unread : ICONS.read}"/></svg></button>`
      + '</span>';
    const names = row.querySelector('.names');
    names.textContent = c.names.join(', ');
    if (c.count > 1) {
      const cnt = document.createElement('span');
      cnt.className = 'cnt';
      cnt.textContent = String(c.count);
      names.appendChild(cnt);
    }
    row.querySelector('.subj .s').textContent = c.subject;
    row.querySelector('.subj .snip').textContent = c.snippet ? ` \u2013 ${c.snippet}` : '';
    row.querySelector('.date .d').textContent = fmtDate(c.date, true);
    frag.appendChild(row);
  }
  $('list').replaceChildren(frag);
  $('list-empty').hidden = convs.length > 0 || status.state === 'connecting';
  renderListBar();
  const key = convs.slice(0, PREFETCH).map((c) => c.thrid).join(',');
  if (key && key !== lastPrefetch) {
    lastPrefetch = key;
    window.mail.prefetch(key.split(','));
  }
}

function applyList(res) {
  if (!res || searchQuery || res.box !== currentBox) {
    return;
  }
  listBox = res.box;
  listRole = res.role || 'label';
  listTotal = res.total || 0;
  convs = res.conversations;
  hasMore = res.more;
  const ids = new Set(convs.map((c) => c.thrid));
  selected = new Set([...selected].filter((t) => ids.has(t)));
  renderList();
}

function renderToolbar() {
  const allowed = ACTIONS[listRole] || ACTIONS.label;
  for (const a of ['unread', 'star', 'archive', 'inbox', 'trash', 'delete']) {
    $(`act-${a}`).hidden = !allowed.includes(a);
  }
  const c = convs.find((x) => x.thrid === openThrid);
  $('act-star').classList.toggle('on', Boolean(c && c.flagged));
}

/* ---- rendering: message bodies ---- */

const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;

function autolink(textValue) {
  let out = '';
  let last = 0;
  for (const m of textValue.matchAll(URL_RE)) {
    out += esc(textValue.slice(last, m.index));
    out += `<a href="${esc(m[0])}">${esc(m[0])}</a>`;
    last = m.index + m[0].length;
  }
  return out + esc(textValue.slice(last));
}

const READER_DROP = 'style, script, link, meta, title, base, iframe, frame, frameset, object, embed, applet, template, noscript';
const READER_URL_ATTRS = ['src', 'href', 'background', 'srcset', 'poster', 'action', 'formaction', 'xlink:href'];

/* Lifts the email's own <style> blocks and body attributes out of its
 * document so they survive inside the reader document.
 */
function composeHtml(html, inline) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const el of doc.querySelectorAll('img[src^="cid:"], [background^="cid:"]')) {
    const attr = el.hasAttribute('background') ? 'background' : 'src';
    const cid = el.getAttribute(attr).slice(4);
    let decoded = cid;
    try {
      decoded = decodeURIComponent(cid);
    } catch {
      /* keep the raw id */
    }
    const data = inline[cid] || inline[decoded];
    if (data) {
      el.setAttribute(attr, data);
    }
  }
  /* A "<" inside the collected CSS could close the style element it is
   * placed in: the CSS escape keeps it inert.
   */
  const styles = [...doc.querySelectorAll('style')].map((s) => s.textContent).join('\n').replace(/</g, '\\3c ');
  for (const el of doc.querySelectorAll(READER_DROP)) {
    el.remove();
  }
  for (const el of doc.querySelectorAll('form')) {
    el.replaceWith(...el.childNodes);
  }
  for (const el of doc.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || (READER_URL_ATTRS.includes(name) && /^\s*(javascript|vbscript|data:text\/html)/i.test(attr.value))) {
        el.removeAttribute(attr.name);
      }
    }
  }
  const body = doc.body || doc.createElement('body');
  const bg = body.getAttribute('bgcolor');
  const attrs = [
    /^#?[0-9a-z]{3,8}$/i.test(bg || '') ? `bgcolor="${bg}"` : '',
    body.hasAttribute('style') ? `style="${esc(body.getAttribute('style'))}"` : '',
    body.hasAttribute('class') ? `class="${esc(body.getAttribute('class'))}"` : '',
  ].filter(Boolean).join(' ');
  return { styles, attrs, body: body.innerHTML };
}

/* Reports the document height to the reader. The hash of this exact
 * text is allowed by the page and frame policies, nothing else runs.
 */
const HEIGHT_SCRIPT = 'const send=()=>parent.postMessage({appbox:"height",h:document.documentElement.scrollHeight},"*");'
  + 'new ResizeObserver(send).observe(document.documentElement);addEventListener("load",send);send();';
const HEIGHT_SCRIPT_HASH = 'sha256-wulLkro1fXKcB5UjbZOlHQa7SRqGmoFO6GIfgBTeYt8=';

function buildDoc(body, remote) {
  const plain = !body.html;
  const part = plain
    ? { styles: '', attrs: '', body: `<pre>${autolink(body.text || '')}</pre>` }
    : composeHtml(body.html, body.inline);
  const img = `data: ${remote ? 'https:' : ''}`;
  const csp = `default-src 'none'; img-src ${img}; style-src 'unsafe-inline'; font-src 'none'; script-src '${HEIGHT_SCRIPT_HASH}'; form-action 'none'; base-uri 'none'; frame-src 'none'; object-src 'none';`;
  const base = 'html{margin:0;padding:0}body{margin:0;padding:12px 16px;font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;'
    + '-webkit-font-smoothing:antialiased;word-break:break-word;overflow-wrap:anywhere}'
    + 'img{max-width:100%;height:auto}table{border-collapse:collapse}'
    + 'blockquote{border-left:3px solid #ccc;margin:0 0 0 4px;padding-left:10px}';
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = plain
    ? `body{background:${dark ? '#111' : '#fff'};color:${dark ? '#e8eaed' : '#1f1f1f'}}`
      + `pre{white-space:pre-wrap;max-width:88ch;font:14px/1.6 system-ui,sans-serif;margin:0}a{color:${dark ? '#8ab4f8' : '#0b57d0'}}`
    : 'body{background:#fff;color:#202124}a{color:#1a73e8}';
  return '<!doctype html><html><head><meta charset="utf-8">'
    + `<meta http-equiv="Content-Security-Policy" content="${csp}">`
    + '<meta http-equiv="x-dns-prefetch-control" content="off">'
    + '<base target="_blank">'
    + `<style>${base}${theme}</style><style>${part.styles}</style>`
    + `</head><body ${part.attrs}>${part.body}<script>${HEIGHT_SCRIPT}</script></body></html>`;
}

window.addEventListener('message', (ev) => {
  if (!ev.data || ev.data.appbox !== 'height') {
    return;
  }
  for (const f of document.querySelectorAll('iframe.msg-frame')) {
    if (f.contentWindow === ev.source) {
      f.style.height = `${Math.min(20000, Math.max(40, Number(ev.data.h) + 4))}px`;
    }
  }
});

/* ---- rendering: thread ---- */

function msgKey(m) {
  return `${m.box}\0${m.uid}`;
}

function hasRemote(body) {
  return Boolean(body && body.html) && /(src|background)\s*=\s*["']?https?:|url\(["']?https?:/i.test(body.html);
}

function renderThread() {
  if (!thread) {
    return;
  }
  $('empty').hidden = true;
  const first = thread.messages[0];
  $('thread-subject').textContent = (first && first.subject) || '(no subject)';
  /* Newest message first, older ones below it. */
  const frag = document.createDocumentFragment();
  for (const m of [...thread.messages].reverse()) {
    frag.appendChild(renderMessage(m));
  }
  $('thread-msgs').replaceChildren(frag);
  renderToolbar();
}

function renderMessage(m) {
  const key = msgKey(m);
  const open = expanded.has(key);
  const el = document.createElement('div');
  el.className = `msg${open ? ' open' : ''}${m.seen ? '' : ' unread'}`;
  el.dataset.uid = m.uid;
  el.dataset.box = m.box;
  const from = (m.body && m.body.from && m.body.from[0]) || m.from || { name: '', email: '' };
  const name = from.name || from.email || '(unknown)';
  const initial = (name.match(/[A-Za-z0-9\u00c0-\u024f]/) || ['?'])[0].toUpperCase();
  const to = m.body ? [...(m.body.to || []), ...(m.body.cc || [])] : [...(m.to || []), ...(m.cc || [])];
  const toText = to.map((a) => (a.email && status.user && a.email.toLowerCase() === status.user.toLowerCase()) ? 'me' : (a.name || a.email)).join(', ');
  el.innerHTML = '<div class="msg-head">'
    + `<span class="avatar" style="background:${avatarColor(from.email)}"></span>`
    + '<div class="who"><div><span class="from-name"></span><span class="from-email"></span></div><div class="to"></div><div class="peek"></div></div>'
    + '<span class="msg-date"></span>'
    + '<span class="msg-tools">'
    + '<button class="tool small" data-reply="reply" title="Reply"><svg viewBox="0 0 24 24"><path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg></button>'
    + '<button class="tool small" data-reply="all" title="Reply all"><svg viewBox="0 0 24 24"><path d="M7 8V5l-7 7 7 7v-3l-4-4 4-4zm6 1V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg></button>'
    + '<button class="tool small" data-reply="forward" title="Forward"><svg viewBox="0 0 24 24"><path d="M14 9V5l7 7-7 7v-4.1c-5 0-8.5 1.6-11 5.1 1-5 4-10 11-11z"/></svg></button>'
    + '</span></div>'
    + '<div class="msg-body"><div class="msg-atts" hidden></div><div class="msg-actions"></div><div class="msg-content"></div></div>';
  el.querySelector('.avatar').textContent = initial;
  el.querySelector('.from-name').textContent = name;
  el.querySelector('.from-email').textContent = from.email && name.toLowerCase() !== from.email.toLowerCase() ? `<${from.email}>` : '';
  el.querySelector('.to').textContent = toText ? `to ${toText}` : '';
  el.querySelector('.peek').textContent = m.snippet || '';
  el.querySelector('.msg-date').textContent = fmtDate(m.date, false);
  if (open) {
    fillBody(el, m);
  }
  return el;
}

const KIND_ICON = {
  pdf: '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 7V3.5L18.5 9H13zM8 17v-5h2a1.5 1.5 0 0 1 0 3H9v2H8zm1-3h1a.5.5 0 0 0 0-1H9v1zm3.5 3v-5h1.6c1.3 0 2.1 1 2.1 2.5S15.4 17 14.1 17h-1.6zm1-1h.6c.7 0 1.1-.5 1.1-1.5s-.4-1.5-1.1-1.5h-.6v3zM17.5 17v-5H20v1h-1.5v1H20v1h-1.5v2h-1z"/></svg>',
  image: '<svg viewBox="0 0 24 24"><path d="M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2zM8.5 13.5l2.5 3 3.5-4.5 4.5 6H5l3.5-4.5z"/></svg>',
  archive: '<svg viewBox="0 0 24 24"><path d="M20 6h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2zm-6 12h-2v-2h2v2zm0-4h-2v-2h2v2zm0-4h-2V8h2v2z"/></svg>',
  doc: '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>',
  sheet: '<svg viewBox="0 0 24 24"><path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm-9 14H5v-2h5v2zm0-4H5v-2h5v2zm0-4H5V7h5v2zm9 8h-7v-2h7v2zm0-4h-7v-2h7v2zm0-4h-7V7h7v2z"/></svg>',
  slides: '<svg viewBox="0 0 24 24"><path d="M21 3H3a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7v2H8v2h8v-2h-2v-2h7a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 14H3V5h18v12z"/></svg>',
  code: '<svg viewBox="0 0 24 24"><path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/></svg>',
  audio: '<svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>',
  video: '<svg viewBox="0 0 24 24"><path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z"/></svg>',
  text: '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zM8 12h8v2H8v-2zm0 4h8v2H8v-2zm5-7V3.5L18.5 9H13z"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 7V3.5L18.5 9H13z"/></svg>',
};

/* Human label and icon for an attachment from its MIME type and name. */
function fileKind(name, type) {
  const ext = (name.match(/\.([a-z0-9]+)$/i) || ['', ''])[1].toLowerCase();
  const t = String(type || '').toLowerCase();
  const by = (cls, label) => ({ cls, label, icon: KIND_ICON[cls] });
  if (t === 'application/pdf' || ext === 'pdf') {
    return by('pdf', 'PDF');
  }
  if (t.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'heic'].includes(ext)) {
    return by('image', `${(ext || t.split('/')[1] || 'image').toUpperCase()} image`);
  }
  if (t.startsWith('audio/') || ['mp3', 'wav', 'flac', 'ogg', 'm4a'].includes(ext)) {
    return by('audio', `${(ext || 'audio').toUpperCase()} audio`);
  }
  if (t.startsWith('video/') || ['mp4', 'mkv', 'mov', 'webm', 'avi'].includes(ext)) {
    return by('video', `${(ext || 'video').toUpperCase()} video`);
  }
  if (/zip|tar|gzip|x-7z|rar|bzip|xz|compressed/.test(t) || ['zip', 'tar', 'gz', 'tgz', '7z', 'rar', 'xz', 'bz2'].includes(ext)) {
    return by('archive', `${(ext || 'zip').toUpperCase()} archive`);
  }
  if (/msword|wordprocessing|opendocument\.text|rtf/.test(t) || ['doc', 'docx', 'odt', 'rtf'].includes(ext)) {
    return by('doc', 'Document');
  }
  if (/excel|spreadsheet|csv/.test(t) || ['xls', 'xlsx', 'ods', 'csv'].includes(ext)) {
    return by('sheet', ext === 'csv' ? 'CSV' : 'Spreadsheet');
  }
  if (/powerpoint|presentation/.test(t) || ['ppt', 'pptx', 'odp'].includes(ext)) {
    return by('slides', 'Presentation');
  }
  if (['c', 'h', 'cpp', 'hpp', 'py', 'js', 'ts', 'sh', 'rs', 'go', 'java', 'json', 'yaml', 'yml', 'toml', 'xml', 'html', 'css', 'dts', 'dtsi', 'cmake', 'patch', 'diff'].includes(ext)) {
    return by('code', `${ext.toUpperCase()} source`);
  }
  if (t.startsWith('text/') || ['txt', 'md', 'log', 'cfg', 'conf', 'ini'].includes(ext) || !ext) {
    return by('text', ext ? `${ext.toUpperCase()} text` : (t && t !== 'application/octet-stream' ? t : 'File'));
  }
  return by('file', ext ? `${ext.toUpperCase()} file` : (t || 'File'));
}

/* Attachment strip between the message header and its body. */
function renderMessageAttachments(el, m) {
  const strip = el.querySelector('.msg-atts');
  const list = (m.body && m.body.attachments) || [];
  strip.replaceChildren();
  strip.hidden = list.length === 0;
  if (list.length === 0) {
    return;
  }
  const download = async (indexes, label) => {
    try {
      const saved = await window.mail.download(m.box, m.uid, indexes, label);
      const dir = saved.length ? saved[0].path.replace(/\/[^/]*$/, '') : '';
      toast(`${label} saved to ${dir}`, () => window.mail.openFolder(dir));
    } catch (err) {
      toast(`Download failed: ${err.message.replace(/^Error invoking remote method '[^']+': Error: /, '')}`);
    }
  };
  for (const a of list) {
    const name = a.filename || `attachment ${a.index + 1}`;
    const kind = fileKind(name, a.type);
    const card = document.createElement('button');
    card.className = `att-file kind-${kind.cls}`;
    card.title = `${name}\n${kind.label}, ${fmtSize(a.size)}\nClick to download`;
    card.innerHTML = `<span class="att-icon">${kind.icon}</span>`
      + '<span class="att-text"><span class="name"></span><span class="meta"></span></span>'
      + '<svg class="dl" viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>';
    card.querySelector('.name').textContent = name;
    card.querySelector('.meta').textContent = `${kind.label} \u00b7 ${fmtSize(a.size)}`;
    card.addEventListener('click', () => download([a.index], name));
    strip.appendChild(card);
  }
  if (list.length > 1) {
    const all = document.createElement('button');
    all.className = 'btn ghost att-all';
    all.textContent = `Download all (${list.length})`;
    all.addEventListener('click', () => download(list.map((a) => a.index), `${list.length} files`));
    strip.appendChild(all);
  }
}

function fillBody(el, m) {
  const content = el.querySelector('.msg-content');
  const actions = el.querySelector('.msg-actions');
  actions.replaceChildren();
  if (!m.body) {
    content.innerHTML = '<div class="msg-loading">Loading...</div>';
    return;
  }
  const body = m.body;
  const key = msgKey(m);
  const remote = remoteOn.has(key) || Boolean(body.trusted);
  const sender = body.from && body.from[0] ? body.from[0].email : '';
  const note = (textValue) => {
    const n = document.createElement('span');
    n.className = 'msg-loading';
    n.textContent = textValue;
    actions.appendChild(n);
  };
  if (body.oversize) {
    note(`This message is ${fmtSize(body.oversize)} and is not shown here.`);
    const b = document.createElement('button');
    b.className = 'btn ghost';
    b.textContent = 'Open in Gmail';
    b.addEventListener('click', () => window.mail.open(body.url));
    actions.appendChild(b);
    renderMessageAttachments(el, m);
    content.replaceChildren();
    return;
  }
  if (body.truncated) {
    note('Only the beginning of this message is shown.');
  }
  if (hasRemote(body)) {
    if (!remote) {
      const b = document.createElement('button');
      b.className = 'btn ghost';
      b.textContent = 'Load remote images';
      b.addEventListener('click', () => {
        remoteOn.add(key);
        fillBody(el, m);
      });
      actions.appendChild(b);
    }
    if (sender) {
      const t = document.createElement('button');
      t.className = 'btn ghost';
      t.textContent = body.trusted ? `Stop loading images from ${sender}` : `Always load from ${sender}`;
      t.addEventListener('click', async () => {
        const on = !body.trusted;
        await window.mail.trust(sender, on);
        body.trusted = on;
        if (!on) {
          remoteOn.delete(key);
        }
        fillBody(el, m);
      });
      actions.appendChild(t);
    }
  }
  renderMessageAttachments(el, m);
  const frame = document.createElement('iframe');
  frame.className = `msg-frame${body.html ? '' : ' plain'}`;
  frame.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox');
  frame.title = 'Message';
  frame.srcdoc = buildDoc(body, remote);
  content.replaceChildren(frame);
}

async function toggleMessage(el) {
  const uid = Number(el.dataset.uid);
  const box = el.dataset.box;
  const m = thread && thread.messages.find((x) => x.uid === uid && x.box === box);
  if (!m) {
    return;
  }
  const key = msgKey(m);
  if (expanded.has(key)) {
    if (thread.messages.length > 1) {
      expanded.delete(key);
      el.classList.remove('open');
    }
    return;
  }
  expanded.add(key);
  el.classList.add('open');
  fillBody(el, m);
  if (!m.body) {
    try {
      m.body = await window.mail.message(box, uid);
    } catch (err) {
      el.querySelector('.msg-content').textContent = `Could not load message: ${err.message}`;
      return;
    }
    if (expanded.has(key) && el.isConnected) {
      fillBody(el, m);
    }
  }
}

async function openThread(thrid) {
  openThrid = thrid;
  thread = null;
  showThread();
  $('thread-subject').textContent = '';
  $('thread-msgs').replaceChildren();
  $('empty').hidden = false;
  $('empty').textContent = 'Loading...';
  renderToolbar();
  try {
    const conv = convs.find((x) => x.thrid === thrid);
    let t = await window.mail.thread(thrid);
    if (openThrid !== thrid) {
      return;
    }
    /* A cached conversation that predates a new reply has nothing
     * unread while the list row does: fetch it again.
     */
    if (conv && !conv.seen && t.messages.every((m) => m.seen)) {
      t = await window.mail.thread(thrid, true);
      if (openThrid !== thrid) {
        return;
      }
    }
    thread = t;
    expanded = new Set(t.messages.filter((m) => m.body).map(msgKey));
    if (expanded.size === 0 && t.messages.length > 0) {
      expanded.add(msgKey(t.messages[t.messages.length - 1]));
    }
    renderThread();
    $('thread-scroll').scrollTop = 0;
    const unseen = t.messages.filter((m) => !m.seen).map((m) => m.uid);
    const c = convs.find((x) => x.thrid === thrid);
    if (unseen.length > 0 || (c && !c.seen)) {
      for (const m of t.messages) {
        m.seen = true;
      }
      if (c) {
        c.seen = true;
      }
      if (unseen.length > 0) {
        applyList(await window.mail.flag(t.box, unseen, { seen: true }));
      }
      if (c && c.uids.length > 0) {
        /* Also by the folder's own uids, so the row cannot stay unread. */
        applyList(await window.mail.flag(listBox, c.uids, { seen: true }));
      }
    }
  } catch (err) {
    $('empty').textContent = `Could not load conversation: ${err.message}`;
  }
}

function closeThread() {
  thread = null;
  openThrid = null;
  $('thread-msgs').replaceChildren();
  showList();
  renderList();
}

/* ---- data loading ---- */

async function refreshList(more) {
  if (searchQuery) {
    return;
  }
  try {
    applyList(await window.mail.list(more));
  } catch (err) {
    console.error(err);
  }
}

/* The renderer owns the folder choice; only the first load adopts the
 * main process one, later replies may predate a click.
 */
async function refreshFolders(refresh, adopt) {
  try {
    const res = await window.mail.folders(refresh);
    folders = res.folders;
    if (adopt && currentBox !== res.current) {
      currentBox = res.current;
      closeThread();
    }
    renderFolders();
    renderToolbar();
  } catch (err) {
    console.error(err);
  }
}

async function selectFolder(box) {
  if (box === currentBox && !searchQuery) {
    closeThread();
    return;
  }
  clearSearch(false);
  currentBox = box;
  convs = [];
  hasMore = false;
  selected = new Set();
  closeThread();
  $('list').scrollTop = 0;
  renderFolders();
  try {
    applyList(await window.mail.select(box));
  } catch (err) {
    console.error(err);
  }
  renderToolbar();
}

async function runSearch(q) {
  searchQuery = q;
  $('search-clear').hidden = !q;
  closeThread();
  convs = [];
  selected = new Set();
  renderFolders();
  renderList();
  $('list-empty').hidden = true;
  $('list-title').textContent = `Searching: ${q}`;
  try {
    const res = await window.mail.search(q);
    if (searchQuery !== q) {
      return;
    }
    listBox = res.box;
    listRole = res.role;
    listTotal = res.conversations.length;
    convs = res.conversations;
    hasMore = false;
    renderList();
  } catch (err) {
    $('list-title').textContent = `Search failed: ${err.message}`;
  }
}

function clearSearch(reload) {
  if (!searchQuery) {
    return;
  }
  searchQuery = '';
  $('search').value = '';
  $('search-clear').hidden = true;
  selected = new Set();
  closeThread();
  renderFolders();
  if (reload) {
    refreshList(false);
  }
}

async function markAllRead(box) {
  try {
    applyList(await window.mail.readAll(box));
    const f = folders.find((x) => x.path === box);
    if (f && f.countKind === 'unseen') {
      f.count = 0;
    }
    renderFolders();
  } catch (err) {
    console.error(err);
  }
}

async function refreshStatus() {
  status = await window.mail.status();
  render();
}

/* ---- conversation actions ---- */

async function convsFlag(list, flags) {
  for (const c of list) {
    if (flags.seen !== undefined) {
      c.seen = flags.seen;
    }
    if (flags.flagged !== undefined) {
      c.flagged = flags.flagged;
    }
  }
  renderList();
  renderToolbar();
  try {
    applyList(await window.mail.flag(listBox, list.flatMap((c) => c.uids), flags));
  } catch (err) {
    console.error(err);
  }
}

async function convsMove(list, where) {
  const gone = new Set(list.map((c) => c.thrid));
  if (gone.has(openThrid)) {
    closeThread();
  }
  convs = convs.filter((x) => !gone.has(x.thrid));
  selected = new Set([...selected].filter((t) => !gone.has(t)));
  renderList();
  try {
    applyList(await window.mail.move(listBox, list.flatMap((c) => c.uids), where));
  } catch (err) {
    console.error(err);
  }
}

function openConv() {
  return convs.find((x) => x.thrid === openThrid) || null;
}

function selectedConvs() {
  return convs.filter((c) => selected.has(c.thrid));
}

/* ---- events: folders ---- */

$('folders').addEventListener('click', (ev) => {
  if (ev.target.closest('#labels-head')) {
    collapsed.labels = !collapsed.labels;
    save('folders.collapsed', collapsed);
    renderFolders();
    return;
  }
  if (ev.target.closest('#more-toggle')) {
    moreOpen = !moreOpen;
    save('folders.more', moreOpen);
    renderFolders();
    return;
  }
  const el = ev.target.closest('.folder');
  if (!el) {
    return;
  }
  const chev = ev.target.closest('.chev');
  if (chev && chev.dataset.toggle === '1') {
    collapsed.paths[el.dataset.path] = !collapsed.paths[el.dataset.path];
    save('folders.collapsed', collapsed);
    renderFolders();
    return;
  }
  selectFolder(el.dataset.path);
});

function hideFolderMenu() {
  $('folder-menu').hidden = true;
}

$('folders').addEventListener('contextmenu', (ev) => {
  const el = ev.target.closest('.folder');
  if (!el || !el.dataset.path) {
    return;
  }
  ev.preventDefault();
  const menu = $('folder-menu');
  const isPinned = pinned.includes(el.dataset.path);
  menu.dataset.path = el.dataset.path;
  $('folder-menu-pin').hidden = el.dataset.role !== 'label';
  $('folder-menu-pin').textContent = isPinned ? 'Unpin from top' : 'Pin to top';
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(ev.clientX, window.innerWidth - r.width - 4)}px`;
  menu.style.top = `${Math.min(ev.clientY, window.innerHeight - r.height - 4)}px`;
});

$('folder-menu-read').addEventListener('click', () => {
  const p = $('folder-menu').dataset.path;
  hideFolderMenu();
  markAllRead(p);
});

$('folder-menu-pin').addEventListener('click', () => {
  const p = $('folder-menu').dataset.path;
  pinned = pinned.includes(p) ? pinned.filter((x) => x !== p) : [...pinned, p];
  save('folders.pinned', pinned);
  hideFolderMenu();
  renderFolders();
});

window.addEventListener('pointerdown', (ev) => {
  if (!ev.target.closest('#folder-menu')) {
    hideFolderMenu();
  }
}, true);
window.addEventListener('blur', hideFolderMenu);

/* ---- events: list ---- */

$('list').addEventListener('click', (ev) => {
  const row = ev.target.closest('.row');
  if (!row) {
    return;
  }
  const c = convs.find((x) => x.thrid === row.dataset.thrid);
  if (!c) {
    return;
  }
  if (ev.target.closest('.check')) {
    return;
  }
  if (ev.target.closest('.star')) {
    convsFlag([c], { flagged: !c.flagged });
    return;
  }
  const act = ev.target.closest('[data-act]');
  if (act) {
    const a = act.dataset.act;
    if (a === 'read') {
      convsFlag([c], { seen: !c.seen });
    } else {
      convsMove([c], a);
    }
    return;
  }
  if (listRole === 'drafts') {
    openDraft(c);
    return;
  }
  openThread(c.thrid);
});

$('list').addEventListener('change', (ev) => {
  const row = ev.target.closest('.row');
  if (!row || ev.target.type !== 'checkbox') {
    return;
  }
  if (ev.target.checked) {
    selected.add(row.dataset.thrid);
  } else {
    selected.delete(row.dataset.thrid);
  }
  row.classList.toggle('selected', ev.target.checked);
  renderListBar();
});

$('select-all').addEventListener('change', () => {
  selected = $('select-all').checked ? new Set(convs.map((c) => c.thrid)) : new Set();
  renderList();
});

$('bulk-archive').addEventListener('click', () => convsMove(selectedConvs(), listRole === 'all' || listRole === 'spam' || listRole === 'trash' ? 'trash' : 'archive'));
$('bulk-trash').addEventListener('click', () => convsMove(selectedConvs(), listRole === 'trash' || listRole === 'spam' ? 'delete' : 'trash'));
$('bulk-read').addEventListener('click', () => {
  convsFlag(selectedConvs(), { seen: true });
  selected = new Set();
  renderList();
});
$('bulk-unread').addEventListener('click', () => {
  convsFlag(selectedConvs(), { seen: false });
  selected = new Set();
  renderList();
});

$('read-all').addEventListener('click', () => markAllRead(currentBox));
$('page-next').addEventListener('click', async () => {
  const before = convs.length;
  await refreshList(true);
  const rows = $('list').querySelectorAll('.row');
  if (rows[before]) {
    rows[before].scrollIntoView({ block: 'start' });
  }
});
$('page-prev').addEventListener('click', () => {
  $('list').scrollTop = 0;
});
$('refresh').addEventListener('click', () => {
  if (searchQuery) {
    runSearch(searchQuery);
  } else {
    refreshList(false);
  }
  refreshFolders(true);
});

/* ---- events: thread ---- */

$('thread-msgs').addEventListener('click', (ev) => {
  const rb = ev.target.closest('[data-reply]');
  if (rb) {
    const el = rb.closest('.msg');
    const m = thread && thread.messages.find((x) => x.uid === Number(el.dataset.uid) && x.box === el.dataset.box);
    if (m) {
      openComposer(rb.dataset.reply, m);
    }
    return;
  }
  if (ev.target.closest('.msg-actions, .msg-content, a, button')) {
    return;
  }
  const head = ev.target.closest('.msg-head');
  if (head) {
    toggleMessage(head.parentElement);
  }
});

$('back').addEventListener('click', closeThread);
$('open-gmail').addEventListener('click', () => window.mail.open('https://mail.google.com/mail/u/0/'));
$('act-open').addEventListener('click', () => {
  const m = thread && thread.messages.find((x) => x.body && x.body.url);
  window.mail.open(m ? m.body.url : 'https://mail.google.com/mail/u/0/');
});
$('app-pw-link').addEventListener('click', (ev) => {
  ev.preventDefault();
  window.open('https://myaccount.google.com/apppasswords');
});

$('act-unread').addEventListener('click', async () => {
  const c = openConv();
  if (c) {
    closeThread();
    await convsFlag([c], { seen: false });
  }
});

$('act-star').addEventListener('click', () => {
  const c = openConv();
  if (c) {
    convsFlag([c], { flagged: !c.flagged });
  }
});

for (const where of ['archive', 'inbox', 'trash', 'delete']) {
  $(`act-${where}`).addEventListener('click', () => {
    const c = openConv();
    if (c) {
      convsMove([c], where);
    }
  });
}

/* ---- events: search, sign-in, keyboard ---- */

$('search-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const q = $('search').value.trim();
  if (q) {
    runSearch(q);
  } else {
    clearSearch(true);
  }
});
$('search-clear').addEventListener('click', () => clearSearch(true));
$('search').addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    clearSearch(true);
    $('search').blur();
  }
});

$('signin-btn').addEventListener('click', async () => {
  const user = $('user').value.trim();
  const pass = $('pass').value;
  if (!user || !pass) {
    return;
  }
  $('signin-btn').disabled = true;
  $('signin-error').hidden = true;
  try {
    status = await window.mail.login(user, pass);
    $('pass').value = '';
    render();
    await refreshFolders(false, true);
    refreshList(false);
  } catch (err) {
    $('signin-error').textContent = err.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
    $('signin-error').hidden = false;
  } finally {
    $('signin-btn').disabled = false;
  }
});

$('pass').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    $('signin-btn').click();
  }
});

$('signout').addEventListener('click', async () => {
  status = await window.mail.logout();
  convs = [];
  folders = [];
  currentBox = 'INBOX';
  selected = new Set();
  clearSearch(false);
  closeThread();
  render();
});

window.mail.onEvent(async (ev) => {
  if (ev.type === 'status') {
    status = ev.status;
    render();
  } else if (ev.type === 'list') {
    refreshList(false);
  } else if (ev.type === 'folders') {
    refreshFolders(false);
  } else if (ev.type === 'open') {
    if (ev.box && ev.box !== currentBox) {
      await selectFolder(ev.box);
    } else {
      clearSearch(false);
      await refreshList(false);
    }
    const c = convs.find((x) => x.thrid === String(ev.thrid) || x.uids.includes(Number(ev.uid)));
    if (c) {
      openThread(c.thrid);
    }
  }
});

/* ---- composer ---- */

const FONT_SIZES = { small: '2', normal: '3', large: '5', huge: '7' };
let attachments = [];
let draftRef = { inReplyTo: '', references: '' };
let draftUid = 0;
let composerMode = 'rich';
let composerState = 'normal';
let toastTimer = null;
let draftTimer = null;

function toast(msg, onClick) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  t.onclick = onClick || null;
  t.classList.toggle('clickable', Boolean(onClick));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.hidden = true;
  }, onClick ? 7000 : 4000);
}

function isMe(a) {
  return Boolean(a && a.email && status.user && a.email.toLowerCase() === status.user.toLowerCase());
}

function addrList(list) {
  return (list || []).map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(', ');
}

function bodyText(m) {
  const b = m.body;
  if (!b) {
    return m.snippet || '';
  }
  if (b.text) {
    return b.text;
  }
  if (b.html) {
    const doc = new DOMParser().parseFromString(b.html, 'text/html');
    for (const el of doc.querySelectorAll('style, script')) {
      el.remove();
    }
    return (doc.body.innerText || doc.body.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
  }
  return '';
}

function textToHtml(textValue) {
  return autolink(textValue).replace(/\n/g, '<br>');
}

function quoteHeader(m) {
  const from = (m.body && m.body.from && m.body.from[0]) || m.from || { name: '', email: '' };
  const who = from.name ? `${from.name} <${from.email}>` : from.email;
  return `On ${fmtDate(m.date, false)}, ${who} wrote:`;
}

function quoteText(m) {
  return `\n\n${quoteHeader(m)}\n${bodyText(m).split('\n').map((l) => `> ${l}`).join('\n')}\n`;
}

function quoteHtml(m) {
  return `<br><br><div>${esc(quoteHeader(m))}</div>`
    + `<blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${textToHtml(bodyText(m))}</blockquote>`;
}

function forwardHeader(m) {
  const b = m.body || m;
  return '---------- Forwarded message ---------\n'
    + `From: ${addrList(b.from || [m.from])}\n`
    + `Date: ${fmtDate(m.date, false)}\n`
    + `Subject: ${m.subject || ''}\n`
    + `To: ${addrList(b.to || m.to)}\n`
    + (b.cc && b.cc.length ? `Cc: ${addrList(b.cc)}\n` : '');
}

/* ---- markdown: a small converter for the Markdown tab ---- */

function mdInline(s) {
  let out = esc(s);
  out = out.replace(/`([^`]+)`/g, (m, c) => `<code>${c}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/__([^_]+)__/g, '<b>$1</b>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>').replace(/(^|[^_])_([^_\n]+)_/g, '$1<i>$2</i>');
  out = out.replace(/~~([^~]+)~~/g, '<s>$1</s>');
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2">$2</a>');
  return out;
}

function markdownToHtml(src) {
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  const out = [];
  let i = 0;
  const para = [];
  const flushPara = () => {
    if (para.length > 0) {
      out.push(`<p>${para.map(mdInline).join('<br>')}</p>`);
      para.length = 0;
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flushPara();
      const code = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      out.push(`<pre style="background:#f1f3f4;padding:8px;border-radius:4px"><code>${esc(code.join('\n'))}</code></pre>`);
      i += 1;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      out.push(`<h${h[1].length}>${mdInline(h[2])}</h${h[1].length}>`);
      i += 1;
      continue;
    }
    if (/^(---|\*\*\*)\s*$/.test(line)) {
      flushPara();
      out.push('<hr>');
      i += 1;
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushPara();
      const q = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        q.push(lines[i].replace(/^>\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${markdownToHtml(q.join('\n'))}</blockquote>`);
      continue;
    }
    const li = /^\s*([-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      const ordered = /\d/.test(li[1]);
      const items = [];
      while (i < lines.length) {
        const m = /^\s*([-*+]|\d+\.)\s+(.*)$/.exec(lines[i]);
        if (!m || /\d/.test(m[1]) !== ordered) {
          break;
        }
        items.push(`<li>${mdInline(m[2])}</li>`);
        i += 1;
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    if (line.trim() === '') {
      flushPara();
    } else {
      para.push(line);
    }
    i += 1;
  }
  flushPara();
  return out.join('\n');
}

/* ---- composer state ---- */

function editor() {
  return $('c-editor');
}

function setMode(mode) {
  composerMode = mode;
  for (const t of document.querySelectorAll('#c-tabs [data-mode]')) {
    t.classList.toggle('active', t.dataset.mode === mode);
  }
  $('c-rich').hidden = mode !== 'rich';
  $('c-md').hidden = mode !== 'markdown';
  $('c-preview').hidden = mode !== 'preview';
  $('c-toolbar').hidden = mode !== 'rich';
  if (mode === 'preview') {
    $('c-preview').innerHTML = markdownToHtml($('c-mdtext').value);
  }
  if (mode === 'rich') {
    editor().focus();
  } else if (mode === 'markdown') {
    $('c-mdtext').focus();
  }
}

/* Converts between the tabs when switching so nothing typed is lost. */
function switchMode(mode) {
  if (mode === composerMode) {
    return;
  }
  if (composerMode === 'rich' && mode !== 'rich') {
    const text = editor().innerText.replace(/\n{3,}/g, '\n\n').trim();
    if (!$('c-mdtext').value.trim() || text !== $('c-mdtext').dataset.fromRich) {
      $('c-mdtext').value = text;
      $('c-mdtext').dataset.fromRich = text;
    }
  } else if (composerMode !== 'rich' && mode === 'rich') {
    editor().innerHTML = markdownToHtml($('c-mdtext').value);
  }
  setMode(mode);
}

function setState(state) {
  composerState = state;
  const c = $('composer');
  c.classList.toggle('max', state === 'max');
  c.classList.toggle('min', state === 'min');
  $('c-max').title = state === 'max' ? 'Exit full screen' : 'Full screen';
}

function currentContent() {
  const text = composerMode === 'rich'
    ? editor().innerText.replace(/\n{3,}/g, '\n\n').trim()
    : $('c-mdtext').value;
  const html = composerMode === 'rich'
    ? `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px">${editor().innerHTML}</div>`
    : `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px">${markdownToHtml($('c-mdtext').value)}</div>`;
  return { text, html };
}

function hasContent() {
  const { text } = currentContent();
  return Boolean($('c-to').value || $('c-cc').value || $('c-bcc').value || $('c-subject').value || text.trim() || attachments.length);
}

function saveLocalDraft() {
  save('compose.draft', {
    to: $('c-to').value, cc: $('c-cc').value, bcc: $('c-bcc').value,
    subject: $('c-subject').value, mode: composerMode,
    html: editor().innerHTML, md: $('c-mdtext').value, ref: draftRef, draftUid,
  });
}

function clearLocalDraft() {
  try {
    localStorage.removeItem('compose.draft');
  } catch {
    /* nothing stored */
  }
}

function renderAttachments() {
  $('c-attachments').replaceChildren(...attachments.map((a, i) => {
    const chip = document.createElement('span');
    chip.className = 'att';
    chip.textContent = `${a.name} (${fmtSize(a.size)})`;
    const x = document.createElement('button');
    x.textContent = '\u00d7';
    x.title = 'Remove';
    x.addEventListener('click', () => {
      attachments.splice(i, 1);
      renderAttachments();
    });
    chip.appendChild(x);
    return chip;
  }));
}

function showComposer(f) {
  $('c-to').value = f.to || '';
  $('c-cc').value = f.cc || '';
  $('c-bcc').value = f.bcc || '';
  $('c-subject').value = f.subject || '';
  $('c-cc-row').hidden = !f.cc;
  $('c-bcc-row').hidden = !f.bcc;
  editor().innerHTML = f.html || '';
  $('c-mdtext').value = f.md || '';
  $('c-mdtext').dataset.fromRich = '';
  draftRef = f.ref || { inReplyTo: '', references: '' };
  draftUid = f.draftUid || 0;
  attachments = [];
  renderAttachments();
  $('c-error').hidden = true;
  $('composer-title').textContent = f.title || 'New message';
  $('composer').hidden = false;
  setState('normal');
  setMode(f.mode || store('compose.mode', 'rich'));
  if (f.to && composerMode === 'rich') {
    const sel = window.getSelection();
    sel.removeAllRanges();
    const range = document.createRange();
    range.setStart(editor(), 0);
    range.collapse(true);
    sel.addRange(range);
  } else if (!f.to) {
    $('c-to').focus();
  }
}

function openComposer(mode, m) {
  if (!mode) {
    const d = store('compose.draft', null);
    showComposer(d ? { ...d, title: 'Draft' } : {});
    return;
  }
  const b = m.body || {};
  const from = (b.from && b.from[0]) || m.from || { name: '', email: '' };
  const subj = String(m.subject || '').replace(/^\s*((re|fwd?)\s*:\s*)+/i, '');
  const refs = [m.references, m.messageId].filter(Boolean).join(' ');
  const ref = { inReplyTo: m.messageId || '', references: refs };
  if (mode === 'forward') {
    showComposer({
      subject: `Fwd: ${subj}`, title: 'Forward', ref,
      html: `<br><br><div>${textToHtml(forwardHeader(m))}</div><br>${textToHtml(bodyText(m))}`,
      md: `\n\n${forwardHeader(m)}\n${bodyText(m)}\n`,
    });
    return;
  }
  let to = [from];
  let cc = [];
  if (mode === 'all') {
    const others = [...(b.to || m.to || []), ...(b.cc || m.cc || [])].filter((a) => !isMe(a) && a.email !== from.email);
    if (isMe(from)) {
      to = (b.to || m.to || []).filter((a) => !isMe(a));
      cc = (b.cc || m.cc || []).filter((a) => !isMe(a));
    } else {
      cc = others;
    }
  }
  showComposer({
    to: addrList(to), cc: addrList(cc), subject: `Re: ${subj}`, ref,
    html: quoteHtml(m), md: quoteText(m),
    title: mode === 'all' ? 'Reply all' : 'Reply',
  });
}

/* A draft written by another client is HTML from the server: only
 * plain markup with inline images and safe inline styles goes into the
 * editor.
 */
const DRAFT_DROP = 'script, style, link, meta, base, iframe, frame, object, embed, form, svg, math, template, noscript';
const DRAFT_URL_ATTRS = ['src', 'href', 'background', 'srcset', 'poster', 'action', 'formaction'];
const DRAFT_STYLE_PROPS = ['color', 'background-color', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-decoration', 'text-align'];
const DRAFT_STYLE_VALUE = /^(?:[\w\s#,.%'"-]|rgba?\(|hsla?\(|\))*$/;

/* Keeps only the listed properties with values that cannot fetch. */
function draftStyle(value) {
  const kept = [];
  for (const decl of value.split(';')) {
    const colon = decl.indexOf(':');
    const prop = decl.slice(0, colon).trim().toLowerCase();
    const v = decl.slice(colon + 1).trim();
    if (colon !== -1 && DRAFT_STYLE_PROPS.includes(prop) && v !== '' && DRAFT_STYLE_VALUE.test(v)) {
      kept.push(`${prop}:${v}`);
    }
  }
  return kept.join(';');
}

function sanitizeDraft(html, inline) {
  const doc = new DOMParser().parseFromString(composeHtml(html, inline || {}).body, 'text/html');
  for (const el of doc.querySelectorAll(DRAFT_DROP)) {
    el.remove();
  }
  for (const el of doc.body.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
      } else if (name === 'style') {
        const kept = draftStyle(value);
        if (kept === '') {
          el.removeAttribute(attr.name);
        } else {
          el.setAttribute(attr.name, kept);
        }
      } else if (DRAFT_URL_ATTRS.includes(name) && !/^(https?:|mailto:|data:image\/)/i.test(value)) {
        el.removeAttribute(attr.name);
      } else if (name === 'src' && /^https?:/i.test(value) && el.tagName === 'IMG') {
        el.removeAttribute(attr.name);
      }
    }
  }
  return doc.body.innerHTML;
}

/* A row in the Drafts folder reopens the draft for editing. */
async function openDraft(c) {
  try {
    const body = await window.mail.message(listBox, c.uid);
    showComposer({
      to: addrList(body.to), cc: addrList(body.cc), subject: body.subject === '(no subject)' ? '' : body.subject,
      html: body.html ? sanitizeDraft(body.html, body.inline) : textToHtml(body.text || ''),
      md: body.text || '', title: 'Draft', draftUid: c.uid, mode: 'rich',
    });
  } catch (err) {
    toast(`Could not open draft: ${err.message}`);
  }
}

function composerPayload() {
  const { text, html } = currentContent();
  return {
    to: $('c-to').value, cc: $('c-cc').value, bcc: $('c-bcc').value,
    subject: $('c-subject').value, text, html,
    inReplyTo: draftRef.inReplyTo, references: draftRef.references, draftUid,
    attachments: attachments.map((a) => ({ path: a.path, name: a.name })),
  };
}

async function saveServerDraft() {
  if (!hasContent()) {
    return;
  }
  try {
    const uid = await window.mail.draftSave(composerPayload());
    if (uid) {
      draftUid = uid;
      toast('Draft saved');
    }
  } catch (err) {
    toast(`Draft not saved: ${err.message.replace(/^Error invoking remote method '[^']+': Error: /, '')}`);
  }
}

async function closeComposer(discard) {
  clearTimeout(draftTimer);
  if (discard) {
    clearLocalDraft();
    $('composer').hidden = true;
    if (draftUid) {
      const uid = draftUid;
      draftUid = 0;
      await window.mail.draftDelete(uid).catch(() => {});
    }
    return;
  }
  if (hasContent()) {
    saveLocalDraft();
    $('composer').hidden = true;
    await saveServerDraft();
    clearLocalDraft();
  } else {
    clearLocalDraft();
    $('composer').hidden = true;
  }
}

$('compose').addEventListener('click', () => openComposer(null));
$('composer-close').addEventListener('click', () => closeComposer(false));
$('c-discard').addEventListener('click', () => closeComposer(true));
$('c-min').addEventListener('click', () => setState(composerState === 'min' ? 'normal' : 'min'));
$('c-max').addEventListener('click', () => setState(composerState === 'max' ? 'normal' : 'max'));
$('composer-head').addEventListener('dblclick', (ev) => {
  if (!ev.target.closest('button')) {
    setState(composerState === 'min' ? 'normal' : 'min');
  }
});
$('c-cc-toggle').addEventListener('click', () => {
  $('c-cc-row').hidden = false;
  $('c-cc').focus();
});
$('c-bcc-toggle').addEventListener('click', () => {
  $('c-bcc-row').hidden = false;
  $('c-bcc').focus();
});
$('c-attach').addEventListener('click', async () => {
  const files = await window.mail.pickFiles();
  for (const f of files || []) {
    if (!attachments.some((a) => a.path === f.path)) {
      attachments.push(f);
    }
  }
  renderAttachments();
});
$('c-tabs').addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-mode]');
  if (t) {
    switchMode(t.dataset.mode);
    if (t.dataset.mode !== 'preview') {
      save('compose.mode', t.dataset.mode);
    }
  }
});

$('c-toolbar').addEventListener('mousedown', (ev) => {
  if (ev.target.closest('button')) {
    ev.preventDefault();
  }
});
$('c-toolbar').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-cmd]');
  if (!b) {
    return;
  }
  const cmd = b.dataset.cmd;
  if (cmd === 'createLink') {
    const url = window.prompt('Link address', 'https://');
    if (url && url !== 'https://') {
      document.execCommand('createLink', false, url);
    }
  } else if (cmd === 'blockquote') {
    document.execCommand('formatBlock', false, 'blockquote');
  } else {
    document.execCommand(cmd, false, b.dataset.value || null);
  }
  editor().focus();
});
$('c-font').addEventListener('change', () => {
  document.execCommand('fontName', false, $('c-font').value);
  editor().focus();
});
$('c-size').addEventListener('change', () => {
  document.execCommand('fontSize', false, FONT_SIZES[$('c-size').value] || '3');
  editor().focus();
});

$('c-send').addEventListener('click', async () => {
  const btn = $('c-send');
  btn.disabled = true;
  btn.textContent = 'Sending...';
  $('c-error').hidden = true;
  try {
    const r = await window.mail.send(composerPayload());
    clearLocalDraft();
    draftUid = 0;
    $('composer').hidden = true;
    toast(`Message sent to ${r.recipients} recipient${r.recipients === 1 ? '' : 's'}`);
  } catch (err) {
    $('c-error').textContent = err.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
    $('c-error').hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send';
  }
});

for (const id of ['c-to', 'c-cc', 'c-bcc', 'c-subject', 'c-mdtext', 'c-editor']) {
  $(id).addEventListener('input', () => {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveLocalDraft, 800);
  });
}

window.addEventListener('keydown', (ev) => {
  const composing = !$('composer').hidden;
  if (composing && ev.ctrlKey && ev.key === 'Enter') {
    $('c-send').click();
    return;
  }
  if (composing && ev.key === 'Escape') {
    closeComposer(false);
    return;
  }
  if (composing && ev.ctrlKey && composerMode === 'rich' && ['b', 'i', 'u'].includes(ev.key)) {
    return;
  }
  if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA' || ev.target.isContentEditable) {
    return;
  }
  if (ev.key === 'Escape' || (ev.key === 'u' && openThrid !== null)) {
    if (openThrid !== null) {
      closeThread();
    } else if (selected.size > 0) {
      selected = new Set();
      renderList();
    }
  }
});

refreshStatus().then(async () => {
  if (status.state !== 'signed-out') {
    await refreshFolders(false, true);
    refreshList(false);
  }
});
