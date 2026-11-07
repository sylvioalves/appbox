'use strict';

const $ = (id) => document.getElementById(id);

const ICONS = {
  turn: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z',
  waiting: 'M6 2v6h.01L6 8.01 10 12l-4 4 .01.01H6V22h12v-5.99h-.01L18 16l-4-4 4-3.99-.01-.01H18V2H6zm10 14.5V20H8v-3.5l4-4 4 4zm-4-5l-4-4V4h8v3.5l-4 4z',
  requested: 'M12 4.5C7 4.5 2.7 7.6 1 12c1.7 4.4 6 7.5 11 7.5s9.3-3.1 11-7.5c-1.7-4.4-6-7.5-11-7.5zM12 17a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  assignee: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0 2c-2.7 0-8 1.3-8 4v2h16v-2c0-2.7-5.3-4-8-4z',
  reviewed: 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
  commented: 'M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z',
  author: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
  merged: 'M17 7a3 3 0 1 0-4 2.83V10a2 2 0 0 1-2 2H9a4 4 0 0 0-2 .54V8.83a3 3 0 1 0-2 0v6.34a3 3 0 1 0 2 0V15a2 2 0 0 1 2-2h2a4 4 0 0 0 4-4v-.17A3 3 0 0 0 17 7z',
  all: 'M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z',
  issues: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm0-11a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  list: 'M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z',
  add: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
};

const BUCKETS = [
  { id: 'turn', name: 'My turn', filter: (r) => !r.merged && r.turn === 'mine' },
  { id: 'waiting', name: 'Waiting on others', filter: (r) => !r.merged && r.turn === 'theirs' },
  { id: 'requested', name: 'Review requested', filter: (r) => !r.merged && r.flags.requested },
  { id: 'assignee', name: 'Assigned to me', filter: (r) => !r.merged && r.flags.assignee },
  { id: 'reviewed', name: 'Reviewed by me', filter: (r) => !r.merged && r.flags.reviewed },
  { id: 'commented', name: 'Commented', filter: (r) => !r.merged && r.flags.commented },
  { id: 'author', name: 'My pull requests', filter: (r) => !r.merged && r.flags.author },
  { id: 'issues', name: 'Issues assigned to me', filter: (r) => !r.merged && r.flags.issues },
  { id: 'merged', name: 'Merged', filter: (r) => r.merged },
  { id: 'all', name: 'Everything open', filter: (r) => !r.merged },
];

const WHY = {
  review: 'your review',
  ci: 'CI',
  conflicts: 'conflicts',
  changes: 'changes requested',
  issue: 'assigned to you',
};

const MY_REVIEW = {
  APPROVED: ['approved by you', 'ok'],
  CHANGES_REQUESTED: ['you requested changes', 'err'],
  COMMENTED: ['you commented', ''],
  DISMISSED: ['your review was dismissed', 'warn'],
};

let status = { state: 'signed-out' };
let rows = [];
let bucket = 'turn';
let query = '';
let excludes = [];
let lists = [];
let editing = null;
let renaming = null;

/* The built-in lists and the saved searches, in the order the user
 * arranged them, without the ones they hid.
 */
function allBuckets() {
  const all = BUCKETS.map((b) => ({ ...b })).concat(lists.map((l) => ({
    id: `list:${l.id}`, name: l.name, custom: l, filter: (r) => Boolean(r.lists && Object.hasOwn(r.lists, l.id)),
  })));
  const order = store('gh.order', []);
  const hidden = new Set(store('gh.hidden', []));
  const names = store('gh.names', {});
  for (const b of all) {
    if (!b.custom && typeof names[b.id] === 'string' && names[b.id]) {
      b.name = names[b.id];
    }
  }
  const rank = (b) => {
    const i = order.indexOf(b.id);
    return i === -1 ? order.length + all.indexOf(b) : i;
  };
  return all.filter((b) => !hidden.has(b.id)).sort((a, b) => rank(a) - rank(b));
}

function hiddenCount() {
  const ids = new Set(BUCKETS.map((b) => b.id).concat(lists.map((l) => `list:${l.id}`)));
  return store('gh.hidden', []).filter((id) => ids.has(id)).length;
}

