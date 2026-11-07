'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_ID = 'io.github.sylvioalves.appbox';
const FLATPAK = fs.existsSync('/.flatpak-info');
const home = os.homedir();
const xdg = (name, fallback) => process.env[name] || path.join(home, fallback);

const paths = {
  config: path.join(xdg('XDG_CONFIG_HOME', '.config'), 'appbox'),
  state: path.join(xdg('XDG_STATE_HOME', '.local/state'), 'appbox'),
  data: path.join(xdg('XDG_DATA_HOME', '.local/share'), 'appbox'),
  autostart: path.join(xdg('XDG_CONFIG_HOME', '.config'), 'autostart', `${APP_ID}.desktop`),
};
paths.services = process.env.APPBOX_CONFIG || path.join(paths.config, 'services.json');
paths.stateFile = path.join(paths.state, 'state.json');

/* An autostart entry written under the former desktop file name takes
 * the new one on the first start after the rename.
 */
const oldAutostart = path.join(path.dirname(paths.autostart), 'appbox.desktop');
try {
  if (fs.existsSync(oldAutostart) && !fs.existsSync(paths.autostart)) {
    fs.renameSync(oldAutostart, paths.autostart);
  }
} catch (err) {
  console.error(`migrate ${oldAutostart}: ${err.message}`);
}

/* Directories created under the app's former name move to the new one
 * on the first start after the rename.
 */
for (const dir of [paths.config, paths.state, paths.data]) {
  const old = path.join(path.dirname(dir), 'sbox');
  try {
    if (fs.existsSync(old) && !fs.existsSync(dir)) {
      fs.renameSync(old, dir);
    }
  } catch (err) {
    console.error(`migrate ${old}: ${err.message}`);
  }
}

/* App data stays private to the user whatever the umask: logins and
 * app state live in these directories.
 */
for (const dir of [paths.config, paths.state, paths.data, path.join(xdg('XDG_CACHE_HOME', '.cache'), 'appbox')]) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  } catch (err) {
    console.error(`private ${dir}: ${err.message}`);
  }
}

const DEFAULT_SETTINGS = {
  downloadDir: '',
  theme: 'dark',
  sidebarWidth: 56,
  startHidden: true,
  showTray: true,
  useFavicons: true,
  hardwareAcceleration: true,
  spellcheckLanguages: ['en-US', 'pt-BR'],
  authHosts: [
    'login.microsoftonline.com',
    'login.microsoft.com',
    'login.live.com',
    'login.windows.net',
    'device.login.microsoftonline.com',
    'autologon.microsoftazuread-sso.com',
    'accounts.google.com',
    'myaccount.google.com',
    'accounts.youtube.com',
  ],
};

const DEFAULT_SERVICE = {
  type: 'web',
  name: '',
  enabled: true,
  color: '#6c7086',
  icon: null,
  hosts: [],
  permissions: ['notifications'],
  notifications: true,
  sounds: true,
  launch: null,
  divider: false,
  forceDark: false,
  sleep: { enabled: false, minutes: 15 },
  userAgent: null,
  links: 'external',
  startup: 'load',
  repos: [],
  lists: [],
  zoom: 0,
  badge: 'title',
  badgeRegex: null,
};

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/;
const USERNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
/* Service ids and partitions name files and directories. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const THEMES = ['dark', 'light', 'system'];
const LANG_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
/* Types whose view is an app page, never a web site. */
const BUILTIN_TYPES = ['github-tracker'];
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const oneLine = (v, max) => String(v).replace(CONTROL_RE, ' ').trim().slice(0, max);
const HOST_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const PERMISSIONS = ['notifications', 'media', 'display-capture', 'clipboard-read', 'clipboard-sanitized-write',
  'fullscreen', 'speaker-selection', 'idle-detection', 'geolocation', 'midi', 'pointerLock', 'window-management'];
/* Permissions a service page gets only after the user agreed once. */
const ASKED_PERMISSIONS = ['media', 'display-capture', 'clipboard-read', 'geolocation'];

function isHost(h) {
  return typeof h === 'string' && h.length <= 253 && HOST_RE.test(h);
}

function hostList(list) {
  return [...new Set((Array.isArray(list) ? list : []).map((h) => String(h).trim().toLowerCase()).filter(isHost))];
}

/* Downloads never land where a dropped file changes the user's setup:
 * not the home directory itself, nothing under a hidden directory and
 * none of the configuration trees.
 */
function isDownloadDir(dir) {
  if (typeof dir !== 'string' || dir === '' || !path.isAbsolute(dir)) {
    return false;
  }
  const d = path.resolve(dir);
  if (d === home || d === path.dirname(home) || d === '/') {
    return false;
  }
  const bad = [path.join(home, '.config'), path.join(home, '.local'), path.join(home, '.ssh'),
    path.join(home, '.gnupg'), path.join(home, '.cache'), xdg('XDG_CONFIG_HOME', '.config'),
    xdg('XDG_DATA_HOME', '.local/share'), xdg('XDG_STATE_HOME', '.local/state'), xdg('XDG_CACHE_HOME', '.cache')];
  for (const b of bad.map((x) => path.resolve(x))) {
    if (d === b || d.startsWith(`${b}${path.sep}`)) {
      return false;
    }
  }
  return !d.split(path.sep).some((part) => part.startsWith('.'));
}

