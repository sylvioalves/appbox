'use strict';

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const { pipeline } = require('stream/promises');
const os = require('os');
const path = require('path');
const config = require('./config');

const cacheDir = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'appbox');
const STAGING = path.join(cacheDir, 'import-staging');
const PENDING = path.join(cacheDir, 'pending-import.json');
const SESSIONS = path.join(config.paths.data, 'Partitions');
const TOP_LEVEL = ['manifest.json', 'config', 'state', 'sessions'];
/* Window state is the only part of state.json taken from an archive. */
const STATE_KEYS = ['bounds', 'maximized', 'activeId'];
/* Only the stores that carry a login are taken from an imported
 * session, so an archive cannot plant code or caches in a service
 * origin.
 */
const SESSION_KEEP = ['Cookies', 'Cookies-journal', 'Network', 'Local Storage', 'IndexedDB', 'Session Storage',
  'Preferences', 'Secure Preferences', 'Web Data', 'Web Data-journal', 'Login Data', 'Login Data-journal',
  'Trust Tokens', 'Trust Tokens-journal', 'DIPS', 'DIPS-journal', 'DIPS-wal', 'TransportSecurity',
  'Network Persistent State', 'WebStorage', 'Local State'];
const SESSION_DROPS = ['WebStorage/QuotaManager'];
/* Encrypted secrets travel with the sessions: they only decrypt on a
 * machine with the same keyring.
 */
const SECRET_FILES = ['mail-accounts.json', 'mail-trust.json', 'gh-tokens.json'];
const ENTRIES_MAX = 200000;
const BYTES_MAX = 2 * 1024 * 1024 * 1024;
const FREE_MARGIN = 256 * 1024 * 1024;
/* One line of the verbose listing: mode, numeric owner, size, date. */
const LISTING_RE = /^\S+\s+\S+\s+(\d+)\s+\d{4}-\d\d-\d\d\s/;
/* Encrypted archive: magic, scrypt salt, GCM nonce, ciphertext, tag. */
const MAGIC = Buffer.from('APPBOXENC1');
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEAD_LEN = MAGIC.length + SALT_LEN + IV_LEN;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const oneLine = (v) => String(v || '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim().slice(0, 100);
/* Chromium caches are rebuilt on demand and only add bulk. */
const SESSION_EXCLUDES = ['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
  'Service Worker/CacheStorage', 'Service Worker/ScriptCache', 'blob_storage', 'Crashpad', 'VideoDecodeStats'];

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/* Makes an imported tree private to the user. */
function privatize(dir) {
  fs.chmodSync(dir, 0o700);
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      privatize(p);
    } else {
      fs.chmodSync(p, 0o600);
    }
  }
}

function linkIfPresent(src, dest) {
  if (fs.existsSync(src)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.symlinkSync(src, dest);
  }
}

function deriveKey(passphrase, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(passphrase, salt, 32, SCRYPT, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

function isEncrypted(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(MAGIC.length);
    return fs.readSync(fd, head, 0, head.length, 0) === head.length && head.equals(MAGIC);
  } finally {
    fs.closeSync(fd);
  }
}

async function encryptFile(src, dest, passphrase) {
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = await deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const out = fs.createWriteStream(dest, { flags: 'w', mode: 0o600 });
  out.write(Buffer.concat([MAGIC, salt, iv]));
  await pipeline(fs.createReadStream(src), cipher, out);
  fs.appendFileSync(dest, cipher.getAuthTag());
}

async function decryptFile(src, dest, passphrase) {
  const size = fs.statSync(src).size;
  if (size <= HEAD_LEN + TAG_LEN) {
    throw new Error('not an encrypted Appbox profile');
  }
  const head = Buffer.alloc(HEAD_LEN);
  const tag = Buffer.alloc(TAG_LEN);
  const fd = fs.openSync(src, 'r');
  try {
    fs.readSync(fd, head, 0, HEAD_LEN, 0);
    fs.readSync(fd, tag, 0, TAG_LEN, size - TAG_LEN);
  } finally {
    fs.closeSync(fd);
  }
  const key = await deriveKey(passphrase, head.subarray(MAGIC.length, MAGIC.length + SALT_LEN));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, head.subarray(MAGIC.length + SALT_LEN, HEAD_LEN));
  decipher.setAuthTag(tag);
  try {
    await pipeline(fs.createReadStream(src, { start: HEAD_LEN, end: size - TAG_LEN - 1 }), decipher,
      fs.createWriteStream(dest, { flags: 'w', mode: 0o600 }));
  } catch (err) {
    fs.rmSync(dest, { force: true });
    if (err && err.code !== undefined) {
      throw err;
    }
    const bad = new Error('wrong passphrase or damaged archive');
    bad.code = 'BADPASS';
    throw bad;
  }
}

