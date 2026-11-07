'use strict';

const HOLD_MS = 220;
const SLOP_PX = 6;

const list = document.getElementById('list');
let state = { services: [], activeId: null, badges: {}, sleeping: {} };
let pending = null;
let drag = null;

function makeItem(svc) {
  const el = document.createElement('button');
  el.className = 'svc';
  el.dataset.id = svc.id;
  el.innerHTML = '<span class="tile"></span><span class="badge"></span>';
  return el;
}

function updateItem(el, svc) {
  el.title = svc.name;
  el.classList.toggle('active', svc.id === state.activeId);
  el.classList.toggle('sleeping', Boolean(state.sleeping[svc.id]));
  el.classList.toggle('external', Boolean(svc.external));
  el.classList.toggle('disabled', svc.enabled === false);
  el.classList.toggle('divider', Boolean(svc.divider));
  el.title = svc.enabled === false ? `${svc.name} (disabled)` : svc.name;

  const tile = el.querySelector('.tile');
  tile.style.setProperty('--c', svc.color);
  if (svc.icon) {
    let img = tile.querySelector('img');
    if (!img) {
      tile.textContent = '';
      img = document.createElement('img');
      img.alt = '';
      tile.appendChild(img);
    }
    if (img.getAttribute('src') !== svc.icon) {
      img.src = svc.icon;
    }
  } else {
    let letter = tile.querySelector('.letter');
    if (!letter) {
      tile.textContent = '';
      letter = document.createElement('span');
      letter.className = 'letter';
      tile.appendChild(letter);
    }
    letter.textContent = svc.name.trim().charAt(0).toUpperCase();
  }

  const badge = el.querySelector('.badge');
  const n = state.badges[svc.id];
  badge.classList.toggle('dot', n === 'dot');
  badge.textContent = n === 'dot' ? '\u200b' : n > 0 ? String(n > 99 ? '99+' : n) : '';
}

function render() {
  const existing = new Map([...list.children].map((el) => [el.dataset.id, el]));
  const frag = document.createDocumentFragment();
  for (const svc of state.services) {
    const el = existing.get(svc.id) || makeItem(svc);
    updateItem(el, svc);
    frag.appendChild(el);
  }
  list.replaceChildren(frag);

  const active = state.services.find((s) => s.id === state.activeId);
  const title = active ? active.name : 'Appbox';
  document.getElementById('title').textContent = title;
  document.getElementById('app-version').textContent = state.version ? `Appbox ${state.version}` : '';
  document.title = active ? `${active.name} - Appbox` : 'Appbox';
}

function apply(next) {
  if (drag && drag.active) {
    pending = next;
    return;
  }
  state = next;
  render();
}

function clearDrag() {
  if (!drag) {
    return;
  }
  clearTimeout(drag.timer);
  for (const el of list.children) {
    el.style.transform = '';
  }
  drag.el.classList.remove('dragging');
  list.classList.remove('lifting');
  drag = null;
  if (pending) {
    const next = pending;
    pending = null;
    apply(next);
  }
}

function startDrag() {
  if (!drag) {
    return;
  }
  const items = [...list.children];
  drag.active = true;
  drag.from = items.indexOf(drag.el);
  drag.to = drag.from;
  drag.rect = drag.el.getBoundingClientRect();
  drag.others = items.filter((el) => el !== drag.el).map((el) => ({
    el,
    mid: el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2,
    index: items.indexOf(el),
  }));
  drag.step = drag.rect.height + parseFloat(getComputedStyle(list).rowGap || '0');
  drag.el.classList.add('dragging');
  list.classList.add('lifting');
}

function moveDrag(dy) {
  drag.el.style.transform = `translateY(${dy}px)`;
  const center = drag.rect.top + drag.rect.height / 2 + dy;
  let to = 0;
  for (const o of drag.others) {
    if (center > o.mid) {
      to++;
    }
  }
  if (to === drag.to) {
    return;
  }
  drag.to = to;
  for (const o of drag.others) {
    let shift = 0;
    if (o.index < drag.from && o.index >= to) {
      shift = drag.step;
    } else if (o.index > drag.from && o.index <= to) {
      shift = -drag.step;
    }
    o.el.style.transform = shift ? `translateY(${shift}px)` : '';
  }
}

function finishDrag() {
  const ids = state.services.map((s) => s.id);
  const [id] = ids.splice(drag.from, 1);
  ids.splice(drag.to, 0, id);
  const byId = new Map(state.services.map((s) => [s.id, s]));
  state.services = ids.map((i) => byId.get(i));
  clearDrag();
  render();
  window.appbox.reorder(ids);
}

list.addEventListener('pointerdown', (ev) => {
  const el = ev.target.closest('.svc');
  if (!el || ev.button !== 0 || drag) {
    return;
  }
  ev.preventDefault();
  el.setPointerCapture(ev.pointerId);
  drag = {
    el,
    id: el.dataset.id,
    startX: ev.clientX,
    startY: ev.clientY,
    active: false,
    cancelled: false,
    timer: setTimeout(startDrag, HOLD_MS),
  };
});

list.addEventListener('pointermove', (ev) => {
  if (!drag) {
    return;
  }
  const dy = ev.clientY - drag.startY;
  if (!drag.active) {
    if (Math.abs(dy) > SLOP_PX || Math.abs(ev.clientX - drag.startX) > SLOP_PX) {
      clearTimeout(drag.timer);
      startDrag();
    } else {
      return;
    }
  }
  moveDrag(dy);
});

list.addEventListener('pointerup', () => {
  if (!drag) {
    return;
  }
  if (drag.active) {
    finishDrag();
  } else {
    const { id, cancelled } = drag;
    clearDrag();
    if (!cancelled) {
      window.appbox.activate(id);
    }
  }
});

list.addEventListener('pointercancel', clearDrag);
list.addEventListener('lostpointercapture', () => {
  if (drag && !drag.active) {
    clearDrag();
  }
});

list.addEventListener('contextmenu', (ev) => {
  const el = ev.target.closest('.svc');
  if (el) {
    ev.preventDefault();
    window.appbox.menu(el.dataset.id, ev.clientX, ev.clientY);
  }
});

/* The service menu is a view layered over the apps; any press on the
 * sidebar closes it.
 */
window.addEventListener('pointerdown', () => window.appbox.menuClose(), true);

window.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && drag) {
    clearDrag();
  }
});

window.appbox.onUpdate(apply);

document.getElementById('add').addEventListener('click', (ev) => {
  ev.stopPropagation();
  window.appbox.addApps();
});

document.getElementById('config').addEventListener('click', (ev) => {
  ev.stopPropagation();
  const r = document.getElementById('config').getBoundingClientRect();
  window.appbox.settingsMenu(r.left, r.top);
});

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

window.appbox.onStatus((s) => {
  const text = document.getElementById('status-text');
  const right = document.getElementById('status-right');
  if (s.transfer) {
    text.textContent = s.transfer;
    text.classList.add('target');
  } else if (s.target) {
    text.textContent = s.target;
    text.classList.add('target');
  } else {
    text.textContent = s.loading ? `Loading ${hostOf(s.url) || s.name}...` : '';
    text.classList.remove('target');
  }
  document.getElementById('status-usage').textContent = s.usage || '';
  right.textContent = s.name ? `${s.name}${hostOf(s.url) ? ` \u00b7 ${hostOf(s.url)}` : ''}` : '';
});
window.appbox.list().then(apply);
