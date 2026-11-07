'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* The module creates its directories on load, so every path it sees
 * points into a scratch tree before it is required.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'appbox-config-'));
const home = path.join(root, 'home');
fs.mkdirSync(home);
process.env.HOME = home;
for (const name of ['CONFIG', 'DATA', 'STATE', 'CACHE']) {
  process.env[`XDG_${name}_HOME`] = path.join(root, name.toLowerCase());
}
delete process.env.APPBOX_CONFIG;
const config = require('../src/main/config.js');

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const web = (extra) => ({ id: 'svc', url: 'https://app.example.com/x', ...extra });
const one = (extra) => config.normalize({ services: [web(extra)] }).services[0];

test('paths stay inside the scratch tree', () => {
  for (const p of [config.paths.config, config.paths.state, config.paths.data, config.paths.services]) {
    assert.ok(p.startsWith(root), p);
  }
  assert.equal(config.APP_ID, 'io.github.sylvioalves.appbox');
});

test('load creates an empty private services file on first run', () => {
  const cfg = config.load();
  assert.deepEqual(cfg.services, []);
  assert.equal(cfg.settings.theme, 'dark');
  assert.equal(config.isFirstRun(), true);
  assert.equal(fs.statSync(config.paths.services).mode & 0o777, 0o600);
  assert.equal(fs.statSync(config.paths.config).mode & 0o777, 0o700);
});

test('normalize fills the defaults of a web service', () => {
  const svc = one({ name: ' My\u0000App ' });
  assert.equal(svc.type, 'web');
  assert.equal(svc.name, 'My App');
  assert.equal(svc.partition, 'svc');
  assert.deepEqual(svc.hosts, ['app.example.com']);
  assert.deepEqual(svc.permissions, ['notifications']);
  assert.equal(svc.links, 'external');
  assert.equal(svc.icon, null);
  assert.equal(svc.badgeRegex, null);
  assert.deepEqual(svc.sleep, { enabled: false, minutes: 15 });
});

test('normalize rejects reserved, malformed and duplicate ids', () => {
  for (const id of ['constructor', '__proto__', 'toString', '', 'a/b', '.dot', 'x'.repeat(65), 7]) {
    assert.throws(() => config.normalize({ services: [web({ id })] }), /invalid or duplicate id/);
  }
  assert.throws(() => config.normalize({ services: [web(), web()] }), /duplicate/);
  assert.throws(() => config.normalize({ services: [web({ url: 'file:///etc/passwd' })] }), /http or https/);
  assert.equal(config.ID_RE.test('ok_id.1-x'), true);
});

test('normalize keeps built-in types and drops unknown ones', () => {
  const cfg = config.normalize({ services: [web({ type: 'bogus' }), web({ id: 'g', type: 'github-tracker', links: 'window' })] });
  assert.equal(cfg.services.length, 1);
  assert.equal(cfg.services[0].id, 'g');
  assert.equal(cfg.services[0].links, 'external');
  assert.equal(one({ links: 'window' }).links, 'window');
});

test('normalize clamps and sanitizes the per-service fields', () => {
  const svc = one({
    color: 'red',
    partition: 'constructor',
    userAgent: ' UA\u00e9 1.0 ',
    username: 'bad name',
    hosts: ['Example.COM', 'example.com', '*.ok.org', 'no spaces', 'x'],
    permissions: ['media', 'camera'],
    zoom: 9,
    sleep: { enabled: 1, minutes: 99999 },
    launch: '  ',
    icon: 'javascript:alert(1)',
  });
  assert.equal(svc.color, '#6c7086');
  assert.equal(svc.partition, 'constructor');
  assert.equal(svc.userAgent, 'UA 1.0');
  assert.equal(svc.username, '');
  assert.deepEqual(svc.hosts, ['example.com', '*.ok.org']);
  assert.deepEqual(svc.permissions, ['media']);
  assert.equal(svc.zoom, 5);
  assert.deepEqual(svc.sleep, { enabled: true, minutes: 1440 });
  assert.equal(svc.launch, null);
  assert.equal(svc.icon, null);
  assert.equal(one({ zoom: -8 }).zoom, -3);
  assert.equal(one({ zoom: 'x' }).zoom, 0);
});

test('normalize caps repos at twenty and drops malformed ones', () => {
  const repos = Array.from({ length: 25 }, (_, i) => `owner/repo${i}`);
  assert.equal(one({ repos }).repos.length, 20);
  assert.deepEqual(one({ repos: ['owner/ok', 'no-slash', '-bad/x', 'a/b/c', 42] }).repos, ['owner/ok']);
  assert.deepEqual(one({ repos: 'owner/ok' }).repos, []);
});

test('normalizeLists keeps ids off the prototype and caps the list', () => {
  const lists = config.normalizeLists([
    { id: 'constructor', name: 'A', query: 'is:open' },
    { id: '__proto__', name: 'B', query: 'is:open' },
    { id: 'mine', name: ' Mine\u2028now ', query: 'author:me' },
    { id: 'mine', name: 'Dup', query: 'x' },
    { id: 'Upper', name: 'C', query: 'x' },
    { name: 'no query' },
    { id: 'q', name: '', query: 'x' },
    null,
    'string',
  ]);
  assert.deepEqual(lists, [
    { id: 'l0', name: 'A', query: 'is:open' },
    { id: 'l1', name: 'B', query: 'is:open' },
    { id: 'mine', name: 'Mine now', query: 'author:me' },
    { id: 'l4', name: 'C', query: 'x' },
  ]);
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, name: 'n', query: 'q' }));
  assert.equal(config.normalizeLists(many).length, 20);
  assert.equal(config.normalizeLists([{ id: 'a', name: 'x'.repeat(100), query: 'q' }])[0].name.length, 60);
  assert.deepEqual(config.normalizeLists('nope'), []);
});

