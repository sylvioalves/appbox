'use strict';

const $ = (id) => document.getElementById(id);

function showError(msg) {
  $('error').textContent = msg;
  $('error').hidden = !msg;
}

async function load() {
  const s = await window.settings.get();
  $('version').textContent = `Appbox ${s.version}`;
  $('autostart').checked = Boolean(s.autostart);
  $('showTray').checked = s.settings.showTray !== false;
  $('startHidden').checked = Boolean(s.settings.startHidden);
  $('useFavicons').checked = Boolean(s.settings.useFavicons);
  $('hardwareAcceleration').checked = s.settings.hardwareAcceleration !== false;
  $('theme').value = s.settings.theme || 'dark';
  $('downloadDir').value = s.downloadDir || '';
  $('spellcheck').value = (s.settings.spellcheckLanguages || []).join(', ');
  $('authHosts').value = (s.settings.authHosts || []).join('\n');
}

$('browse').addEventListener('click', async () => {
  const dir = await window.settings.pickDir($('downloadDir').value);
  if (dir) {
    $('downloadDir').value = dir;
  }
});
$('export').addEventListener('click', () => window.settings.exportProfile());
$('import').addEventListener('click', () => window.settings.importProfile());
$('editor').addEventListener('click', () => window.settings.openEditor());
$('reload').addEventListener('click', () => window.settings.reload());

$('save').addEventListener('click', async () => {
  const langs = $('spellcheck').value.split(/[,\s]+/).map((l) => l.trim()).filter(Boolean);
  if (langs.some((l) => !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(l))) {
    showError('Spellcheck languages look like en-US or pt-BR, separated by commas');
    return;
  }
  const hosts = $('authHosts').value.split(/\s+/).map((h) => h.trim().toLowerCase()).filter(Boolean);
  const badHost = hosts.find((h) => !/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h));
  if (badHost) {
    showError(`Not a host name: ${badHost}`);
    return;
  }
  showError('');
  try {
    await window.settings.save({
      showTray: $('showTray').checked,
      startHidden: $('startHidden').checked,
      useFavicons: $('useFavicons').checked,
      hardwareAcceleration: $('hardwareAcceleration').checked,
      theme: $('theme').value,
      downloadDir: $('downloadDir').value.trim(),
      spellcheckLanguages: langs,
      authHosts: hosts,
    }, $('autostart').checked);
    window.settings.close();
  } catch (err) {
    showError(err.message.replace(/^Error invoking remote method '[^']+': Error: /, ''));
  }
});

$('cancel').addEventListener('click', () => window.settings.close());

window.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    window.settings.close();
  } else if (ev.key === 'Enter' && ev.target.tagName === 'INPUT' && ev.target.type !== 'checkbox') {
    $('save').click();
  }
});

load();
