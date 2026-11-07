'use strict';

const fs = require('fs');
const path = require('path');
const { hostOf, isWebUrl } = require('./config');

const CATALOG = path.join(__dirname, 'catalog.json');
const USERNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/;
const NAME_MAX = 60;
const REPOS_MAX = 20;

let templates = null;

function list() {
  if (templates === null) {
    templates = JSON.parse(fs.readFileSync(CATALOG, 'utf8')).templates;
  }
  return templates;
}

function find(id) {
  return list().find((t) => t.id === id) || null;
}

/* Ids of the copies of one template: "teams", "teams-2", "teams-3". */
function copies(base, services) {
  const re = new RegExp(`^${base}(-\\d+)?$`);
  return services.filter((s) => re.test(s.id)).length;
}

/* Ids never collide with Object.prototype names, which index state
 * objects.
 */
function freeId(base, services) {
  const taken = new Set(services.map((s) => s.id));
  if (!taken.has(base) && !Object.hasOwn(Object.prototype, base)) {
    return base;
  }
  for (let n = 2; ; n++) {
    if (!taken.has(`${base}-${n}`)) {
      return `${base}-${n}`;
    }
  }
}

function slug(host) {
  const s = host.replace(/^www\./, '').split('.')[0].toLowerCase().replace(/[^a-z0-9-]/g, '');
  return s === '' || Object.hasOwn(Object.prototype, s) ? 'app' : s;
}

/* "owner/name" entries out of a comma or space separated list. */
function parseRepos(text) {
  const out = [];
  for (const r of String(text || '').split(/[\s,]+/)) {
    if (r === '') {
      continue;
    }
    if (!REPO_RE.test(r)) {
      throw new Error(`Enter repositories as owner/name: "${r}"`);
    }
    if (!out.some((x) => x.toLowerCase() === r.toLowerCase())) {
      out.push(r);
    }
  }
  if (out.length > REPOS_MAX) {
    throw new Error(`At most ${REPOS_MAX} repositories`);
  }
  return out;
}

/* A services.json entry for a template, with the values the template
 * asks for, named apart from the copies already present.
 */
function build(templateId, input, services) {
  const t = find(templateId);
  if (!t) {
    throw new Error('unknown app');
  }
  const values = {};
  for (const f of t.inputs || []) {
    values[f.key] = String((input && input[f.key]) || '').trim();
  }
  const svc = { id: '', name: t.name };
  for (const k of ['type', 'url', 'color', 'icon', 'hosts', 'permissions', 'links']) {
    if (k in t) {
      svc[k] = t[k];
    }
  }
  let base = t.id;
  if ('url' in values) {
    const value = values.url;
    if (!isWebUrl(value)) {
      throw new Error('Enter an address starting with http:// or https://');
    }
    svc.url = value;
    svc.hosts = [hostOf(value)];
    if (t.id === 'custom') {
      base = slug(hostOf(value));
      svc.name = String((input && input.name) || '').trim().slice(0, NAME_MAX) || hostOf(value).replace(/^www\./, '');
    }
  }
  if ('username' in values) {
    if (!USERNAME_RE.test(values.username)) {
      throw new Error('Enter a GitHub login name');
    }
    svc.username = values.username;
  }
  if ('repos' in values) {
    svc.repos = parseRepos(values.repos);
    if (svc.repos.length === 0) {
      throw new Error('Enter at least one repository as owner/name');
    }
  }
  svc.id = freeId(base, services);
  const n = copies(base, services) + 1;
  if (n > 1 && t.id !== 'custom') {
    svc.name = `${svc.name} (${n})`;
  }
  return svc;
}

module.exports = { list, find, build, copies, parseRepos };