/* badgeRegex and isIcon are reached through normalize, which is how
 * the app applies them.
 */
const badge = (src) => one({ badgeRegex: src }).badgeRegex;
const icon = (src) => one({ icon: src }).icon;

test('badge patterns are literal text around a single count group', () => {
  assert.equal(badge('\\((\\d+)\\)'), '\\((\\d+)\\)');
  assert.equal(badge('(\\d+)'), '(\\d+)');
  assert.equal(badge('\\d unread: (\\d+)'), '\\d unread: (\\d+)');
  for (const bad of ['', 'no group', '(\\d+) (\\d+)', 'a+(\\d+)', 'a|b(\\d+)', '[0-9](\\d+)', '(x)(\\d+)',
    '\\u0041(\\d+)', `${'a'.repeat(100)}(\\d+)`, 42]) {
    assert.equal(badge(bad), null, String(bad));
  }
  const t0 = process.hrtime.bigint();
  assert.equal(badge('a*a*a*a*a*a*a*a*a*a*a*a*(b)'), null);
  assert.ok(Number(process.hrtime.bigint() - t0) < 50e6);
});

test('icons are bundled names, absolute paths, https addresses or inline images', () => {
  for (const ok of ['teams.svg', '/usr/share/icons/x.png', 'https://example.com/i.png',
    'data:image/png;base64,iVBORw0KGgo=']) {
    assert.equal(icon(ok), ok);
  }
  for (const bad of ['', 'http://example.com/i.png', 'javascript:alert(1)', 'file:///etc/x', 'a\nb',
    'data:text/html;base64,PGI+', `data:image/png;base64,${'A'.repeat(513 * 1024)}`, 'x'.repeat(2049), 3]) {
    assert.equal(icon(bad), null, String(bad).slice(0, 30));
  }
});

test('isDownloadDir refuses home, hidden and configuration trees', () => {
  assert.equal(config.isDownloadDir(path.join(home, 'Downloads')), true);
  assert.equal(config.isDownloadDir(path.join(root, 'elsewhere')), true);
  for (const bad of [home, path.dirname(home), '/', 'Downloads', '', null,
    path.join(home, '.config', 'x'), path.join(home, '.ssh'), path.join(root, '.hidden', 'd'),
    process.env.XDG_CONFIG_HOME, path.join(process.env.XDG_DATA_HOME, 'sub'), process.env.XDG_STATE_HOME,
    process.env.XDG_CACHE_HOME, `${path.join(home, 'Downloads')}/../`]) {
    assert.equal(config.isDownloadDir(bad), false, String(bad));
  }
});

test('settings are normalized with safe fallbacks', () => {
  const s = config.normalize({
    settings: {
      theme: 'neon',
      sidebarWidth: 999,
      downloadDir: home,
      spellcheckLanguages: ['en-US', 'bad lang', 'pt', 42].concat(Array(10).fill('de-DE')),
      startHidden: 0,
      showTray: 'yes',
      authHosts: ['Accounts.Google.com', 'nope'],
    },
  }).settings;
  assert.equal(s.theme, 'dark');
  assert.equal(s.sidebarWidth, 200);
  assert.equal(s.downloadDir, '');
  assert.equal(s.spellcheckLanguages.length, 10);
  assert.equal(s.startHidden, false);
  assert.equal(s.showTray, true);
  assert.deepEqual(s.authHosts, ['accounts.google.com']);
  assert.equal(config.normalize({ settings: { sidebarWidth: 1 } }).settings.sidebarWidth, 40);
});

test('services and state round-trip through the scratch files', () => {
  let cfg = config.addService({ id: 'one', url: 'https://one.example.com/' });
  cfg = config.addService({ id: 'two', url: 'https://two.example.com/' });
  assert.deepEqual(cfg.services.map((s) => s.id), ['one', 'two']);
  assert.throws(() => config.addService({ id: 'one', url: 'https://x.example.com/' }), /exists/);
  assert.throws(() => config.addService({ id: 'constructor', url: 'https://x.example.com/' }), /invalid/);
  assert.equal(JSON.parse(fs.readFileSync(config.paths.services, 'utf8')).services.length, 2);

  cfg = config.saveOrder(['two', 'ghost']);
  assert.deepEqual(cfg.services.map((s) => s.id), ['two', 'one']);
  cfg = config.patchService('one', { name: 'Renamed', zoom: 2 });
  assert.equal(cfg.services[1].name, 'Renamed');
  assert.equal(cfg.services[1].zoom, 2);
  cfg = config.patchSettings({ theme: 'light' });
  assert.equal(cfg.settings.theme, 'light');
  cfg = config.removeService('two');
  assert.deepEqual(cfg.services.map((s) => s.id), ['one']);

  config.saveState({ activeId: 'one' });
  assert.deepEqual(config.loadState(), { activeId: 'one' });
  assert.equal(fs.statSync(config.paths.stateFile).mode & 0o777, 0o600);
});

test('small helpers', () => {
  assert.equal(config.hostOf('https://Www.Example.com:8443/p'), 'www.example.com');
  assert.equal(config.hostOf('not a url'), '');
  assert.equal(config.isWebUrl('http://x.org'), true);
  assert.equal(config.isWebUrl('ftp://x.org'), false);
  assert.equal(config.oneLine('  a\tb\r\nc  ', 3), 'a b');
  assert.deepEqual(config.hostList(['A.com', 'a.com', 'x'.repeat(254)]), ['a.com']);
  assert.equal(config.downloadDir({ downloadDir: path.join(home, 'Downloads') }), path.join(home, 'Downloads'));
  assert.ok(config.downloadDir({ downloadDir: home }).startsWith(home));
});
