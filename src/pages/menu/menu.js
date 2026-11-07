'use strict';

const ICONS = {
  add: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
  enabled: 'M13 3h-2v10h2V3zm4.83 2.17l-1.42 1.42A6.92 6.92 0 0 1 19 12a7 7 0 1 1-11.41-5.41L6.17 5.17A9 9 0 1 0 21 12c0-2.74-1.23-5.18-3.17-6.83z',
  divider: 'M3 11h18v2H3z',
  props: 'M19.4 13a7.9 7.9 0 0 0 .1-1 7.9 7.9 0 0 0-.1-1l2.1-1.6a.5.5 0 0 0 .1-.6l-2-3.5a.5.5 0 0 0-.6-.2l-2.5 1a7.3 7.3 0 0 0-1.7-1l-.4-2.6a.5.5 0 0 0-.5-.5h-4a.5.5 0 0 0-.5.5l-.4 2.6a7.3 7.3 0 0 0-1.7 1l-2.5-1a.5.5 0 0 0-.6.2l-2 3.5a.5.5 0 0 0 .1.6L4.6 11a7.9 7.9 0 0 0-.1 1 7.9 7.9 0 0 0 .1 1l-2.1 1.6a.5.5 0 0 0-.1.6l2 3.5a.5.5 0 0 0 .6.2l2.5-1a7.3 7.3 0 0 0 1.7 1l.4 2.6a.5.5 0 0 0 .5.5h4a.5.5 0 0 0 .5-.5l.4-2.6a7.3 7.3 0 0 0 1.7-1l2.5 1a.5.5 0 0 0 .6-.2l2-3.5a.5.5 0 0 0-.1-.6L19.4 13zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z',
  launch: 'M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z',
  notifications: 'M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6V11c0-3.07-1.63-5.64-4.5-6.32V4a1.5 1.5 0 0 0-3 0v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z',
  sounds: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
  reload: 'M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
  settings: 'M19.4 13a7.9 7.9 0 0 0 .1-1 7.9 7.9 0 0 0-.1-1l2.1-1.6a.5.5 0 0 0 .1-.6l-2-3.5a.5.5 0 0 0-.6-.2l-2.5 1a7.3 7.3 0 0 0-1.7-1l-.4-2.6a.5.5 0 0 0-.5-.5h-4a.5.5 0 0 0-.5.5l-.4 2.6a7.3 7.3 0 0 0-1.7 1l-2.5-1a.5.5 0 0 0-.6.2l-2 3.5a.5.5 0 0 0 .1.6L4.6 11a7.9 7.9 0 0 0-.1 1 7.9 7.9 0 0 0 .1 1l-2.1 1.6a.5.5 0 0 0-.1.6l2 3.5a.5.5 0 0 0 .6.2l2.5-1a7.3 7.3 0 0 0 1.7 1l.4 2.6a.5.5 0 0 0 .5.5h4a.5.5 0 0 0 .5-.5l.4-2.6a7.3 7.3 0 0 0 1.7-1l2.5 1a.5.5 0 0 0 .6-.2l2-3.5a.5.5 0 0 0-.1-.6L19.4 13zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z',
  autostart: 'M13 3h-2v10h2V3zm4.83 2.17l-1.42 1.42A6.92 6.92 0 0 1 19 12a7 7 0 1 1-11.41-5.41L6.17 5.17A9 9 0 1 0 21 12c0-2.74-1.23-5.18-3.17-6.83z',
  downloads: 'M20 6h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2zm0 12H4V8h16v10z',
  export: 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z',
  import: 'M19 15h-4v6H9v-6H5l7-7 7 7zM5 4v2h14V4H5z',
  editor: 'M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z',
  quit: 'M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8v-2H4V5z',
};

const menuEl = document.getElementById('menu');
let menuFor = null;

function render(data) {
  menuFor = data.id;
  const head = document.createElement('div');
  head.className = 'head';
  if (data.header.color || data.header.icon) {
    const mini = document.createElement('span');
    mini.className = 'mini';
    mini.style.setProperty('--c', data.header.color);
    if (data.header.icon) {
      const img = document.createElement('img');
      img.alt = '';
      img.src = data.header.icon;
      mini.appendChild(img);
    } else {
      const letter = document.createElement('span');
      letter.textContent = data.header.name.trim().charAt(0).toUpperCase();
      mini.appendChild(letter);
    }
    head.appendChild(mini);
  }
  const name = document.createElement('span');
  name.textContent = data.header.name;
  head.appendChild(name);

  const frag = document.createDocumentFragment();
  frag.appendChild(head);
  data.items.forEach((item, i) => {
    if (item.sep || (i > 0 && item.type === 'action' && data.items[i - 1].type === 'toggle')) {
      const sep = document.createElement('div');
      sep.className = 'sep';
      frag.appendChild(sep);
    }
    const btn = document.createElement('button');
    btn.className = `item${item.checked ? ' on' : ''}`;
    btn.setAttribute('role', 'menuitem');
    btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[item.key] || ''}"/></svg>`
      + `<span class="label"></span>${item.sub ? '<span class="sub"></span>' : ''}${item.type === 'toggle' ? '<span class="switch"></span>' : ''}`;
    btn.querySelector('.label').textContent = item.label;
    if (item.sub) {
      btn.querySelector('.sub').textContent = item.sub;
      btn.title = item.sub;
    }
    btn.addEventListener('click', () => {
      window.menu.action(menuFor, item.key);
    });
    frag.appendChild(btn);
  });
  menuEl.replaceChildren(frag);
  const items = [...menuEl.querySelectorAll('.item')];
  const keep = data.focus ? items[data.items.findIndex((it) => it.key === data.focus)] : null;
  const first = keep || items[0];
  if (first) {
    first.focus();
  }
}

window.menu.onOpen(render);

window.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    window.menu.close();
  }
  const items = [...menuEl.querySelectorAll('.item')];
  const i = items.indexOf(document.activeElement);
  if (ev.key === 'ArrowDown' && items.length) {
    ev.preventDefault();
    items[(i + 1) % items.length].focus();
  } else if (ev.key === 'ArrowUp' && items.length) {
    ev.preventDefault();
    items[(i - 1 + items.length) % items.length].focus();
  }
});
window.addEventListener('contextmenu', (ev) => ev.preventDefault());
