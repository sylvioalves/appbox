'use strict';

const $ = (id) => document.getElementById(id);
const error = $('error');
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/;
let type = 'web';

function showError(msg) {
  error.textContent = msg;
  error.hidden = !msg;
}

function syncSleepRow() {
  $('sleep-minutes-row').classList.toggle('off', !$('sleepEnabled').checked);
  $('sleepMinutes').disabled = !$('sleepEnabled').checked;
}

async function load() {
  const svc = await window.props.get();
  if (!svc) {
    window.props.close();
    return;
  }
  $('title').textContent = svc.name;
  document.title = `${svc.name} - properties`;
  const mini = $('mini');
  mini.style.setProperty('--c', svc.color);
  if (svc.icon) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = svc.icon;
    mini.appendChild(img);
  }

  $('enabled').checked = svc.enabled;
  $('name').value = svc.name;
  $('url').value = svc.url;
  $('color').value = svc.color;
  $('color-hex').textContent = svc.color;
  $('notifications').checked = svc.notifications;
  $('sounds').checked = svc.sounds;
  $('forceDark').checked = svc.forceDark;
  $('sleepEnabled').checked = svc.sleep.enabled;
  $('sleepMinutes').value = svc.sleep.minutes;
  $('userAgent').value = svc.userAgent || '';
  for (const g of document.querySelectorAll('[data-type]')) {
    g.hidden = g.dataset.type !== svc.type;
  }
  type = svc.type;
  $('gh-username').value = svc.username || '';
  $('gh-repos').value = (svc.repos || []).join(', ');
  $('links').value = svc.links === 'window' ? 'window' : 'external';
  $('startup').value = svc.startup === 'lazy' ? 'lazy' : 'load';
  $('zoom').value = Number(svc.zoom) || 0;
  syncSleepRow();
  $('name').focus();
}

$('color').addEventListener('input', () => {
  $('color-hex').textContent = $('color').value;
});
$('sleepEnabled').addEventListener('change', syncSleepRow);

$('save').addEventListener('click', () => {
  const url = $('url').value.trim();
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) {
      throw new Error('bad scheme');
    }
  } catch {
    showError('URL must start with http:// or https://');
    $('url').focus();
    return;
  }
  showError('');
  const patch = {
    enabled: $('enabled').checked,
    name: $('name').value.trim(),
    url,
    color: $('color').value,
    notifications: $('notifications').checked,
    sounds: $('sounds').checked,
    forceDark: $('forceDark').checked,
    sleep: { enabled: $('sleepEnabled').checked, minutes: Number($('sleepMinutes').value) },
    userAgent: $('userAgent').value.trim(),
    links: $('links').value,
    startup: $('startup').value,
    zoom: Number($('zoom').value),
  };
  if (type === 'github-tracker') {
    const repos = $('gh-repos').value.split(/[\s,]+/).filter(Boolean);
    if (repos.length === 0 || repos.some((r) => !REPO_RE.test(r))) {
      showError('Enter repositories as owner/name, separated by commas');
      $('gh-repos').focus();
      return;
    }
    patch.username = $('gh-username').value.trim();
    patch.repos = repos.join(', ');
  }
  window.props.save(patch);
});

$('cancel').addEventListener('click', () => window.props.close());
$('remove').addEventListener('click', () => window.props.remove());
$('forget-token').addEventListener('click', async () => {
  const ok = await window.props.forgetToken();
  showError(ok ? '' : 'No token stored for this app');
});

window.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    window.props.close();
  } else if (ev.key === 'Enter' && ev.target.tagName === 'INPUT' && ev.target.type !== 'checkbox') {
    $('save').click();
  }
});

load();