function currentBucket() {
  return allBuckets().find((x) => x.id === bucket) || BUCKETS[0];
}

function saveOrder(ids) {
  save('gh.order', ids);
  renderNav();
}

function moveBucket(id, delta) {
  const ids = allBuckets().map((b) => b.id);
  const i = ids.indexOf(id);
  const j = i + delta;
  if (i === -1 || j < 0 || j >= ids.length) {
    return;
  }
  [ids[i], ids[j]] = [ids[j], ids[i]];
  saveOrder(ids);
}

function hideBucket(id) {
  const hidden = store('gh.hidden', []);
  if (!hidden.includes(id)) {
    hidden.push(id);
    save('gh.hidden', hidden);
  }
  if (bucket === id) {
    bucket = allBuckets()[0] ? allBuckets()[0].id : 'turn';
    save('gh.bucket', bucket);
  }
  render();
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

function excluded(r) {
  const t = String(r.title || '').toLowerCase();
  return excludes.some((k) => t.includes(k));
}

/* Rows left after the keyword filter, the base of every list. */
function kept() {
  return rows.filter((r) => !excluded(r));
}

/* With a search, every list and count is the search result instead. */
function base() {
  const q = query.toLowerCase();
  return q ? rows.filter((r) => `${r.title} ${r.author} ${r.repo} ${r.number}`.toLowerCase().includes(q)) : kept();
}

function ago(value) {
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) {
    return '';
  }
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 3600) {
    return `${Math.max(1, Math.round(s / 60))}m`;
  }
  if (s < 86400) {
    return `${Math.round(s / 3600)}h`;
  }
  if (s < 86400 * 30) {
    return `${Math.round(s / 86400)}d`;
  }
  return `${Math.round(s / (86400 * 30))}mo`;
}

function visible() {
  const b = currentBucket();
  let list = base().filter(b.filter);
  if ($('f-hide-drafts').checked) {
    list = list.filter((r) => !r.draft);
  }
  return list.sort((x, y) => (x.updated_at < y.updated_at ? 1 : -1));
}

function listForm(typed) {
  const form = document.createElement('div');
  form.id = 'list-form';
  const l = typed || (editing && editing.id ? editing : { name: '', query: '' });
  form.innerHTML = '<input id="list-name" placeholder="List name" spellcheck="false" maxlength="60">'
    + '<input id="list-query" placeholder="GitHub search, e.g. is:issue is:open esp32" spellcheck="false" maxlength="300">'
    + '<div class="actions"><button type="button" class="btn small primary" id="list-save">Save</button>'
    + '<button type="button" class="btn small" id="list-cancel">Cancel</button>'
    + `${editing && editing.id ? '<button type="button" class="btn small" id="list-up" title="Move up">&#9650;</button>'
      + '<button type="button" class="btn small" id="list-down" title="Move down">&#9660;</button>'
      + '<button type="button" class="btn small danger" id="list-delete">Delete</button>' : ''}</div>`
    + '<p class="error" id="list-error" hidden></p>';
  form.querySelector('#list-name').value = l.name;
  form.querySelector('#list-query').value = l.query;
  return form;
}

