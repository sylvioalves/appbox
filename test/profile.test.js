'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'appbox-profile-'));
process.env.HOME = path.join(root, 'home');
fs.mkdirSync(process.env.HOME);
for (const name of ['CONFIG', 'DATA', 'STATE', 'CACHE']) {
  process.env[`XDG_${name}_HOME`] = path.join(root, name.toLowerCase());
}
delete process.env.APPBOX_CONFIG;
const config = require('../src/main/config.js');
const profile = require('../src/main/profile.js');

const cache = path.join(process.env.XDG_CACHE_HOME, 'appbox');
const staging = path.join(cache, 'import-staging');
const sessions = path.join(config.paths.data, 'Partitions');
const passphrase = 'correct horse battery';
const encrypted = path.join(root, 'enc.appbox');
const plain = path.join(root, 'plain.tar.gz');

test.before(() => {
  config.addService({ id: 'teams', name: 'Teams', url: 'https://teams.cloud.microsoft/',
    launch: 'xdg-open https://t.example' });
  config.saveState({ bounds: { x: 1, y: 2 }, maximized: true, activeId: 'teams', secret: 'drop' });
  fs.writeFileSync(path.join(config.paths.state, 'mail-accounts.json'), '{"fake":true}\n');
  for (const f of ['teams/Cookies', 'teams/Cache/data', 'teams/stray.js', '.hidden/Cookies']) {
    fs.mkdirSync(path.dirname(path.join(sessions, f)), { recursive: true });
    fs.writeFileSync(path.join(sessions, f), f);
  }
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('exporting sessions needs a passphrase of eight characters', async () => {
  await assert.rejects(profile.exportProfile(encrypted, { sessions: true }), /passphrase/);
  await assert.rejects(profile.exportProfile(encrypted, { sessions: true, passphrase: 'short' }), /passphrase/);
  assert.equal(fs.existsSync(encrypted), false);
});

test('export with sessions writes an encrypted private file', async () => {
  const r = await profile.exportProfile(encrypted, { sessions: true, passphrase, version: '1.0.0' });
  assert.deepEqual(r, { file: encrypted, size: fs.statSync(encrypted).size, sessions: true, encrypted: true });
  assert.ok(r.size > 60);
  assert.equal(fs.statSync(encrypted).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(encrypted).subarray(0, 10).toString(), 'APPBOXENC1');
  assert.deepEqual(fs.readdirSync(cache).filter((n) => n.startsWith('export-')), []);
});

test('a wrong passphrase or a tampered file gives BADPASS', async () => {
  await assert.rejects(profile.stageImport(encrypted, 'wrong passphrase'), { code: 'BADPASS' });
  const bad = path.join(root, 'tampered.appbox');
  const bytes = fs.readFileSync(encrypted);
  bytes[45] ^= 0xff;
  fs.writeFileSync(bad, bytes);
  await assert.rejects(profile.stageImport(bad, passphrase), { code: 'BADPASS' });
  await assert.rejects(profile.stageImport(encrypted), { code: 'ENCRYPTED' });
  assert.equal(fs.existsSync(staging), false);
});

test('stageImport unpacks a vetted tree and keeps only the login stores', async () => {
  const r = await profile.stageImport(encrypted, passphrase);
  assert.equal(r.app, 'appbox');
  assert.equal(r.version, '1.0.0');
  assert.equal(r.sessions, true);
  assert.deepEqual(r.launch, ['Teams: xdg-open https://t.example']);
  assert.equal(profile.hasPendingImport(), false);

  const staged = (p) => fs.existsSync(path.join(staging, p));
  assert.equal(staged('config/services.json'), true);
  assert.equal(staged('sessions/teams/Cookies'), true);
  assert.equal(staged('sessions/teams/Cache'), false);
  assert.equal(staged('sessions/teams/stray.js'), false);
  assert.equal(staged('sessions/.hidden'), false);
  assert.equal(staged('state/mail-accounts.json'), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(staging, 'state', 'state.json'), 'utf8')),
    { bounds: { x: 1, y: 2 }, maximized: true, activeId: 'teams' });
});

test('commitImport records the staged tree and clearPendingImport drops it', () => {
  profile.commitImport();
  assert.equal(profile.hasPendingImport(), true);
  const pending = JSON.parse(fs.readFileSync(path.join(cache, 'pending-import.json'), 'utf8'));
  assert.equal(pending.manifest.app, 'appbox');
  assert.equal(pending.manifest.sessions, true);
  profile.clearPendingImport();
  assert.equal(profile.hasPendingImport(), false);
  assert.equal(fs.existsSync(staging), false);
  assert.throws(() => profile.commitImport(), /no staged profile/);
});

test('a plain export carries no secrets and applies on the next start', async () => {
  const r = await profile.exportProfile(plain, { version: '1.0.0' });
  assert.equal(r.encrypted, false);
  assert.equal(r.sessions, false);
  assert.deepEqual([...fs.readFileSync(plain).subarray(0, 2)], [0x1f, 0x8b]);

  const staged = await profile.stageImport(plain);
  assert.equal(staged.sessions, false);
  assert.equal(fs.existsSync(path.join(staging, 'state', 'mail-accounts.json')), false);
  profile.commitImport();
  const applied = profile.applyPendingImport();
  assert.deepEqual(applied.applied, ['config', 'state']);
  assert.equal(profile.hasPendingImport(), false);
  assert.deepEqual(Object.keys(config.loadState()).sort(), ['activeId', 'bounds', 'maximized']);
  assert.equal(config.load().services[0].id, 'teams');
  assert.equal(fs.statSync(config.paths.services).mode & 0o777, 0o600);
  assert.equal(profile.applyPendingImport(), null);
});