/* A badge pattern runs on page titles: no quantified groups, which is
 * where catastrophic backtracking comes from.
 */
/* An icon is a bundled file name, an absolute path, an https address
 * or an inline image.
 */
function isIcon(v) {
  if (typeof v !== 'string' || v === '' || /[\u0000-\u001f\u007f-\u009f]/.test(v)) {
    return false;
  }
  if (v.startsWith('data:')) {
    return /^data:image\/[a-z+.-]+;base64,[A-Za-z0-9+/=]+$/.test(v) && v.length <= 512 * 1024;
  }
  return v.length <= 2048 && (/^https:\/\//.test(v) || !/^[a-z][a-z0-9+.-]*:/i.test(v));
}

const LIST_ID_RE = /^[a-z0-9]{1,16}$/;
const LISTS_MAX = 20;
const REPOS_MAX = 20;

/* Saved searches of a tracker: a name and a GitHub search string. */
function normalizeLists(raw) {
  const out = [];
  const ids = new Set();
  (Array.isArray(raw) ? raw : []).forEach((l, i) => {
    if (!l || typeof l !== 'object' || out.length >= LISTS_MAX) {
      return;
    }
    const name = typeof l.name === 'string' ? oneLine(l.name, 60) : '';
    const query = typeof l.query === 'string' ? oneLine(l.query, 200) : '';
    const id = typeof l.id === 'string' && LIST_ID_RE.test(l.id) && !Object.hasOwn(Object.prototype, l.id)
      ? l.id : `l${i}`;
    if (!name || !query || ids.has(id)) {
      return;
    }
    ids.add(id);
    out.push({ id, name, query });
  });
  return out;
}

/* Literal text around exactly one (\d+) group: no other group,
 * quantifier, class or alternation, so matching stays linear.
 */
const BADGE_GROUP = '(\\d+)';
const BADGE_TEXT_RE = /^(?:\\[^0-9A-Za-z]|\\[sSdDwWbBtnrfv]|[^\\()[\]{}*+?|])*$/;

function badgeRegex(src) {
  if (typeof src !== 'string' || src === '' || src.length > 100) {
    return null;
  }
  const at = src.indexOf(BADGE_GROUP);
  if (at === -1 || src.indexOf(BADGE_GROUP, at + 1) !== -1) {
    return null;
  }
  const text = src.slice(0, at) + src.slice(at + BADGE_GROUP.length);
  if (!BADGE_TEXT_RE.test(text)) {
    return null;
  }
  try {
    new RegExp(src);
    return src;
  } catch {
    return null;
  }
}

function isWebUrl(url) {
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      return fallback;
    }
    throw err;
  }
}

/* Write next to the real file and rename, so a symlinked config keeps
 * pointing at its target and a crash never leaves a half-written file.
 */