function renderNav(preserve = true) {
  /* A redraw while the form is open keeps what was typed. */
  const typed = preserve && editing && $('list-name') ? { name: $('list-name').value, query: $('list-query').value } : null;
  const frag = document.createDocumentFragment();
  const dividers = store('gh.dividers', []);
  for (const b of allBuckets()) {
    if (dividers.includes(b.id)) {
      const sep = document.createElement('div');
      sep.className = 'bucket-sep';
      frag.appendChild(sep);
    }
    const matching = base().filter(b.filter);
    const unread = matching.filter((r) => r.unread).length;
    const el = document.createElement('div');
    el.className = `bucket${b.id === bucket ? ' active' : ''}${b.custom ? ' custom' : ''}`;
    el.dataset.id = b.id;
    const error = b.custom && status.listErrors && Object.hasOwn(status.listErrors, b.custom.id)
      ? status.listErrors[b.custom.id] : null;
    el.innerHTML = `<svg viewBox="0 0 24 24"><path d="${ICONS[b.custom ? 'list' : b.id] || ICONS.all}"/></svg>`
      + `<span class="name"></span>${error ? '<span class="err-dot"></span>' : ''}<span class="count"></span>`
      + (b.custom ? '<button type="button" class="edit" title="Edit list"><svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg></button>' : '');
    el.querySelector('.name').textContent = b.name;
    if (renaming === b.id) {
      const input = document.createElement('input');
      input.id = 'rename-input';
      input.value = b.name;
      input.maxLength = 60;
      input.spellcheck = false;
      el.querySelector('.name').replaceWith(input);
    }
    if (error) {
      el.title = error;
    } else if (b.custom) {
      el.title = b.custom.query;
    }
    el.draggable = renaming !== b.id;
    el.querySelector('.count').textContent = unread > 0 ? `${unread} / ${matching.length}` : String(matching.length);
    frag.appendChild(el);
    if (editing && editing.id && b.custom && editing.id === b.custom.id) {
      frag.appendChild(listForm(typed));
    }
  }
  const add = document.createElement('div');
  add.className = 'bucket add-list';
  add.innerHTML = `<svg viewBox="0 0 24 24"><path d="${ICONS.add}"/></svg><span class="name">New list</span>`;
  frag.appendChild(add);
  if (editing && !editing.id) {
    frag.appendChild(listForm(typed));
  }
  $('nav').replaceChildren(frag);
  const name = $('list-name') || $('rename-input');
  if (name) {
    name.focus();
    name.select();
  }
}

function commitRename() {
  const input = $('rename-input');
  const id = renaming;
  renaming = null;
  if (!input || !id) {
    return;
  }
  const name = input.value.trim().slice(0, 60);
  const l = lists.find((x) => `list:${x.id}` === id);
  if (l) {
    if (name && name !== l.name) {
      saveLists(lists.map((x) => (x.id === l.id ? { ...x, name } : x)));
      return;
    }
  } else {
    const names = store('gh.names', {});
    const fallback = BUCKETS.find((b) => b.id === id);
    if (!name || (fallback && name === fallback.name)) {
      delete names[id];
    } else {
      names[id] = name;
    }
    save('gh.names', names);
  }
  renderNav();
}

async function saveLists(next, keepOpen = false) {
  try {
    status = await window.gh.lists(next);
    lists = status.lists || [];
    if (!keepOpen) {
      editing = null;
    }
    if (!allBuckets().some((b) => b.id === bucket)) {
      bucket = allBuckets()[0] ? allBuckets()[0].id : 'turn';
      save('gh.bucket', bucket);
    }
    render();
  } catch (err) {
    const el = $('list-error');
    if (el) {
      el.textContent = stripIpc(err.message);
      el.hidden = false;
    }
  }
}

function submitList() {
  const name = $('list-name').value.trim();
  const query = $('list-query').value.trim();
  if (!name || !query) {
    $('list-error').textContent = 'Give the list a name and a search';
    $('list-error').hidden = false;
    return;
  }
  const id = editing.id || Date.now().toString(36);
  const next = lists.filter((l) => l.id !== id).concat([{ id, name, query }]);
  if (editing.id) {
    next.sort((a, b) => lists.findIndex((l) => l.id === a.id) - lists.findIndex((l) => l.id === b.id));
  }
  saveLists(next);
}

function chip(text, cls) {
  const c = document.createElement('span');
  c.className = `chip${cls ? ` ${cls}` : ''}`;
  c.textContent = text;
  return c;
}

