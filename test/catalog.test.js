'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'appbox-catalog-'));
process.env.HOME = path.join(root, 'home');
fs.mkdirSync(process.env.HOME);
for (const name of ['CONFIG', 'DATA', 'STATE', 'CACHE']) {
  process.env[`XDG_${name}_HOME`] = path.join(root, name.toLowerCase());
}
delete process.env.APPBOX_CONFIG;
const catalog = require('../src/main/catalog.js');
const config = require('../src/main/config.js');

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('list holds well-formed templates with unique ids', () => {
  const templates = catalog.list();
  assert.ok(templates.length >= 5);
  const ids = templates.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const t of templates) {
    assert.equal(config.ID_RE.test(t.id), true, t.id);
    assert.equal(typeof t.name, 'string');
    assert.equal(typeof t.description, 'string');
    if (t.url !== undefined) {
      assert.equal(config.isWebUrl(t.url), true, t.id);
    }
  }
  for (const id of ['teams', 'gmail', 'gh-tracker', 'custom']) {
    assert.ok(ids.includes(id), id);
  }
  assert.equal(catalog.find('custom').id, 'custom');
  assert.equal(catalog.find('nope'), null);
});

test('copies counts a template and its numbered copies only', () => {
  const services = ['teams', 'teams-2', 'teams-10', 'teamsx', 'teams-x', 'outlook'].map((id) => ({ id }));
  assert.equal(catalog.copies('teams', services), 3);
  assert.equal(catalog.copies('slack', services), 0);
});

test('parseRepos splits, validates, dedupes and caps the list', () => {
  assert.deepEqual(catalog.parseRepos('octo/one, Octo/Two octo/ONE\n octo/two'), ['octo/one', 'Octo/Two']);
  assert.deepEqual(catalog.parseRepos(''), []);
  assert.deepEqual(catalog.parseRepos(null), []);
  assert.throws(() => catalog.parseRepos('octo'), /owner\/name/);
  assert.throws(() => catalog.parseRepos('-octo/one'), /owner\/name/);
  const many = Array.from({ length: 21 }, (_, i) => `octo/r${i}`).join(' ');
  assert.throws(() => catalog.parseRepos(many), /At most 20/);
  assert.equal(catalog.parseRepos(many.split(' ').slice(0, 20).join(',')).length, 20);
});

test('build copies a fixed template and numbers the copies', () => {
  const first = catalog.build('teams', {}, []);
  assert.equal(first.id, 'teams');
  assert.equal(first.name, 'Teams');
  assert.equal(first.url, 'https://teams.cloud.microsoft/');
  assert.ok(first.hosts.length > 0);
  assert.equal(first.links, 'window');
  const copy = catalog.build('teams', {}, [{ id: 'teams' }, { id: 'teams-2' }]);
  assert.equal(copy.id, 'teams-3');
  assert.equal(copy.name, 'Teams (3)');
  assert.throws(() => catalog.build('nope', {}, []), /unknown app/);
  assert.equal(config.normalize({ services: [first] }).services[0].type, 'web');
});

test('build names a custom app after its host', () => {
  const svc = catalog.build('custom', { url: 'https://www.Example.com/app', name: '  Work  ' }, []);
  assert.equal(svc.id, 'example');
  assert.equal(svc.name, 'Work');
  assert.equal(svc.url, 'https://www.Example.com/app');
  assert.deepEqual(svc.hosts, ['www.example.com']);
  const unnamed = catalog.build('custom', { url: 'https://www.example.com/' }, [{ id: 'example' }]);
  assert.equal(unnamed.id, 'example-2');
  assert.equal(unnamed.name, 'example.com');
  assert.equal(catalog.build('custom', { url: 'https://constructor.example/' }, []).id, 'app');
  assert.equal(catalog.build('custom', { url: 'https://_.example.com/' }, []).id, 'app');
  assert.equal(catalog.build('custom', { url: 'https://x.io/', name: 'n'.repeat(80) }, []).name.length, 60);
  assert.throws(() => catalog.build('custom', { url: 'ftp://x.io/' }, []), /http:\/\/ or https:\/\//);
  assert.throws(() => catalog.build('custom', {}, []), /http:\/\/ or https:\/\//);
});

test('build validates the tracker inputs', () => {
  const svc = catalog.build('gh-tracker', { username: 'octocat', repos: 'octo/a octo/b' }, [{ id: 'gh-tracker' }]);
  assert.equal(svc.id, 'gh-tracker-2');
  assert.equal(svc.type, 'github-tracker');
  assert.equal(svc.username, 'octocat');
  assert.deepEqual(svc.repos, ['octo/a', 'octo/b']);
  assert.throws(() => catalog.build('gh-tracker', { username: 'bad name', repos: 'octo/a' }, []), /login name/);
  assert.throws(() => catalog.build('gh-tracker', { username: 'octocat', repos: '' }, []), /at least one/);
  const mm = catalog.build('mattermost', { url: 'https://chat.example.com/' }, []);
  assert.equal(mm.name, 'Mattermost');
  assert.deepEqual(mm.hosts, ['chat.example.com']);
});