/* Writes a tar.gz with the app list and app state, plus the mail sign-in,
 * the image trust list and the app sessions when sessions is set, by
 * tarring a staging tree of symlinks with dereference. The mail cache is
 * never exported, it holds message contents and is fetched again. With a
 * passphrase the archive is encrypted.
 */
async function exportProfile(file, { sessions = false, version = '', passphrase = '' } = {}) {
  if (sessions && passphrase.length < 8) {
    throw new Error('a passphrase of at least 8 characters is required to export the sessions');
  }
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const stage = fs.mkdtempSync(path.join(cacheDir, 'export-'));
  const tmp = passphrase ? fs.mkdtempSync(path.join(cacheDir, 'export-')) : null;
  try {
    linkIfPresent(config.paths.services, path.join(stage, 'config', 'services.json'));
    linkIfPresent(config.paths.stateFile, path.join(stage, 'state', 'state.json'));
    if (sessions) {
      for (const name of SECRET_FILES) {
        linkIfPresent(path.join(config.paths.state, name), path.join(stage, 'state', name));
      }
    }
    if (sessions && fs.existsSync(SESSIONS)) {
      fs.symlinkSync(SESSIONS, path.join(stage, 'sessions'));
    }
    fs.writeFileSync(path.join(stage, 'manifest.json'), `${JSON.stringify({
      app: 'appbox',
      version,
      exported_at: new Date().toISOString(),
      host: os.hostname(),
      sessions: Boolean(sessions && fs.existsSync(SESSIONS)),
    }, null, 2)}\n`);
    const args = ['-czhf', file, '-C', stage];
    for (const ex of SESSION_EXCLUDES) {
      args.push(`--exclude=sessions/*/${ex}`);
    }
    args.push('.');
    /* A fresh private file, never a link the chosen name points at. */
    fs.rmSync(file, { force: true });
    fs.writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
    if (tmp) {
      const plain = path.join(tmp, 'profile.tar.gz');
      args[1] = plain;
      execFileSync('tar', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      try {
        await encryptFile(plain, file, passphrase);
      } finally {
        fs.rmSync(plain, { force: true });
      }
    } else {
      execFileSync('tar', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    }
    return { file, size: fs.statSync(file).size, sessions: Boolean(sessions), encrypted: Boolean(tmp) };
  } finally {
    rmrf(stage);
    if (tmp) {
      rmrf(tmp);
    }
  }
}

/* Accepts only plain files and directories under the known top-level
 * names, so an archive cannot plant links or write outside the staging
 * directory. Returns the unpacked size.
 */
function checkEntries(file) {
  const run = (flags) => execFileSync('tar', [...flags, file], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    .split('\n').filter((l) => l !== '');
  const names = run(['-tzf']);
  const listing = run(['--numeric-owner', '-tvzf']);
  if (names.length !== listing.length) {
    throw new Error('unreadable archive listing');
  }
  if (names.length > ENTRIES_MAX) {
    throw new Error('the archive holds too many entries');
  }
  let bytes = 0;
  names.forEach((name, i) => {
    const parts = name.replace(/^\.\//, '').split('/').filter((p) => p !== '' && p !== '.');
    const type = listing[i][0];
    if (type !== '-' && type !== 'd') {
      throw new Error(`archive holds a link or special file: ${name}`);
    }
    if (name.startsWith('/') || parts.includes('..') || (parts.length > 0 && !TOP_LEVEL.includes(parts[0]))) {
      throw new Error(`unexpected path in archive: ${name}`);
    }
    const m = LISTING_RE.exec(listing[i]);
    if (m === null) {
      throw new Error('unreadable archive listing');
    }
    bytes += Number(m[1]);
    if (bytes > BYTES_MAX) {
      throw new Error('the archive is too large');
    }
  });
  return bytes;
}

/* Reads the manifest of the staged tree, keeping only known fields. */
function stagedManifest() {
  const raw = JSON.parse(fs.readFileSync(path.join(STAGING, 'manifest.json'), 'utf8'));
  if (!raw || raw.app !== 'appbox' || !fs.existsSync(path.join(STAGING, 'config', 'services.json'))) {
    throw new Error('not an Appbox profile archive');
  }
  return {
    app: 'appbox',
    version: oneLine(raw.version),
    exported_at: oneLine(raw.exported_at),
    host: oneLine(raw.host),
    sessions: fs.existsSync(path.join(STAGING, 'sessions')),
  };
}

async function stageImport(file, passphrase = '') {
  if (!isEncrypted(file)) {
    return stageArchive(file);
  }
  if (!passphrase) {
    const err = new Error('the archive is encrypted');
    err.code = 'ENCRYPTED';
    throw err;
  }
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const tmp = fs.mkdtempSync(path.join(cacheDir, 'import-'));
  try {
    const plain = path.join(tmp, 'profile.tar.gz');
    await decryptFile(file, plain, passphrase);
    return stageArchive(plain);
  } finally {
    rmrf(tmp);
  }
}

/* Unpacks a vetted archive into the staging directory. Nothing is
 * recorded for the next start until commitImport runs.
 */
function stageArchive(file) {
  const bytes = checkEntries(file);
  clearPendingImport();
  fs.mkdirSync(STAGING, { recursive: true, mode: 0o700 });
  const st = fs.statfsSync(cacheDir);
  if (st.bavail * st.bsize < bytes + FREE_MARGIN) {
    rmrf(STAGING);
    throw new Error('not enough free space to unpack the archive');
  }
  let manifest;
  try {
    execFileSync('tar', ['-xzf', file, '-C', STAGING, '--no-same-owner', '--no-same-permissions'],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    manifest = stagedManifest();
  } catch (err) {
    clearPendingImport();
    throw err;
  }
  const stateDir = path.join(STAGING, 'state');
  const stateFile = path.join(stateDir, 'state.json');
  const old = readJson(stateFile, {});
  const kept = {};
  for (const k of STATE_KEYS) {
    if (k in old) {
      kept[k] = old[k];
    }
  }
  const keepFiles = {};
  for (const name of SECRET_FILES) {
    try {
      keepFiles[name] = fs.readFileSync(path.join(stateDir, name));
    } catch {
      /* not in the archive */
    }
  }
  rmrf(stateDir);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(stateFile, `${JSON.stringify(kept, null, 2)}\n`, { mode: 0o600 });
  for (const [name, data] of Object.entries(keepFiles)) {
    fs.writeFileSync(path.join(stateDir, name), data, { mode: 0o600 });
  }
  if (manifest.sessions) {
    for (const part of fs.readdirSync(path.join(STAGING, 'sessions'))) {
      const dir = path.join(STAGING, 'sessions', part);
      if (!config.ID_RE.test(part) || !fs.statSync(dir).isDirectory()) {
        rmrf(dir);
        continue;
      }
      for (const entry of fs.readdirSync(dir)) {
        if (!SESSION_KEEP.includes(entry)) {
          rmrf(path.join(dir, entry));
        }
      }
      for (const drop of SESSION_DROPS) {
        rmrf(path.join(dir, drop));
      }
    }
  }
  let launch = [];
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(STAGING, 'config', 'services.json'), 'utf8'));
    const cfg = config.normalize(raw);
    launch = cfg.services.filter((s) => s.launch).map((s) => `${config.oneLine(s.name, 60)}: ${config.oneLine(s.launch, 200)}`);
  } catch (err) {
    clearPendingImport();
    throw new Error(`the archive has an unusable services.json: ${config.oneLine(err.message, 200)}`);
  }
  return { ...manifest, launch };
}

/* Records the staged tree for the next start. The directories in use
 * cannot be replaced while running.
 */
function commitImport() {
  if (!fs.existsSync(STAGING)) {
    throw new Error('no staged profile');
  }
  const manifest = stagedManifest();
  fs.writeFileSync(PENDING, `${JSON.stringify({ staged_at: new Date().toISOString(), manifest }, null, 2)}\n`,
    { mode: 0o600 });
}

function hasPendingImport() {
  return fs.existsSync(PENDING) && fs.existsSync(STAGING);
}

function clearPendingImport() {
  rmrf(STAGING);
  rmrf(PENDING);
}

/* Moves a staged tree into place, copying when the cache and the
 * destination are on different file systems.
 */
function moveTree(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') {
      throw err;
    }
    fs.cpSync(src, dest, { recursive: true });
    rmrf(src);
  }
}

/* Replaces the live directories with the staged ones. Runs before any
 * window or session is created. The current tree is kept aside until
 * the staged one is in place, so a failure leaves the app bootable.
 */
function applyPendingImport() {
  if (!hasPendingImport()) {
    return null;
  }
  const pending = JSON.parse(fs.readFileSync(PENDING, 'utf8'));
  const parts = [
    ['config', config.paths.config],
    ['state', config.paths.state],
    ['sessions', SESSIONS],
  ];
  const applied = [];
  for (const [name, dest] of parts) {
    const src = path.join(STAGING, name);
    if (!fs.existsSync(src)) {
      continue;
    }
    const old = `${dest}.old`;
    rmrf(old);
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    if (fs.existsSync(dest)) {
      fs.renameSync(dest, old);
    }
    try {
      moveTree(src, dest);
    } catch (err) {
      rmrf(dest);
      if (fs.existsSync(old)) {
        fs.renameSync(old, dest);
      }
      throw err;
    }
    rmrf(old);
    privatize(dest);
    applied.push(name);
  }
  rmrf(STAGING);
  rmrf(PENDING);
  return { ...pending, applied };
}

module.exports = { exportProfile, stageImport, commitImport, hasPendingImport, clearPendingImport, applyPendingImport };