function chipsFor(r) {
  const out = [];
  const changed = new Set();
  if (r.unread && r.changes) {
    for (const c of r.changes) {
      out.push(chip(c.text, `new ${c.tone || ''}`));
      changed.add(c.kind);
    }
  }
  if (r.turn === 'mine' && WHY[r.why]) {
    out.push(chip(WHY[r.why], 'me'));
  }
  if (r.kind === 'issue') {
    out.push(chip('issue'));
  }
  for (const l of (r.labels || []).slice(0, 3)) {
    const c = chip(l.name, 'label');
    if (/^[0-9a-f]{6}$/i.test(l.color)) {
      c.style.setProperty('--lc', `#${l.color}`);
    }
    out.push(c);
  }
  if (r.kind === 'issue') {
    if (r.comments > 0) {
      out.push(chip(`${r.comments} comment${r.comments === 1 ? '' : 's'}`));
    }
    return out;
  }
  if (r.merged) {
    out.push(chip('merged', 'ok'));
    return out;
  }
  if (r.draft) {
    out.push(chip('draft'));
  }
  if (r.ci === 'PENDING' || r.ci === 'EXPECTED') {
    out.push(chip('CI running', 'warn'));
  } else if ((r.ci === 'FAILURE' || r.ci === 'ERROR') && !changed.has('ci')) {
    out.push(chip('CI failing', 'err'));
  } else if (r.ci === 'SUCCESS' && !changed.has('ci')) {
    out.push(chip('CI ok', 'ok'));
  }
  if (r.mergeable === 'CONFLICTING' && !changed.has('conflicts')) {
    out.push(chip('conflicts', 'warn'));
  }
  if (r.decision === 'CHANGES_REQUESTED') {
    out.push(chip('changes requested', 'err'));
  } else if (r.decision === 'APPROVED') {
    out.push(chip('approved', 'ok'));
  }
  if (!r.flags.author && r.myReview && MY_REVIEW[r.myReview]) {
    out.push(chip(MY_REVIEW[r.myReview][0], MY_REVIEW[r.myReview][1]));
  }
  if (r.comments > 0) {
    out.push(chip(`${r.comments} comment${r.comments === 1 ? '' : 's'}`));
  }
  return out;
}

function meFlags(r) {
  const f = r.flags;
  const parts = [];
  if (f.author) {
    parts.push('mine');
  }
  if (f.assignee || f.issues) {
    parts.push('assignee');
  }
  if (f.requested) {
    parts.push('review requested');
  }
  if (f.reviewed && !f.requested) {
    parts.push('reviewed');
  }
  if (f.commented && !f.reviewed) {
    parts.push('commented');
  }
  return parts.join(', ');
}

function renderList() {
  const list = visible();
  const frag = document.createDocumentFragment();
  for (const r of list) {
    const el = document.createElement('div');
    el.className = `row${r.unread ? ' unread' : ''}${r.draft ? ' draft' : ''}`;
    el.dataset.key = r.key;
    el.dataset.url = r.url;
    el.innerHTML = '<div class="body"><div class="line1"><span class="title"></span><span class="chips"></span></div>'
      + '<div class="line2"><span class="repo"></span><span class="sep"></span><span class="author"></span><span class="sep"></span><span class="me"></span></div></div>'
      + '<div class="right"><span class="when"></span><button class="tool small mark" title="Mark as read">'
      + '<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></button></div>';
    el.querySelector('.title').textContent = r.title;
    el.querySelector('.chips').replaceChildren(...chipsFor(r));
    el.querySelector('.repo').textContent = `${r.repo}#${r.number}`;
    el.querySelector('.author').textContent = r.kind === 'issue' ? r.author : `${r.author} -> ${r.base}`;
    el.querySelector('.me').textContent = meFlags(r);
    el.querySelector('.when').textContent = ago(r.updated_at);
    el.querySelector('.when').title = `${r.merged ? 'merged' : 'updated'} ${new Date(r.updated_at).toLocaleString()}, opened ${new Date(r.created_at).toLocaleString()}`
      + (r.kind === 'issue' ? '' : `, +${r.additions} -${r.deletions} in ${r.changed_files} files`);
    frag.appendChild(el);
  }
  $('list').replaceChildren(frag);
  $('empty').hidden = list.length > 0;
  const b = currentBucket();
  const unread = list.filter((r) => r.unread).length;
  const hidden = excludes.length && !query ? rows.filter((r) => b.filter(r) && excluded(r)).length : 0;
  $('caption').textContent = `${b.name}: ${list.length}${unread ? `, ${unread} unread` : ''}${hidden ? ` (${hidden} filtered)` : ''}`;
}

function renderExcludes() {
  const frag = document.createDocumentFragment();
  for (const k of excludes) {
    const c = chip(k, 'kw');
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'kw-remove';
    x.title = `Stop hiding "${k}"`;
    x.dataset.kw = k;
    x.innerHTML = '<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
    c.appendChild(x);
    frag.appendChild(c);
  }
  $('exclude-list').replaceChildren(frag);
}

