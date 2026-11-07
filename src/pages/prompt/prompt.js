'use strict';

const $ = (id) => document.getElementById(id);
const MIN_LEN = 8;

let confirm = false;

function showError(msg) {
  $('error').textContent = msg;
  $('error').hidden = !msg;
}

function submit() {
  const value = $('pass').value;
  if (confirm && value.length < MIN_LEN) {
    showError(`Use at least ${MIN_LEN} characters`);
    $('pass').focus();
    return;
  }
  if (confirm && value !== $('repeat').value) {
    showError('The two entries differ');
    $('repeat').focus();
    return;
  }
  if (value === '') {
    showError('Enter the passphrase');
    $('pass').focus();
    return;
  }
  window.ask.submit(value);
}

async function load() {
  const spec = await window.ask.get();
  if (!spec) {
    window.ask.cancel();
    return;
  }
  confirm = Boolean(spec.confirm);
  document.title = spec.title;
  $('title').textContent = spec.title;
  $('message').textContent = spec.message;
  $('repeat-row').hidden = !confirm;
  $('pass').focus();
}

$('ok').addEventListener('click', submit);
$('cancel').addEventListener('click', () => window.ask.cancel());
window.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    window.ask.cancel();
  } else if (ev.key === 'Enter' && ev.target.tagName === 'INPUT') {
    submit();
  }
});

load();
