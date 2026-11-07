'use strict';

const $ = (id) => document.getElementById(id);
let toastTimer = null;

function showError(msg) {
  $('error').textContent = msg;
  $('error').hidden = !msg;
}

function toast(msg) {
  clearTimeout(toastTimer);
  $('toast').textContent = msg;
  toastTimer = setTimeout(() => {
    $('toast').textContent = '';
  }, 3000);
}

function field(label, placeholder, name) {
  const row = document.createElement('label');
  row.className = 'row';
  const lbl = document.createElement('span');
  lbl.className = 'lbl';
  lbl.textContent = label;
  const input = document.createElement('input');
  input.type = 'text';
  input.name = name;
  input.placeholder = placeholder;
  input.spellcheck = false;
  input.maxLength = 200;
  row.append(lbl, input);
  return row;
}

function card(t) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.id = t.id;

  const tile = document.createElement('span');
  tile.className = 'tile';
  tile.style.setProperty('--c', t.color);
  if (t.icon) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = t.icon;
    tile.appendChild(img);
  } else {
    tile.textContent = t.name.charAt(0).toUpperCase();
  }

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = t.name;
  const count = document.createElement('span');
  count.className = 'count';
  name.appendChild(count);

  const desc = document.createElement('span');
  desc.className = 'desc';
  desc.textContent = t.description;

  const add = document.createElement('button');
  add.className = 'btn small add';
  add.textContent = 'Add';

  const form = document.createElement('div');
  form.className = 'form';
  if (t.inputs.length > 0) {
    if (t.id === 'custom') {
      form.appendChild(field('Name', 'optional', 'name'));
    }
    for (const f of t.inputs) {
      form.appendChild(field(f.label, f.placeholder, f.key));
    }
    const actions = document.createElement('div');
    actions.className = 'actions';
    const cancel = document.createElement('button');
    cancel.className = 'btn small';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => el.classList.remove('open'));
    const ok = document.createElement('button');
    ok.className = 'btn small primary';
    ok.textContent = 'Add';
    ok.addEventListener('click', () => submit(el, t));
    actions.append(cancel, ok);
    form.appendChild(actions);
    form.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        submit(el, t);
      }
    });
  }

  add.addEventListener('click', () => {
    if (t.inputs.length > 0) {
      el.classList.add('open');
      el.querySelector('input').focus();
    } else {
      submit(el, t);
    }
  });

  el.append(tile, name, desc, add, form);
  setCount(el, t.copies);
  return el;
}

function setCount(el, n) {
  el.querySelector('.count').textContent = n > 0 ? `in sidebar${n > 1 ? ` (${n})` : ''}` : '';
}

async function submit(el, t) {
  const input = {};
  for (const i of el.querySelectorAll('input')) {
    input[i.name] = i.value;
  }
  showError('');
  try {
    const r = await window.add.add(t.id, input);
    setCount(el, r.copies);
    el.classList.remove('open');
    for (const i of el.querySelectorAll('input')) {
      i.value = '';
    }
    toast(`${r.name} added`);
  } catch (err) {
    showError(err.message.replace(/^Error invoking remote method '[^']+': Error: /, ''));
  }
}

async function load() {
  const d = await window.add.get();
  if (!d) {
    window.add.close();
    return;
  }
  $('grid').replaceChildren(...d.templates.map(card));
}

$('close').addEventListener('click', () => window.add.close());

window.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    window.add.close();
  }
});

load();