function setExcludes(list) {
  excludes = [...new Set(list.map((k) => String(k).trim().toLowerCase()).filter(Boolean))];
  save('gh.exclude', excludes);
  renderExcludes();
  render();
}

function renderStatus() {
  const st = $('status');
  $('who').textContent = status.username ? `@${status.username}` : '';
  if (status.error) {
    st.textContent = status.error;
    st.classList.add('error');
    return;
  }
  st.classList.remove('error');
  const checked = status.fetchedAt ? `checked ${ago(status.fetchedAt)} ago` : '';
  const limit = status.rateLimit ? `${status.rateLimit.remaining} API points left` : '';
  st.textContent = status.state === 'loading' ? 'refreshing...' : [checked, limit].filter(Boolean).join(', ');
}

function render() {
  const setup = status.state === 'signed-out';
  $('setup').hidden = !setup;
  $('app').hidden = setup;
  if (setup) {
    $('setup-user').textContent = `@${status.username || '?'}`;
    $('setup-repos').textContent = (status.repos || []).join(', ') || 'no repository yet';
    $('setup-error').hidden = !status.error;
    $('setup-error').textContent = status.error || '';
    $('keyring-warn').hidden = status.keyring !== false;
    return;
  }
  renderNav();
  renderList();
  renderStatus();
}

async function load() {
  const d = await window.gh.data();
  status = d.status;
  rows = d.rows;
  lists = status.lists || [];
  if (!allBuckets().some((b) => b.id === bucket)) {
    bucket = allBuckets()[0] ? allBuckets()[0].id : 'turn';
  }
  render();
}

function stripIpc(msg) {
  return msg.replace(/^Error invoking remote method '[^']+': Error: /, '');
}

$('nav').addEventListener('click', (ev) => {
  if (ev.target.id === 'rename-input') {
    return;
  }
  if (ev.target.closest('#list-form')) {
    if (ev.target.id === 'list-save') {
      submitList();
    } else if (ev.target.id === 'list-cancel') {
      editing = null;
      renderNav();
    } else if (ev.target.id === 'list-delete') {
      saveLists(lists.filter((l) => l.id !== editing.id));
    } else if (ev.target.id === 'list-up' || ev.target.id === 'list-down') {
      moveBucket(`list:${editing.id}`, ev.target.id === 'list-up' ? -1 : 1);
    }
    return;
  }
  const el = ev.target.closest('.bucket');
  if (!el) {
    return;
  }
  if (el.classList.contains('add-list')) {
    editing = { id: null };
    renderNav(false);
    return;
  }
  if (ev.target.closest('.edit')) {
    const l = lists.find((x) => `list:${x.id}` === el.dataset.id);
    editing = l ? { ...l } : null;
    renderNav(false);
    return;
  }
  bucket = el.dataset.id;
  save('gh.bucket', bucket);
  render();
});

function closeCtx() {
  const menu = document.getElementById('ctx-menu');
  if (menu) {
    menu.remove();
  }
}

function openCtx(x, y, b) {
  closeCtx();
  const menu = document.createElement('div');
  menu.id = 'ctx-menu';
  const hidden = hiddenCount();
  const divided = store('gh.dividers', []).includes(b.id);
  menu.innerHTML = (b.custom ? '<button type="button" data-act="edit">Edit</button>' : '')
    + '<button type="button" data-act="rename">Rename</button>'
    + '<button type="button" data-act="up">Move up</button>'
    + '<button type="button" data-act="down">Move down</button>'
    + `<button type="button" data-act="divider">${divided ? 'Remove divider' : 'Divider above'}</button>`
    + (b.custom ? '<button type="button" class="danger" data-act="delete">Delete</button>'
      : '<button type="button" data-act="hide">Hide</button>')
    + (hidden > 0 ? `<button type="button" data-act="unhide">Show ${hidden} hidden list${hidden === 1 ? '' : 's'}</button>` : '');
  menu.style.left = `${Math.min(x, window.innerWidth - 180)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - 190)}px`;
  menu.addEventListener('click', (ev) => {
    const act = ev.target.dataset.act;
    closeCtx();
    if (act === 'edit') {
      editing = { ...b.custom };
      renderNav(false);
    } else if (act === 'rename') {
      renaming = b.id;
      renderNav(false);
    } else if (act === 'delete') {
      saveLists(lists.filter((x) => x.id !== b.custom.id));
    } else if (act === 'up' || act === 'down') {
      moveBucket(b.id, act === 'up' ? -1 : 1);
    } else if (act === 'divider') {
      const list = store('gh.dividers', []);
      save('gh.dividers', divided ? list.filter((id) => id !== b.id) : list.concat([b.id]));
      renderNav();
    } else if (act === 'hide') {
      hideBucket(b.id);
    } else if (act === 'unhide') {
      save('gh.hidden', []);
      render();
    }
  });
  document.body.appendChild(menu);
}