function writeJsonAtomic(file, obj) {
  let real = file;
  try {
    real = fs.realpathSync(file);
  } catch {
    /* new file */
  }
  fs.mkdirSync(path.dirname(real), { recursive: true });
  const tmp = `${real}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, real);
}

function normalizeSettings(raw) {
  const settings = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  settings.authHosts = hostList(settings.authHosts);
  settings.downloadDir = isDownloadDir(settings.downloadDir) ? settings.downloadDir : '';
  settings.theme = THEMES.includes(settings.theme) ? settings.theme : DEFAULT_SETTINGS.theme;
  settings.sidebarWidth = Number.isInteger(settings.sidebarWidth)
    ? Math.min(200, Math.max(40, settings.sidebarWidth)) : DEFAULT_SETTINGS.sidebarWidth;
  settings.spellcheckLanguages = (Array.isArray(settings.spellcheckLanguages) ? settings.spellcheckLanguages : [])
    .filter((l) => typeof l === 'string' && LANG_RE.test(l)).slice(0, 10);
  for (const k of ['startHidden', 'showTray', 'useFavicons', 'hardwareAcceleration']) {
    settings[k] = Boolean(settings[k]);
  }
  return settings;
}

function normalize(raw) {
  const settings = normalizeSettings(raw.settings);
  const seen = new Set();
  const services = (raw.services || []).map((s) => {
    if (typeof s.id !== 'string' || !ID_RE.test(s.id) || Object.hasOwn(Object.prototype, s.id) || seen.has(s.id)) {
      throw new Error(`services.json: missing, invalid or duplicate id "${s.id}"`);
    }
    seen.add(s.id);
    if (!isWebUrl(s.url)) {
      throw new Error(`services.json: "${s.id}" needs an http or https url`);
    }
    const svc = {
      ...DEFAULT_SERVICE,
      ...s,
      sleep: { ...DEFAULT_SERVICE.sleep, ...(s.sleep || {}) },
    };
    svc.url = new URL(s.url).href;
    svc.partition = typeof svc.partition === 'string' && ID_RE.test(svc.partition) ? svc.partition : svc.id;
    svc.name = oneLine(svc.name || svc.id, 200) || svc.id;
    svc.color = COLOR_RE.test(String(svc.color)) ? svc.color : DEFAULT_SERVICE.color;
    svc.icon = isIcon(svc.icon) ? svc.icon : null;
    svc.userAgent = typeof svc.userAgent === 'string' && svc.userAgent.trim()
      ? oneLine(svc.userAgent, 500).replace(/[^\x20-\x7e]/g, '') : null;
    svc.username = typeof svc.username === 'string' && USERNAME_RE.test(svc.username) ? svc.username : '';
    svc.hosts = hostList(svc.hosts);
    if (svc.hosts.length === 0) {
      svc.hosts = [hostOf(svc.url)];
    }
    svc.permissions = (Array.isArray(svc.permissions) ? svc.permissions : []).filter((x) => PERMISSIONS.includes(x));
    svc.repos = (Array.isArray(svc.repos) ? svc.repos : []).filter((x) => typeof x === 'string' && REPO_RE.test(x))
      .slice(0, REPOS_MAX);
    svc.lists = normalizeLists(svc.lists);
    svc.badgeRegex = badgeRegex(svc.badgeRegex);
    svc.launch = typeof svc.launch === 'string' && svc.launch.trim() ? oneLine(svc.launch, 1000) : null;
    svc.links = svc.links === 'window' && !BUILTIN_TYPES.includes(svc.type) ? 'window' : 'external';
    svc.sleep.enabled = Boolean(svc.sleep.enabled);
    svc.sleep.minutes = Math.min(1440, Math.max(1, parseInt(svc.sleep.minutes, 10) || 15));
    svc.zoom = Number.isFinite(svc.zoom) ? Math.max(-3, Math.min(5, svc.zoom)) : 0;
    return svc;
  }).filter((svc) => svc.type === 'web' || BUILTIN_TYPES.includes(svc.type));
  return { settings, services };
}

let firstRun = false;

function load() {
  let raw = readJson(paths.services, null);
  if (raw === null) {
    raw = { services: [] };
    writeJsonAtomic(paths.services, raw);
    firstRun = true;
  }
  return normalize(raw);
}

const isFirstRun = () => firstRun;

function addService(svc) {
  const raw = readJson(paths.services, { services: [] });
  if (raw.services.some((s) => s.id === svc.id)) {
    throw new Error(`services.json: id "${svc.id}" exists`);
  }
  raw.services.push(svc);
  const cfg = normalize(raw);
  writeJsonAtomic(paths.services, raw);
  return cfg;
}

function removeService(id) {
  const raw = readJson(paths.services, { services: [] });
  raw.services = raw.services.filter((s) => s.id !== id);
  writeJsonAtomic(paths.services, raw);
  return normalize(raw);
}

function saveOrder(ids) {
  const raw = readJson(paths.services, { services: [] });
  const byId = new Map(raw.services.map((s) => [s.id, s]));
  const ordered = ids.filter((id) => byId.has(id)).map((id) => byId.get(id));
  for (const s of raw.services) {
    if (!ids.includes(s.id)) {
      ordered.push(s);
    }
  }
  raw.services = ordered;
  writeJsonAtomic(paths.services, raw);
  return normalize(raw);
}

function patchService(id, patch) {
  const raw = readJson(paths.services, { services: [] });
  const svc = raw.services.find((s) => s.id === id);
  if (svc) {
    Object.assign(svc, patch);
    writeJsonAtomic(paths.services, raw);
  }
  return normalize(raw);
}

function patchSettings(patch) {
  const raw = readJson(paths.services, { services: [] });
  raw.settings = { ...(raw.settings || {}), ...patch };
  writeJsonAtomic(paths.services, raw);
  return normalize(raw);
}

/* Configured download folder, else the desktop's Downloads directory. */
function downloadDir(settings) {
  if (settings && isDownloadDir(settings.downloadDir)) {
    return settings.downloadDir;
  }
  try {
    const out = require('child_process').execFileSync('xdg-user-dir', ['DOWNLOAD'], { encoding: 'utf8' }).trim();
    if (out && out !== home) {
      return out;
    }
  } catch {
    /* no xdg-user-dir */
  }
  return path.join(home, 'Downloads');
}

const loadState = () => readJson(paths.stateFile, {});
const saveState = (state) => writeJsonAtomic(paths.stateFile, state);

module.exports = {
  APP_ID, FLATPAK, paths, hostOf, isWebUrl, isHost, hostList, isDownloadDir, ASKED_PERMISSIONS, USERNAME_RE, ID_RE, BUILTIN_TYPES, THEMES,
  oneLine, normalizeLists, normalize, load, isFirstRun, addService, removeService, saveOrder, patchService, patchSettings, downloadDir,
  loadState, saveState,
};