window.addEventListener('pointerdown', (ev) => {
  if (!ev.target.closest('#ctx-menu')) {
    closeCtx();
  }
}, true);
window.addEventListener('blur', closeCtx);

$('nav').addEventListener('contextmenu', (ev) => {
  const el = ev.target.closest('.bucket');
  if (!el || el.classList.contains('add-list')) {
    return;
  }
  ev.preventDefault();
  const b = allBuckets().find((x) => x.id === el.dataset.id);
  if (b) {
    openCtx(ev.clientX, ev.clientY, b);
  }
});

let dragId = null;

function dropTarget(ev) {
  const el = ev.target.closest('.bucket');
  if (!el || !dragId || el.classList.contains('add-list') || el.dataset.id === dragId) {
    return null;
  }
  const box = el.getBoundingClientRect();
  return { el, after: ev.clientY > box.top + box.height / 2 };
}

function clearDrop() {
  for (const el of $('nav').querySelectorAll('.drop-before, .drop-after')) {
    el.classList.remove('drop-before', 'drop-after');
  }
}

$('nav').addEventListener('dragstart', (ev) => {
  const el = ev.target.closest('.bucket');
  if (!el || el.classList.contains('add-list')) {
    ev.preventDefault();
    return;
  }
  dragId = el.dataset.id;
  ev.dataTransfer.effectAllowed = 'move';
  ev.dataTransfer.setData('text/plain', dragId);
});
$('nav').addEventListener('dragover', (ev) => {
  const t = dropTarget(ev);
  clearDrop();
  if (t) {
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    t.el.classList.add(t.after ? 'drop-after' : 'drop-before');
  }
});
$('nav').addEventListener('dragleave', clearDrop);
$('nav').addEventListener('drop', (ev) => {
  const t = dropTarget(ev);
  clearDrop();
  if (!t) {
    return;
  }
  ev.preventDefault();
  const ids = allBuckets().map((b) => b.id).filter((id) => id !== dragId);
  let at = ids.indexOf(t.el.dataset.id);
  if (t.after) {
    at += 1;
  }
  ids.splice(at, 0, dragId);
  dragId = null;
  saveOrder(ids);
});
$('nav').addEventListener('dragend', () => {
  dragId = null;
  clearDrop();
});
$('nav').addEventListener('focusout', (ev) => {
  if (ev.target.id === 'rename-input' && renaming) {
    commitRename();
  }
});
$('nav').addEventListener('keydown', (ev) => {
  if (ev.target.id === 'rename-input') {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      commitRename();
    } else if (ev.key === 'Escape') {
      renaming = null;
      renderNav();
    }
    return;
  }
  if (!ev.target.closest('#list-form')) {
    return;
  }
  if (ev.key === 'Enter') {
    ev.preventDefault();
    submitList();
  } else if (ev.key === 'Escape') {
    editing = null;
    renderNav();
  }
});

$('list').addEventListener('click', async (ev) => {
  const row = ev.target.closest('.row');
  if (!row) {
    return;
  }
  const r = rows.find((x) => x.key === row.dataset.key);
  if (ev.target.closest('.mark')) {
    if (r) {
      r.unread = false;
      render();
      await window.gh.seen([r.key]);
    }
    return;
  }
  window.gh.open(row.dataset.url);
  if (r && r.unread) {
    r.unread = false;
    render();
    await window.gh.seen([r.key]);
  }
});

$('f-hide-drafts').checked = store('gh.hideDrafts', false);
$('f-hide-drafts').addEventListener('change', () => {
  save('gh.hideDrafts', $('f-hide-drafts').checked);
  renderList();
});

$('exclude-input').addEventListener('keydown', (ev) => {
  const input = $('exclude-input');
  if (ev.key === 'Enter') {
    ev.preventDefault();
    const added = input.value.split(',');
    input.value = '';
    setExcludes(excludes.concat(added));
  } else if (ev.key === 'Backspace' && input.value === '' && excludes.length) {
    setExcludes(excludes.slice(0, -1));
  }
});
$('exclude-list').addEventListener('click', (ev) => {
  const x = ev.target.closest('.kw-remove');
  if (x) {
    setExcludes(excludes.filter((k) => k !== x.dataset.kw));
  }
});

$('search').addEventListener('input', () => {
  query = $('search').value.trim();
  $('search-clear').hidden = !query;
  renderNav();
  renderList();
});
$('search-clear').addEventListener('click', () => {
  $('search').value = '';
  query = '';
  $('search-clear').hidden = true;
  renderNav();
  renderList();
});
$('read-all').addEventListener('click', async () => {
  const keys = visible().map((r) => r.key);
  for (const r of visible()) {
    r.unread = false;
  }
  render();
  await window.gh.seen(keys);
});
$('refresh').addEventListener('click', async () => {
  status = await window.gh.refresh();
  renderStatus();
});
$('open-site').addEventListener('click', () => {
  window.gh.open('https://github.com/pulls');
});
$('signout').addEventListener('click', async () => {
  status = await window.gh.logout();
  rows = [];
  render();
});

$('token-link').addEventListener('click', (ev) => {
  ev.preventDefault();
  window.gh.open('https://github.com/settings/personal-access-tokens');
});

$('signin-btn').addEventListener('click', async () => {
  const token = $('token').value.trim();
  if (!token) {
    return;
  }
  $('signin-btn').disabled = true;
  $('setup-error').hidden = true;
  try {
    status = await window.gh.login(token);
    $('token').value = '';
    render();
  } catch (err) {
    $('setup-error').textContent = stripIpc(err.message);
    $('setup-error').hidden = false;
  } finally {
    $('signin-btn').disabled = false;
  }
});

$('token').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    $('signin-btn').click();
  }
});

window.gh.onEvent((ev) => {
  if (ev.type === 'status') {
    status = ev.status;
    lists = status.lists || lists;
    if (!$('setup').hidden || status.state === 'signed-out' || status.error) {
      render();
    } else {
      renderStatus();
    }
  } else if (ev.type === 'data') {
    load();
  }
});

window.addEventListener('keydown', (ev) => {
  if (ev.target.tagName === 'INPUT') {
    if (ev.key === 'Escape') {
      if (ev.target === $('search')) {
        $('search-clear').click();
      } else {
        ev.target.value = '';
      }
      ev.target.blur();
    }
    return;
  }
  if (ev.key === '/') {
    ev.preventDefault();
    $('search').focus();
  }
});

const NAV_MIN = 160;
const NAV_MAX = 480;

function applyNavWidth() {
  const w = Math.min(NAV_MAX, Math.max(NAV_MIN, Number(store('gh.navWidth', 232)) || 232));
  $('app').style.setProperty('--nav-w', `${w}px`);
}

applyNavWidth();

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
    save('gh.navWidth', Math.round($('nav').getBoundingClientRect().width));
  };
  splitter.addEventListener('pointermove', move);
  splitter.addEventListener('pointerup', up);
  splitter.addEventListener('pointercancel', up);
});

$('splitter').addEventListener('dblclick', () => {
  save('gh.navWidth', 232);
  applyNavWidth();
});

const savedExcludes = store('gh.exclude', []);
excludes = Array.isArray(savedExcludes) ? savedExcludes.filter((k) => typeof k === 'string' && k) : [];
renderExcludes();

bucket = store('gh.bucket', 'turn');
load();
