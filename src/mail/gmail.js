'use strict';

const { safeStorage } = require('electron');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { ImapClient, ImapError, fetchItems, text, quote } = require('./imap');
const {
  parseMessage, parseEnvelope, parseHeaders, parseAddresses, decodeWords, decodeCharset, decodeTransfer,
} = require('./mime');
const config = require('../main/config');
const { keyringSecure } = require('../main/keyring');
const { guard, guardOn } = require('../main/ipc');
const { sendMail } = require('./smtp');
const { buildMessage } = require('./compose');

const SMTP_HOST = 'smtp.gmail.com';
const SMTP_PORT = 465;

const HOST = 'imap.gmail.com';
const PORT = 993;
const PAGE = 50;
const CACHE_PER_BOX = 100;
const SNIPPET_BYTES = 700;
const SNIPPET_BYTES_HTML = 6000;
const SNIPPET_CHARS = 140;
const INBOX = 'INBOX';
const IDLE_RENEW_MS = 24 * 60 * 1000;
const COUNTS_DEBOUNCE_MS = 2000;
const CACHE_DEBOUNCE_MS = 2000;
const THREAD_TTL_MS = 15 * 60 * 1000;
const BODY_FETCH_CAP = 4;
const PREFETCH_MAX = 40;
const RETRY_MS = [5000, 15000, 60000];
const KEEPALIVE_MS = 4 * 60 * 1000;
const SUMMARY_ITEMS = '(UID FLAGS INTERNALDATE RFC822.SIZE X-GM-THRID BODYSTRUCTURE BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE)])';
const THREAD_ITEMS = '(UID FLAGS INTERNALDATE X-GM-THRID BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID REFERENCES)])';
const ACCOUNTS_FILE = path.join(config.paths.state, 'mail-accounts.json');
const TRUST_FILE = path.join(config.paths.state, 'mail-trust.json');
const CACHE_DIR = path.join(config.paths.state, 'mail-cache');

/* Connections: cmd carries folder sync and user actions, idle waits on
 * the inbox, reader fetches conversations the user opens, bg does
 * counts and prefetch so they never delay a click.
 */
const CONNS = ['cmd', 'idle', 'reader', 'bg'];

const ROLE_FLAGS = {
  '\\inbox': 'inbox',
  '\\flagged': 'starred',
  '\\important': 'important',
  '\\sent': 'sent',
  '\\drafts': 'drafts',
  '\\all': 'all',
  '\\junk': 'spam',
  '\\trash': 'trash',
};
const ROLE_ORDER = ['inbox', 'starred', 'important', 'sent', 'drafts', 'all', 'spam', 'trash'];
const ROLE_NAMES = {
  inbox: 'Inbox',
  starred: 'Favorites',
  important: 'Important',
  sent: 'Sent',
  drafts: 'Drafts',
  all: 'All Mail',
  spam: 'Spam',
  trash: 'Trash',
};
/* Folders whose unread (or, for drafts, total) count is shown. */
const COUNT_KIND = { inbox: 'unseen', spam: 'unseen', drafts: 'total', label: 'unseen' };
const MOVES = ['archive', 'trash', 'inbox', 'delete'];

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: mode || 0o600 });
  fs.renameSync(tmp, file);
}

const readAccounts = () => readJson(ACCOUNTS_FILE, {});
const writeAccounts = (data) => writeJson(ACCOUNTS_FILE, data, 0o600);

const readTrust = () => readJson(TRUST_FILE, {});
/* Messages above this size are not fetched ahead of time. */
const PREFETCH_MAX_BYTES = 10 * 1024 * 1024;
/* Bodies above this size are not fetched for the reader. */
const BODY_MAX_BYTES = 25 * 1024 * 1024;
const BODY_ITEMS = `(UID X-GM-THRID RFC822.SIZE BODY.PEEK[]<0.${BODY_MAX_BYTES}>)`;
const PARSED_MAX_BYTES = 64 * 1024 * 1024;
const INLINE_MAX_BYTES = 12 * 1024 * 1024;
const BIDI_RE = /[\u202a-\u202e\u2066-\u2069]/g;

/* Trust by sender address holds only when Gmail verified the domain:
 * the first Authentication-Results header is the one Gmail added, its
 * authserv-id must be Gmail's.
 */
const AUTHSERV_ID = 'mx.google.com';

function dmarcPass(authResults, email) {
  const domain = String(email || '').split('@')[1];
  if (!domain) {
    return false;
  }
  const parts = String(authResults || '').split(';');
  const authserv = (parts.shift() || '').trim().toLowerCase().split(/\s+/)[0];
  if (authserv !== AUTHSERV_ID) {
    return false;
  }
  const want = `header.from=${domain.toLowerCase()}`;
  return parts.some((part) => {
    const tokens = part.trim().toLowerCase().split(/\s+/);
    return tokens[0] === 'dmarc=pass' && tokens.includes(want);
  });
}
const writeTrust = (data) => writeJson(TRUST_FILE, data, 0o600);

function threadUrl(base, thrid) {
  try {
    return `${base.replace(/#.*$/, '')}#all/${BigInt(thrid).toString(16)}`;
  } catch {
    return base;
  }
}

/* Decodes an IMAP modified UTF-7 mailbox name (RFC 3501 5.1.3). */
function decodeUtf7(s) {
  return String(s).replace(/&([A-Za-z0-9+,]*)-/g, (m, b64) => {
    if (b64 === '') {
      return '&';
    }
    const buf = Buffer.from(b64.replace(/,/g, '/'), 'base64');
    const even = buf.subarray(0, buf.length - (buf.length % 2));
    return Buffer.from(even).swap16().toString('utf16le');
  });
}

/* Locates the first text part in a BODYSTRUCTURE tree, preferring
 * text/plain, and returns its part number, charset and encoding.
 */
function firstTextPart(bs, prefix = '') {
  if (!Array.isArray(bs) || bs.length === 0) {
    return null;
  }
  if (Array.isArray(bs[0])) {
    let html = null;
    for (let k = 0; k < bs.length && Array.isArray(bs[k]); k++) {
      const r = firstTextPart(bs[k], `${prefix}${k + 1}.`);
      if (r && r.subtype === 'plain') {
        return r;
      }
      if (r && !html) {
        html = r;
      }
    }
    return html;
  }
  if (text(bs[0]).toLowerCase() !== 'text') {
    return null;
  }
  let charset = 'utf-8';
  if (Array.isArray(bs[2])) {
    for (let i = 0; i + 1 < bs[2].length; i += 2) {
      if (text(bs[2][i]).toLowerCase() === 'charset') {
        charset = text(bs[2][i + 1]);
      }
    }
  }
  return {
    part: prefix ? prefix.slice(0, -1) : '1',
    subtype: text(bs[1]).toLowerCase(),
    charset,
    encoding: text(bs[5]).toLowerCase(),
  };
}

/* True when a BODYSTRUCTURE holds a real attachment: a part with an
 * attachment disposition, or a non-text part that is not an inline
 * image referenced by Content-ID.
 */
function hasAttachment(bs) {
  if (!Array.isArray(bs) || bs.length === 0) {
    return false;
  }
  if (Array.isArray(bs[0])) {
    for (let k = 0; k < bs.length && Array.isArray(bs[k]); k++) {
      if (hasAttachment(bs[k])) {
        return true;
      }
    }
    return false;
  }
  const type = text(bs[0]).toLowerCase();
  const hasId = bs[3] && text(bs[3]) !== 'NIL' && text(bs[3]) !== '';
  let disposition = '';
  for (const el of bs.slice(7)) {
    if (Array.isArray(el) && el.length > 0 && !Array.isArray(el[0])) {
      const d = text(el[0]).toLowerCase();
      if (d === 'attachment' || d === 'inline') {
        disposition = d;
        break;
      }
    }
  }
  if (disposition === 'attachment') {
    return true;
  }
  if (type === 'text' || type === 'multipart') {
    return false;
  }
  if (type === 'message') {
    return true;
  }
  return !(disposition === 'inline' && hasId) && !(type === 'image' && hasId);
}

function makeSnippet(raw, tp, partial = false) {
  let buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'latin1');
  if (tp.encoding === 'base64') {
    const clean = buf.toString('latin1').replace(/[^A-Za-z0-9+/]/g, '');
    buf = Buffer.from(clean.slice(0, clean.length - (clean.length % 4)), 'base64');
  } else if (tp.encoding === 'quoted-printable') {
    buf = decodeTransfer(Buffer.from(buf.toString('latin1').replace(/=[0-9A-Fa-f]?$/, ''), 'latin1'), 'quoted-printable');
  }
  let s = decodeCharset(buf, tp.charset);
  if (tp.subtype === 'html') {
    const bodyAt = s.search(/<body[\s>]/i);
    if (bodyAt >= 0) {
      s = s.slice(bodyAt);
    } else if (partial) {
      s = s.replace(/^[^<]*?>/, ' ');
    }
    s = s.replace(/<(style|script|head|title)[\s\S]*?(<\/\1\s*>|$)/gi, ' ')
      .replace(/<!--[\s\S]*?(-->|$)/g, ' ')
      .replace(/<[^>]*>?/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&#?\w+;/g, ' ');
  }
  s = s.replace(/^>.*$/gm, ' ')
    .replace(/<!--[\s\S]*?(-->|$)/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[*=_#~-]{4,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > SNIPPET_CHARS) {
    s = `${s.slice(0, SNIPPET_CHARS - 1).replace(/\s+\S*$/, '')}\u2026`;
  }
  return s.replace(/\ufffd/g, '');
}

function baseSubject(s) {
  return String(s || '').replace(/^\s*((re|fwd?|enc|res)\s*:\s*)+/i, '').trim();
}

class MailAccount extends EventEmitter {
  constructor(svc, ctx) {
    super();
    this.svc = svc;
    this.ctx = ctx;
    this.state = 'signed-out';
    this.error = null;
    this.user = null;
    this.pass = null;
    this.conns = {};
    this.current = INBOX;
    this.boxes = new Map();
    this.folders = [];
    this.special = { all: '[Gmail]/All Mail', trash: '[Gmail]/Trash' };
    this.unread = 0;
    this.stopped = false;
    this.retries = 0;
    this.retryTimer = null;
    this.syncPromise = null;
    this.syncAgain = false;
    this.idleTimer = null;
    this.countsTimer = null;
    this.keepaliveTimer = null;
    this.cacheTimer = null;
    this.parsed = new Map();
    this.threads = new Map();
    this.prefetchList = [];
    this.prefetching = false;
    this.watched = new Set();
    this.cacheFile = path.join(CACHE_DIR, `${svc.id}.json`);
    this.loadCache();
  }

  status() {
    return {
      state: this.state,
      error: this.error,
      user: this.user,
      unread: this.unread,
      keyring: keyringSecure(),
    };
  }

  /* ---- persistence ---- */

  loadCache() {
    const c = readJson(this.cacheFile, null);
    if (!c || !Array.isArray(c.folders)) {
      return;
    }
    this.folders = c.folders;
    this.special = { ...this.special, ...(c.special || {}) };
    this.unread = Number(c.unread) || 0;
    for (const [mbox, data] of Object.entries(c.boxes || {})) {
      const box = this.box(mbox);
      for (const m of data.messages || []) {
        /* Summaries from before the attachment flag are fetched again. */
        if (m.att === undefined) {
          continue;
        }
        box.messages.set(m.uid, m);
        box.lastMaxUid = Math.max(box.lastMaxUid, m.uid);
      }
    }
  }

  scheduleCache() {
    clearTimeout(this.cacheTimer);
    this.cacheTimer = setTimeout(() => this.saveCache(), CACHE_DEBOUNCE_MS);
  }

  saveCache() {
    if (this.user === null) {
      return;
    }
    const boxes = {};
    for (const [mbox, box] of this.boxes) {
      boxes[mbox] = {
        messages: [...box.messages.values()].sort((a, b) => b.uid - a.uid).slice(0, CACHE_PER_BOX),
      };
    }
    try {
      writeJson(this.cacheFile, {
        folders: this.folders, special: this.special, unread: this.unread, boxes,
      }, 0o600);
    } catch (err) {
      console.error(`${this.svc.id}: cache: ${err.message}`);
    }
  }

  dropCache() {
    try {
      fs.rmSync(this.cacheFile, { force: true });
    } catch {
      /* nothing to drop */
    }
  }

  /* ---- account lifecycle ---- */

  /* Starts from stored credentials, if any. */
  init() {
    const acc = readAccounts()[this.svc.id];
    if (!acc) {
      return;
    }
    if (!keyringSecure()) {
      /* The keyring is not up: keep the entry for the next start. */
      this.error = 'the keyring is not available, the stored app password will be tried again at the next start';
      this.state = 'signed-out';
      this.emit('status', this.status());
      return;
    }
    try {
      this.user = acc.user;
      this.pass = safeStorage.decryptString(Buffer.from(acc.secret, 'base64'));
      this.ctx.onBadge(this.svc.id, this.unread);
      this.start();
    } catch (err) {
      /* The keyring entry no longer decrypts: drop the stored account and
       * ask for the password again instead of showing a dead error.
       */
      const all = readAccounts();
      delete all[this.svc.id];
      writeAccounts(all);
      this.user = null;
      this.pass = null;
      this.error = 'the stored app password could not be read, please sign in again';
      this.state = 'signed-out';
      this.emit('status', this.status());
    }
  }

  async login(user, pass) {
    if (!keyringSecure()) {
      throw new Error('no keyring available to store the password');
    }
    this.user = user.trim();
    this.pass = pass.replace(/\s+/g, '');
    this.stopped = false;
    this.retries = 0;
    await this.start(true);
    const all = readAccounts();
    all[this.svc.id] = {
      user: this.user,
      secret: safeStorage.encryptString(this.pass).toString('base64'),
    };
    writeAccounts(all);
    return this.status();
  }

  logout() {
    this.stop();
    const all = readAccounts();
    delete all[this.svc.id];
    writeAccounts(all);
    this.user = null;
    this.pass = null;
    this.boxes.clear();
    this.folders = [];
    this.parsed.clear();
    this.parsedBytes = 0;
    this.threads.clear();
    this.prefetchList = [];
    this.current = INBOX;
    this.unread = 0;
    clearTimeout(this.cacheTimer);
    this.dropCache();
    this.setState('signed-out');
    this.ctx.onBadge(this.svc.id, 0);
  }

  /* Signs out and drops the per-sender image trust as well. */
  forget() {
    this.logout();
    const all = readTrust();
    delete all[this.svc.id];
    writeTrust(all);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.idleTimer);
    clearTimeout(this.countsTimer);
    clearInterval(this.keepaliveTimer);
    for (const name of CONNS) {
      const c = this.conns[name];
      if (c) {
        c.removeAllListeners('close');
        c.close();
      }
    }
    this.conns = {};
    this.prefetchList = [];
  }

  setState(state) {
    this.state = state;
    if (state !== 'error') {
      this.error = null;
    }
    this.emit('status', this.status());
  }

  setError(message) {
    this.error = message;
    this.state = 'error';
    this.emit('status', this.status());
  }

  conn(name) {
    const c = this.conns[name];
    if (!c || c.closed) {
      throw new Error('not connected');
    }
    return c;
  }

  /* Serializes multi-command sequences on one connection so a SELECT
   * for one folder never lands between another sequence's steps.
   */
  locked(name, fn) {
    const c = this.conn(name);
    const run = () => fn(c);
    const p = c.chain.then(run, run);
    c.chain = p.catch(() => {});
    return p;
  }

  async start(throwOnError = false) {
    this.stop();
    this.stopped = false;
    this.setState('connecting');
    try {
      this.conns.cmd = await this.open('cmd');
      await this.discoverBoxes();
      this.conns.idle = await this.open('idle');
      this.runIdle();
      const [reader, bg] = await Promise.all([this.open('reader'), this.open('bg')]);
      this.conns.reader = reader;
      this.conns.bg = bg;
      for (const name of ['reader', 'bg']) {
        this.locked(name, (c) => this.select(c, this.threadBox())).catch(() => {});
      }
      await this.sync(true);
      this.retries = 0;
      this.setState('ready');
      this.scheduleCounts(0);
      this.startKeepalive();
      this.runPrefetch();
    } catch (err) {
      this.stop();
      const msg = err instanceof ImapError && err.code === 'AUTHENTICATIONFAILED'
        ? 'sign-in refused: check the address and the app password'
        : err.message;
      this.setError(msg);
      if (throwOnError) {
        throw new Error(msg);
      }
      if (!(err instanceof ImapError && err.code === 'AUTHENTICATIONFAILED')) {
        this.scheduleRetry();
      }
    }
  }

  scheduleRetry() {
    if (this.stopped && this.user === null) {
      return;
    }
    clearTimeout(this.retryTimer);
    const delay = RETRY_MS[Math.min(this.retries++, RETRY_MS.length - 1)];
    this.retryTimer = setTimeout(() => this.start(), delay);
  }

  async open(name) {
    const c = new ImapClient({ host: HOST, port: PORT, user: this.user, pass: this.pass });
    await c.connect();
    c.chain = Promise.resolve();
    c.box = null;
    c.on('close', () => {
      if (!this.stopped && this.conns[name] === c) {
        this.reopen(name);
      }
    });
    return c;
  }

  /* Replaces one dropped connection without disturbing the others;
   * only a failed replacement surfaces as an error and full restart.
   */
  async reopen(name) {
    if (this.stopped) {
      return;
    }
    delete this.conns[name];
    try {
      const c = await this.open(name);
      if (this.stopped) {
        c.close();
        return;
      }
      this.conns[name] = c;
      if (name === 'idle') {
        this.runIdle();
      } else if (name === 'reader' || name === 'bg') {
        this.locked(name, (x) => this.select(x, this.threadBox())).catch(() => {});
      }
      if (name === 'cmd' || name === 'idle') {
        this.requestSync();
      }
    } catch (err) {
      if (!this.stopped) {
        this.setError(`connection lost (${name}): ${err.message}, reconnecting`);
        this.scheduleRetry();
      }
    }
  }

  /* Gmail drops silent connections; a NOOP every few minutes keeps the
   * non-idling ones alive.
   */
  startKeepalive() {
    clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = setInterval(() => {
      for (const name of ['cmd', 'reader', 'bg']) {
        const c = this.conns[name];
        if (c && !c.closed && !c.pending) {
          this.locked(name, (x) => x.command('NOOP')).catch(() => {});
        }
      }
    }, KEEPALIVE_MS);
  }

  /* ---- folders ---- */

  async discoverBoxes() {
    const res = await this.conn('cmd').command('LIST "" "*"');
    const specials = [];
    const labels = [];
    for (const u of res.untagged) {
      if (text(u[0]) !== 'LIST' || !Array.isArray(u[1])) {
        continue;
      }
      const flags = u[1].map((f) => text(f).toLowerCase());
      const delim = text(u[2]) === 'NIL' ? '/' : text(u[2]);
      const mbox = text(u[3], 'utf8');
      if (flags.includes('\\noselect') || flags.includes('\\nonexistent')) {
        continue;
      }
      const roleFlag = Object.keys(ROLE_FLAGS).find((f) => flags.includes(f));
      let role = roleFlag ? ROLE_FLAGS[roleFlag] : null;
      if (mbox.toUpperCase() === INBOX) {
        role = 'inbox';
      }
      if (role) {
        this.special[role] = mbox;
        specials.push({ path: mbox, name: ROLE_NAMES[role], role, depth: 0 });
      } else {
        const parts = decodeUtf7(mbox).split(delim);
        labels.push({ path: mbox, name: parts[parts.length - 1], role: 'label', depth: parts.length - 1, full: parts.join(delim) });
      }
    }
    specials.sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));
    labels.sort((a, b) => a.full.localeCompare(b.full, undefined, { sensitivity: 'base' }));
    const counts = new Map(this.folders.map((f) => [f.path, f.count]));
    this.folders = [...specials, ...labels].map(({ full, ...f }) => ({
      ...f,
      countKind: COUNT_KIND[f.role] || null,
      count: counts.get(f.path) ?? null,
    }));
    if (!this.folders.some((f) => f.path === this.current)) {
      this.current = INBOX;
    }
    this.emit('folders');
    this.scheduleCache();
  }

  folderList() {
    return { current: this.current, folders: this.folders };
  }

  folder(mbox) {
    return this.folders.find((f) => f.path === mbox) || null;
  }

  role(mbox) {
    const f = this.folder(mbox);
    return f ? f.role : null;
  }

  box(mbox) {
    let b = this.boxes.get(mbox);
    if (!b) {
      b = { messages: new Map(), bottomSeq: 0, exists: 0, uidNext: 0, lastMaxUid: 0 };
      this.boxes.set(mbox, b);
    }
    return b;
  }

  async select(c, mbox, force = false) {
    if (force || c.box !== mbox) {
      const sel = await c.command(`SELECT ${quote(mbox)}`);
      c.box = mbox;
      for (const u of sel.untagged) {
        if (text(u[1]).toUpperCase() === 'EXISTS') {
          this.box(mbox).exists = Number(text(u[0]));
        }
      }
    }
  }

  /* Senders whose remote images load without asking. */
  isTrusted(email) {
    const list = readTrust()[this.svc.id] || [];
    return Boolean(email) && list.includes(email.toLowerCase());
  }

  setTrust(email, on) {
    const addr = String(email).trim().toLowerCase();
    if (!addr) {
      return false;
    }
    const all = readTrust();
    const list = new Set(all[this.svc.id] || []);
    if (on) {
      list.add(addr);
    } else {
      list.delete(addr);
    }
    all[this.svc.id] = [...list];
    writeTrust(all);
    for (const m of this.parsed.values()) {
      if (m.from.length === 1 && m.from[0].email.toLowerCase() === addr) {
        m.trusted = Boolean(on);
      }
    }
    return Boolean(on);
  }

  /* ---- idle and sync ---- */

  runIdle() {
    const c = this.conns.idle;
    let dirty = false;
    c.on('untagged', (u) => {
      const kind = text(u[1]).toUpperCase();
      if (kind === 'EXISTS' || kind === 'EXPUNGE' || kind === 'FETCH') {
        dirty = true;
        c.done();
      }
    });
    const loop = async () => {
      try {
        await c.command(`SELECT ${quote(this.special.all || INBOX)}`);
        while (!c.closed && !this.stopped) {
          dirty = false;
          clearTimeout(this.idleTimer);
          this.idleTimer = setTimeout(() => c.done(), IDLE_RENEW_MS);
          await c.idle();
          if (dirty) {
            this.requestSync();
          }
        }
      } catch (err) {
        if (!this.stopped) {
          console.error(`${this.svc.id}: idle: ${err.message}`);
        }
      }
    };
    loop();
  }

  requestSync() {
    if (this.syncPromise) {
      this.syncAgain = true;
      return this.syncPromise;
    }
    this.syncPromise = this.sync(false)
      .catch((err) => console.error(`${this.svc.id}: sync: ${err.message}`))
      .finally(() => {
        this.syncPromise = null;
        if (this.syncAgain) {
          this.syncAgain = false;
          this.requestSync();
        }
      });
    return this.syncPromise;
  }

  summaryFrom(tree) {
    const items = fetchItems(tree);
    const uid = Number(text(items.UID));
    if (!uid) {
      return null;
    }
    const bodyKey = Object.keys(items).find((k) => k.startsWith('BODY['));
    const headers = parseHeaders(text(items[bodyKey], 'utf8'));
    const flags = Array.isArray(items.FLAGS) ? items.FLAGS.map((f) => text(f).toLowerCase()) : [];
    const from = parseAddresses(headers.get('from'))[0] || { name: '', email: '' };
    return {
      uid,
      seq: Number(text(tree[0])),
      from,
      to: parseAddresses(headers.get('to')),
      cc: parseAddresses(headers.get('cc')),
      subject: decodeWords(headers.get('subject')) || '(no subject)',
      date: headers.get('date') || text(items.INTERNALDATE),
      seen: flags.includes('\\seen'),
      flagged: flags.includes('\\flagged'),
      size: Number(text(items['RFC822.SIZE'])) || 0,
      thrid: text(items['X-GM-THRID']),
      messageId: (headers.get('message-id') || '').trim(),
      references: (headers.get('references') || '').replace(/\s+/g, ' ').trim(),
      att: hasAttachment(items.BODYSTRUCTURE),
      textPart: firstTextPart(items.BODYSTRUCTURE),
    };
  }

  /* One summary per uid: Gmail may answer a FETCH with two lines for
   * the same message.
   */
  collect(res) {
    const out = new Map();
    for (const u of res.untagged) {
      if (text(u[1]).toUpperCase() === 'FETCH') {
        const s = this.summaryFrom(u);
        if (s && !out.has(s.uid)) {
          out.set(s.uid, s);
        }
      }
    }
    return [...out.values()];
  }

  async fetchRange(c, bottom, top) {
    const res = await c.command(`FETCH ${bottom}:${top} ${SUMMARY_ITEMS}`);
    const list = this.collect(res);
    await this.fetchSnippets(c, list);
    return list;
  }

  async fetchUids(c, uids, items = SUMMARY_ITEMS) {
    if (uids.length === 0) {
      return [];
    }
    const res = await c.command(`UID FETCH ${uids.join(',')} ${items}`);
    const list = this.collect(res);
    await this.fetchSnippets(c, list);
    return list;
  }

  /* Fills in snippets from the first text part of each message, one
   * FETCH per distinct part number.
   */
  async fetchSnippets(c, list) {
    const groups = new Map();
    const byUid = new Map();
    for (const m of list) {
      byUid.set(m.uid, m);
      if (m.textPart && m.snippet === undefined) {
        const key = `${m.textPart.part}|${m.textPart.subtype === 'html' ? SNIPPET_BYTES_HTML : SNIPPET_BYTES}`;
        groups.set(key, [...(groups.get(key) || []), m.uid]);
      }
    }
    const run = async (part, range, uids, partial) => {
      try {
        const res = await c.command(`UID FETCH ${uids.join(',')} (UID BODY.PEEK[${part}]<${range}>)`);
        for (const u of res.untagged) {
          if (text(u[1]).toUpperCase() !== 'FETCH') {
            continue;
          }
          const items = fetchItems(u);
          const m = byUid.get(Number(text(items.UID)));
          const key = Object.keys(items).find((k) => k.startsWith('BODY['));
          if (m && key) {
            const tk = items[key];
            m.snippet = makeSnippet(tk && tk.t === 'lit' ? tk.v : text(tk), m.textPart, partial);
          }
        }
      } catch (err) {
        console.error(`${this.svc.id}: snippets: ${err.message}`);
      }
    };
    for (const [key, uids] of groups) {
      const [part, bytes] = key.split('|');
      await run(part, `0.${bytes}`, uids, false);
    }
    const retry = new Map();
    for (const m of list) {
      if (m.textPart && m.textPart.subtype === 'html' && !m.snippet) {
        retry.set(m.textPart.part, [...(retry.get(m.textPart.part) || []), m.uid]);
      }
    }
    for (const [part, uids] of retry) {
      await run(part, `${SNIPPET_BYTES_HTML}.${SNIPPET_BYTES_HTML * 3}`, uids, true);
    }
    for (const m of list) {
      if (m.snippet === undefined) {
        m.snippet = '';
      }
      delete m.textPart;
    }
  }

  async searchCount(c, criteria) {
    return (await this.searchUids(c, criteria)).length;
  }

  async searchUids(c, criteria) {
    const res = await c.command(`UID SEARCH ${criteria}`);
    for (const u of res.untagged) {
      if (text(u[0]).toUpperCase() === 'SEARCH') {
        return u.slice(1).map((t) => Number(text(t))).filter((n) => n > 0);
      }
    }
    return [];
  }

  setCount(mbox, count) {
    const f = this.folder(mbox);
    if (f && f.count !== count) {
      f.count = count;
      return true;
    }
    return false;
  }

  /* Syncs the inbox (badge, notifications) and, when different, the
   * folder being viewed.
   */
  async sync(initial) {
    const boxes = [INBOX, this.current, ...this.watched].filter((m, i, a) => a.indexOf(m) === i && this.folder(m));
    const t0 = Date.now();
    await this.locked('cmd', async (c) => {
      for (const mbox of boxes) {
        if (mbox === INBOX || mbox === this.current) {
          await this.syncBox(c, mbox, initial);
          continue;
        }
        /* Watched folders: one STATUS, a full pass only when something moved. */
        const box = this.box(mbox);
        const st = await this.statusBox(c, mbox);
        if (st && (st.messages !== box.exists || st.uidnext !== box.uidNext || box.bottomSeq === 0)) {
          await this.syncBox(c, mbox, initial);
        }
        if (st) {
          box.uidNext = st.uidnext;
          if (this.folder(mbox).countKind === 'unseen' && this.setCount(mbox, st.unseen)) {
            this.emit('folders');
          }
        }
      }
    });
    if (process.env.APPBOX_MAIL_TIMING) {
      console.log(`${this.svc.id}: sync ${boxes.join(', ')} in ${Date.now() - t0}ms`);
    }
    this.emit('list');
    this.scheduleCounts(COUNTS_DEBOUNCE_MS);
    this.scheduleCache();
  }

  async statusBox(c, mbox) {
    const res = await c.command(`STATUS ${quote(mbox)} (MESSAGES UIDNEXT UNSEEN)`);
    for (const u of res.untagged) {
      if (text(u[0]).toUpperCase() === 'STATUS' && Array.isArray(u[2])) {
        const items = {};
        for (let i = 0; i + 1 < u[2].length; i += 2) {
          items[text(u[2][i]).toLowerCase()] = Number(text(u[2][i + 1]));
        }
        return { messages: items.messages || 0, uidnext: items.uidnext || 0, unseen: items.unseen || 0 };
      }
    }
    return null;
  }

  /* Folders the UI wants kept fresh besides the inbox and the one on
   * screen (its pinned labels).
   */
  watch(paths) {
    this.watched = new Set(paths.map(String));
  }

  /* Incremental: one FETCH of UID and FLAGS for the top page, then full
   * summaries only for messages not seen before.
   */
  async syncBox(c, mbox, initial) {
    const box = this.box(mbox);
    await this.select(c, mbox, true);
    const top = box.exists;
    const bottom = Math.max(1, top - PAGE + 1);
    const firstSync = box.bottomSeq === 0;

    const window = [];
    if (top > 0) {
      const res = await c.command(`FETCH ${bottom}:${top} (UID FLAGS)`);
      for (const u of res.untagged) {
        if (text(u[1]).toUpperCase() !== 'FETCH') {
          continue;
        }
        const items = fetchItems(u);
        const uid = Number(text(items.UID));
        const flags = Array.isArray(items.FLAGS) ? items.FLAGS.map((f) => text(f).toLowerCase()) : [];
        if (uid > 0) {
          window.push({ uid, seq: Number(text(u[0])), seen: flags.includes('\\seen'), flagged: flags.includes('\\flagged') });
        }
      }
    }
    const windowUids = new Set(window.map((w) => w.uid));
    const minUid = window.reduce((a, w) => Math.min(a, w.uid), Infinity);
    const newUids = window.filter((w) => !box.messages.has(w.uid)).map((w) => w.uid);
    const fresh = await this.fetchUids(c, newUids);
    const touched = new Set();

    for (const [uid, m] of box.messages) {
      if ((uid >= minUid || top === 0 || firstSync) && !windowUids.has(uid)) {
        box.messages.delete(uid);
        touched.add(m.thrid);
      }
    }
    for (const w of window) {
      const m = box.messages.get(w.uid);
      if (m) {
        if (m.seen !== w.seen || m.flagged !== w.flagged) {
          touched.add(m.thrid);
        }
        m.seen = w.seen;
        m.flagged = w.flagged;
        m.seq = w.seq;
      }
    }
    for (const m of fresh) {
      box.messages.set(m.uid, m);
      touched.add(m.thrid);
    }
    box.bottomSeq = top === 0 ? 0 : (box.bottomSeq > 0 ? Math.min(box.bottomSeq, bottom) : bottom);
    for (const thrid of touched) {
      this.threads.delete(thrid);
    }

    const f = this.folder(mbox);
    if (mbox === INBOX || (f && f.countKind === 'unseen')) {
      const count = await this.searchCount(c, 'UNSEEN');
      if (this.setCount(mbox, count)) {
        this.emit('folders');
      }
      if (mbox === INBOX) {
        this.unread = count;
        this.ctx.onBadge(this.svc.id, count);
      }
    }

    const maxUid = window.reduce((a, w) => Math.max(a, w.uid), 0);
    if (mbox === INBOX && !initial && box.lastMaxUid > 0 && maxUid > box.lastMaxUid) {
      this.notifyArrivals(fresh.filter((m) => m.uid > box.lastMaxUid && !m.seen));
    }
    box.lastMaxUid = Math.max(box.lastMaxUid, maxUid);
  }

  scheduleCounts(delay) {
    clearTimeout(this.countsTimer);
    this.countsTimer = setTimeout(() => {
      this.refreshCounts().catch((err) => console.error(`${this.svc.id}: counts: ${err.message}`));
    }, delay);
  }

  async refreshCounts() {
    if (!this.conns.bg || this.stopped) {
      return;
    }
    const changed = await this.locked('bg', async (c) => {
      let any = false;
      for (const f of this.folders) {
        if (!f.countKind || this.stopped) {
          continue;
        }
        const item = f.countKind === 'total' ? 'MESSAGES' : 'UNSEEN';
        const res = await c.command(`STATUS ${quote(f.path)} (${item})`);
        for (const u of res.untagged) {
          if (text(u[0]).toUpperCase() === 'STATUS' && Array.isArray(u[2])) {
            const items = {};
            for (let i = 0; i + 1 < u[2].length; i += 2) {
              items[text(u[2][i]).toUpperCase()] = Number(text(u[2][i + 1]));
            }
            if (item in items && this.setCount(f.path, items[item])) {
              any = true;
            }
          }
        }
      }
      return any;
    });
    if (changed) {
      this.emit('folders');
      this.scheduleCache();
    }
  }

  notifyArrivals(arrivals) {
    if (!this.svc.notifications || arrivals.length === 0) {
      return;
    }
    const shown = arrivals.slice(0, 3);
    for (const m of shown) {
      this.ctx.notify({
        title: m.from.name || m.from.email || this.svc.name,
        body: m.subject,
        onClick: () => {
          this.ctx.activate(this.svc.id);
          this.emit('open', { uid: m.uid, thrid: m.thrid, box: INBOX });
        },
      });
    }
    if (arrivals.length > shown.length) {
      this.ctx.notify({
        title: this.svc.name,
        body: `${arrivals.length - shown.length} more new messages`,
        onClick: () => this.ctx.activate(this.svc.id),
      });
    }
  }

  /* ---- lists and conversations ---- */

  conversations(messages) {
    const byThread = new Map();
    for (const m of [...messages].sort((a, b) => a.uid - b.uid)) {
      const key = m.thrid || String(m.uid);
      const c = byThread.get(key);
      if (!c) {
        byThread.set(key, {
          thrid: key,
          uid: m.uid,
          uids: [m.uid],
          count: 1,
          names: [m.from.name || m.from.email || '(unknown)'],
          subject: m.subject,
          snippet: m.snippet || '',
          date: m.date,
          seen: m.seen,
          flagged: m.flagged,
          att: Boolean(m.att),
        });
      } else {
        c.uid = m.uid;
        c.uids.push(m.uid);
        c.count += 1;
        const name = m.from.name || m.from.email || '(unknown)';
        if (!c.names.includes(name)) {
          c.names.push(name);
        }
        c.subject = baseSubject(c.subject) ? c.subject : m.subject;
        c.snippet = m.snippet || c.snippet;
        c.date = m.date;
        c.seen = c.seen && m.seen;
        c.flagged = c.flagged || m.flagged;
        c.att = c.att || Boolean(m.att);
      }
    }
    return [...byThread.values()].sort((a, b) => b.uid - a.uid);
  }

  list() {
    const box = this.box(this.current);
    return {
      box: this.current,
      role: this.role(this.current),
      total: box.exists,
      more: box.bottomSeq > 1 || (box.bottomSeq === 0 && box.messages.size > 0),
      conversations: this.conversations(box.messages.values()),
    };
  }

  /* Switches folders: the cached list is returned at once and the
   * folder is synced in the background.
   */
  selectBox(mbox) {
    if (!this.folder(mbox)) {
      throw new Error('unknown folder');
    }
    this.current = mbox;
    if (this.conns.cmd) {
      this.locked('cmd', (c) => this.syncBox(c, mbox, false))
        .then(() => {
          this.emit('list');
          this.scheduleCache();
        })
        .catch((err) => console.error(`${this.svc.id}: select: ${err.message}`));
    }
    return this.list();
  }

  async more() {
    const mbox = this.current;
    const box = this.box(mbox);
    await this.locked('cmd', async (c) => {
      if (box.bottomSeq === 0) {
        await this.syncBox(c, mbox, false);
      }
      if (box.bottomSeq <= 1) {
        return;
      }
      await this.select(c, mbox);
      const top = box.bottomSeq - 1;
      const bottom = Math.max(1, top - PAGE + 1);
      const older = await this.fetchRange(c, bottom, top);
      for (const m of older) {
        box.messages.set(m.uid, m);
      }
      box.bottomSeq = bottom;
    });
    this.scheduleCache();
    return this.list();
  }

  threadBox() {
    const r = this.role(this.current);
    return r === 'trash' || r === 'spam' ? this.current : this.special.all;
  }

  /* Whole conversation from All Mail (or the current folder for Trash
   * and Spam). Headers and the latest body go out back to back, then
   * bodies for the unread ones.
   */
  async thread(thrid, light = false, fresh = false) {
    const connName = light ? 'bg' : 'reader';
    if (fresh) {
      this.threads.delete(thrid);
      if (process.env.APPBOX_MAIL_TIMING) {
        console.log(`${this.svc.id}: thread ${thrid} refetched, cached copy had no unread message`);
      }
    }
    const cached = this.threads.get(thrid);
    if (cached && Date.now() - cached.at < THREAD_TTL_MS) {
      if (!light && cached.light) {
        await this.fillBodies(cached.data, connName, BODY_FETCH_CAP);
        cached.light = false;
      }
      return cached.data;
    }
    const mbox = this.threadBox();
    const t = { start: Date.now() };
    const data = await this.locked(connName, async (c) => {
      t.queued = Date.now();
      await this.select(c, mbox);
      t.selected = Date.now();
      if (!/^\d{1,25}$/.test(thrid)) {
        throw new Error('bad thread id');
      }
      const uids = await this.searchUids(c, `X-GM-THRID ${thrid}`);
      t.searched = Date.now();
      if (uids.length === 0) {
        return { thrid, box: mbox, messages: [] };
      }
      const latest = Math.max(...uids);
      const known = this.box(mbox).messages.get(latest);
      const fetchBody = !this.parsed.has(`${mbox}\0${latest}`) && !(light && known && known.size > PREFETCH_MAX_BYTES);
      const [hdrs, bodyRes] = await Promise.all([
        c.command(`UID FETCH ${uids.join(',')} ${THREAD_ITEMS}`),
        fetchBody ? c.command(`UID FETCH ${latest} ${BODY_ITEMS}`) : null,
      ]);
      t.fetched = Date.now();
      const list = this.collect(hdrs).sort((a, b) => a.uid - b.uid);
      const messages = list.map(({ seq, size, textPart, ...m }) => ({ ...m, box: mbox, body: null }));
      const last = messages[messages.length - 1];
      if (last) {
        try {
          last.body = bodyRes ? this.parseBody(bodyRes, mbox, latest) : this.parsed.get(`${mbox}\0${latest}`);
        } catch {
          last.body = null;
        }
      }
      t.parsed = Date.now();
      return { thrid, box: mbox, messages };
    });
    if (data.messages.length === 0) {
      throw new Error('conversation not found');
    }
    await this.fillBodies(data, connName, light ? 2 : BODY_FETCH_CAP);
    t.bodies = Date.now();
    if (process.env.APPBOX_MAIL_TIMING) {
      const d = (a, b) => `${t[b] - t[a]}ms`;
      console.log(`${this.svc.id}: thread ${thrid} ${connName}: queue ${d('start', 'queued')} select ${d('queued', 'selected')} `
        + `search ${d('selected', 'searched')} fetch ${d('searched', 'fetched')} parse ${d('fetched', 'parsed')} `
        + `bodies ${d('parsed', 'bodies')} n=${data.messages.length}`);
    }
    this.threads.set(thrid, { at: Date.now(), data, light });
    return data;
  }

  async fillBodies(data, connName, cap) {
    const wanted = data.messages
      .filter((m, i) => !m.body && (i === data.messages.length - 1 || !m.seen))
      .slice(-cap);
    for (const m of wanted) {
      m.body = await this.message(data.box, m.uid, connName).catch(() => null);
    }
  }

  prefetch(thrids) {
    this.prefetchList = thrids.slice(0, PREFETCH_MAX).filter((t) => !this.threads.has(t));
    this.runPrefetch();
  }

  async runPrefetch() {
    if (this.prefetching) {
      return;
    }
    this.prefetching = true;
    while (this.prefetchList.length > 0 && !this.stopped && this.conns.bg) {
      const t = this.prefetchList.shift();
      if (!this.threads.has(t)) {
        await this.thread(String(t), true).catch(() => {});
      }
    }
    this.prefetching = false;
  }

  async message(mbox, uid, connName = 'reader') {
    const key = `${mbox}\0${uid}`;
    if (this.parsed.has(key)) {
      return this.parsed.get(key);
    }
    const res = await this.locked(connName, async (c) => {
      await this.select(c, mbox);
      return c.command(`UID FETCH ${uid} ${BODY_ITEMS}`);
    });
    return this.parseBody(res, mbox, uid);
  }

  /* Turns a BODY.PEEK[] fetch response into the reader's message and
   * caches it.
   */
  parseBody(res, mbox, uid) {
    const key = `${mbox}\0${uid}`;
    if (this.parsed.has(key)) {
      return this.parsed.get(key);
    }
    let raw = null;
    let thrid = '';
    let size = 0;
    for (const u of res.untagged) {
      if (text(u[1]).toUpperCase() === 'FETCH') {
        const items = fetchItems(u);
        const k = Object.keys(items).find((x) => x.startsWith('BODY['));
        if (k && items[k].t === 'lit' && Number(text(items.UID)) === uid) {
          raw = items[k].v;
          thrid = text(items['X-GM-THRID']);
          size = Number(text(items['RFC822.SIZE'])) || 0;
        }
      }
    }
    if (!raw) {
      throw new Error('message not found');
    }
    const oversize = size > BODY_MAX_BYTES || raw.length >= BODY_MAX_BYTES;
    const msg = oversize ? { ...parseEnvelope(raw), text: '', html: '', attachments: [] } : parseMessage(raw);
    const inline = {};
    const attachments = [];
    let inlineBytes = 0;
    msg.attachments.forEach((a, index) => {
      if (a.inline && a.cid && a.type.startsWith('image/') && a.size < 3 * 1024 * 1024
          && inlineBytes + a.size <= INLINE_MAX_BYTES) {
        inlineBytes += a.size;
        inline[a.cid] = `data:${a.type};base64,${a.content.toString('base64')}`;
      } else {
        attachments.push({ index, filename: a.filename, type: a.type, size: a.size });
      }
    });
    const out = {
      uid,
      box: mbox,
      subject: msg.subject || '(no subject)',
      from: msg.from,
      to: msg.to,
      cc: msg.cc,
      date: msg.date,
      text: msg.text,
      html: msg.html,
      truncated: Boolean(msg.truncated),
      oversize: oversize ? Math.max(size, raw.length) : 0,
      inline,
      attachments,
      trusted: msg.from.length === 1 && this.isTrusted(msg.from[0].email) && dmarcPass(msg.authResults, msg.from[0].email),
      url: thrid ? threadUrl(this.svc.url, thrid) : this.svc.url,
    };
    out.bytes = raw.length;
    this.parsed.set(key, out);
    this.parsedBytes = (this.parsedBytes || 0) + raw.length;
    while (this.parsed.size > 60 || (this.parsedBytes > PARSED_MAX_BYTES && this.parsed.size > 1)) {
      const first = this.parsed.keys().next().value;
      this.parsedBytes -= this.parsed.get(first).bytes;
      this.parsed.delete(first);
    }
    return out;
  }

  async search(query) {
    const q = String(query).trim();
    const mbox = this.special.all;
    if (!q || !this.conns.reader) {
      return { box: mbox, role: 'all', more: false, search: q, conversations: [] };
    }
    const list = await this.locked('reader', async (c) => {
      await this.select(c, mbox);
      const uids = (await this.searchUids(c, `X-GM-RAW ${quote(q)}`)).sort((a, b) => b - a).slice(0, PAGE);
      return this.fetchUids(c, uids);
    });
    return { box: mbox, role: 'all', more: false, search: q, conversations: this.conversations(list) };
  }

  /* ---- actions ---- */

  applyLocal(mbox, uids, fn) {
    const box = this.boxes.get(mbox);
    if (box) {
      for (const uid of uids) {
        const m = box.messages.get(uid);
        if (m) {
          fn(m);
        }
      }
    }
    for (const t of this.threads.values()) {
      for (const m of t.data.messages) {
        if (m.box === mbox && uids.includes(m.uid)) {
          fn(m);
        }
      }
    }
  }

  async flag(mbox, uids, { seen, flagged }) {
    const set = uids.join(',');
    /* The reader already sits on the thread folder and is idle between
     * opens, so stores for an open conversation skip the sync queue.
     */
    const reader = this.conns.reader;
    const connName = reader && !reader.closed && reader.box === mbox ? 'reader' : 'cmd';
    await this.locked(connName, async (c) => {
      await this.select(c, mbox);
      if (seen !== undefined) {
        await c.command(`UID STORE ${set} ${seen ? '+' : '-'}FLAGS.SILENT (\\Seen)`);
      }
      if (flagged !== undefined) {
        await c.command(`UID STORE ${set} ${flagged ? '+' : '-'}FLAGS.SILENT (\\Flagged)`);
      }
    });
    const thrids = new Set();
    if (process.env.APPBOX_MAIL_TIMING) {
      console.log(`${this.svc.id}: flag ${connName} ${mbox} [${set}] seen=${seen} flagged=${flagged}`);
    }
    this.applyLocal(mbox, uids, (m) => {
      if (seen !== undefined) {
        m.seen = seen;
      }
      if (flagged !== undefined) {
        m.flagged = flagged;
      }
      if (m.thrid) {
        thrids.add(m.thrid);
      }
    });
    /* Seen is a per-message flag that every folder sees, so mirror it
     * on the same conversations in all cached folders.
     */
    if (seen !== undefined) {
      for (const box of this.boxes.values()) {
        for (const m of box.messages.values()) {
          if (thrids.has(m.thrid)) {
            m.seen = seen;
          }
        }
      }
      for (const t of this.threads.values()) {
        if (thrids.has(t.data.thrid)) {
          for (const m of t.data.messages) {
            m.seen = seen;
          }
        }
      }
    }
    this.requestSync();
    return this.list();
  }

  async move(mbox, uids, where) {
    const set = uids.join(',');
    await this.locked('cmd', async (c) => {
      await this.select(c, mbox);
      if (where === 'delete') {
        await c.command(`UID STORE ${set} +FLAGS.SILENT (\\Deleted)`);
        await c.command(`UID EXPUNGE ${set}`);
      } else {
        const target = where === 'trash' ? this.special.trash
          : where === 'inbox' ? INBOX : this.special.all;
        await c.command(`UID MOVE ${set} ${quote(target)}`);
      }
    });
    const box = this.boxes.get(mbox);
    for (const uid of uids) {
      const m = box && box.messages.get(uid);
      if (m) {
        this.threads.delete(m.thrid);
        box.messages.delete(uid);
      }
      this.parsed.delete(`${mbox}\0${uid}`);
    }
    for (const [thrid, t] of this.threads) {
      if (t.data.messages.some((m) => m.box === mbox && uids.includes(m.uid))) {
        this.threads.delete(thrid);
      }
    }
    this.requestSync();
    return this.list();
  }

  /* Saves attachments of a message into dir, fetching the raw message
   * again since parsed bodies keep only attachment metadata.
   */
  async download(mbox, uid, indexes, dir, label) {
    const progress = (p) => this.ctx.onProgress(this.svc.id, { phase: 'downloading', label, have: p.have, size: p.size });
    this.ctx.onProgress(this.svc.id, { phase: 'downloading', label, have: 0, size: 0 });
    let res;
    try {
      res = await this.locked('reader', async (c) => {
        await this.select(c, mbox);
        c.on('progress', progress);
        try {
          return await c.command(`UID FETCH ${uid} (UID BODY.PEEK[])`);
        } finally {
          c.removeListener('progress', progress);
        }
      });
    } catch (err) {
      this.ctx.onProgress(this.svc.id, { phase: 'failed', label, error: err.message });
      throw err;
    }
    let raw = null;
    for (const u of res.untagged) {
      if (text(u[1]).toUpperCase() === 'FETCH') {
        const items = fetchItems(u);
        const k = Object.keys(items).find((x) => x.startsWith('BODY['));
        if (k && items[k].t === 'lit' && Number(text(items.UID)) === uid) {
          raw = items[k].v;
        }
      }
    }
    if (!raw) {
      throw new Error('message not found');
    }
    const msg = parseMessage(raw);
    fs.mkdirSync(dir, { recursive: true });
    const out = [];
    for (const i of indexes) {
      const a = msg.attachments[i];
      if (!a) {
        continue;
      }
      const base = String(a.filename || `attachment-${i + 1}`).replace(BIDI_RE, '')
        .replace(/[\u0000-\u001f/\\]/g, '_').replace(/^\.+/, '_').slice(0, 200);
      const ext = path.extname(base);
      const stem = base.slice(0, base.length - ext.length);
      let file = path.join(dir, base);
      /* Exclusive create, so an existing file or link is never followed. */
      for (let n = 1; ; n++) {
        try {
          fs.writeFileSync(file, a.content, { flag: 'wx', mode: 0o600 });
          break;
        } catch (err) {
          if (err.code !== 'EEXIST' || n > 1000) {
            throw err;
          }
          file = path.join(dir, `${stem} (${n})${ext}`);
        }
      }
      out.push({ name: path.basename(file), path: file, size: a.content.length });
    }
    this.ctx.onProgress(this.svc.id, {
      phase: 'saved', label, files: out.map((f) => f.name), dir, size: out.reduce((n, f) => n + f.size, 0),
    });
    return out;
  }

  /* Sends through Gmail's submission server; Gmail files the copy in
   * Sent by itself.
   */
  async send(opts) {
    if (!this.user || !this.pass) {
      throw new Error('not signed in');
    }
    const msg = buildMessage({ ...opts, from: this.user });
    await sendMail({
      host: SMTP_HOST, port: SMTP_PORT, user: this.user, pass: this.pass,
      from: this.user, rcpts: msg.rcpts, data: msg.data,
    });
    if (opts.draftUid) {
      await this.deleteDraft(opts.draftUid).catch(() => {});
    }
    this.requestSync();
    return { messageId: msg.messageId, recipients: msg.rcpts.length };
  }

  /* Stores the draft in Gmail's Drafts folder, replacing the previous
   * copy, and returns its uid there.
   */
  async saveDraft(opts, replaceUid) {
    const box = this.special.drafts;
    if (!box || !this.user) {
      throw new Error('no drafts folder');
    }
    const built = buildMessage({ ...opts, from: this.user, allowEmpty: true });
    const data = built.data.replace(/\r?\n/g, '\r\n');
    const uid = await this.locked('cmd', async (c) => {
      const res = await c.command(`APPEND ${quote(box)} (\\Draft \\Seen) {${Buffer.byteLength(data, 'utf8')}+}\r\n${data}`);
      const m = /APPENDUID \d+ (\d+)/.exec(res.code || '');
      if (replaceUid) {
        await this.select(c, box);
        await c.command(`UID STORE ${replaceUid} +FLAGS.SILENT (\\Deleted)`);
        await c.command(`UID EXPUNGE ${replaceUid}`);
      }
      return m ? Number(m[1]) : 0;
    });
    const b = this.boxes.get(box);
    if (b && replaceUid) {
      b.messages.delete(replaceUid);
    }
    this.scheduleCounts(0);
    if (this.current === box) {
      this.selectBox(box);
    }
    return uid;
  }

  async deleteDraft(uid) {
    const box = this.special.drafts;
    await this.locked('cmd', async (c) => {
      await this.select(c, box);
      await c.command(`UID STORE ${uid} +FLAGS.SILENT (\\Deleted)`);
      await c.command(`UID EXPUNGE ${uid}`);
    });
    const b = this.boxes.get(box);
    if (b) {
      b.messages.delete(uid);
    }
    this.scheduleCounts(0);
    if (this.current === box) {
      this.selectBox(box);
    }
  }

  /* Marks every message in the folder as read in one store. */
  async readAll(mbox) {
    if (!this.folder(mbox)) {
      throw new Error('unknown folder');
    }
    const box = this.box(mbox);
    await this.locked('cmd', async (c) => {
      await this.select(c, mbox);
      if (box.exists > 0) {
        await c.command('UID STORE 1:* +FLAGS.SILENT (\\Seen)');
      }
      for (const m of box.messages.values()) {
        m.seen = true;
      }
    });
    this.threads.clear();
    const f = this.folder(mbox);
    if (f && f.countKind === 'unseen' && this.setCount(mbox, 0)) {
      this.emit('folders');
    }
    if (mbox === INBOX) {
      this.unread = 0;
      this.ctx.onBadge(this.svc.id, 0);
    }
    this.requestSync();
    return this.list();
  }
}

function registerMailIpc(ipcMain, accountFor, openExternal, pickFiles, files) {
  const picked = new Set();
  const uidList = (v) => (Array.isArray(v) ? v : [v]).map(Number).filter((n) => n > 0);
  ipcMain.handle('mail:status', guard(accountFor, (acc) => acc.status()));
  ipcMain.handle('mail:login', guard(accountFor, (acc, user, pass) => acc.login(String(user), String(pass))));
  ipcMain.handle('mail:logout', guard(accountFor, (acc) => {
    acc.logout();
    return acc.status();
  }));
  ipcMain.handle('mail:folders', guard(accountFor, (acc, refresh) => {
    if (refresh) {
      acc.scheduleCounts(0);
    }
    return acc.folderList();
  }));
  ipcMain.handle('mail:select', guard(accountFor, (acc, mbox) => acc.selectBox(String(mbox))));
  ipcMain.handle('mail:watch', guard(accountFor, (acc, paths) => acc.watch(Array.isArray(paths) ? paths : [])));
  ipcMain.handle('mail:list', guard(accountFor, (acc, more) => (more ? acc.more() : acc.list())));
  ipcMain.handle('mail:thread', guard(accountFor, (acc, thrid, fresh) => acc.thread(String(thrid), false, Boolean(fresh))));
  ipcMain.handle('mail:prefetch', guard(accountFor, (acc, thrids) => {
    acc.prefetch(Array.isArray(thrids) ? thrids.map(String) : []);
  }));
  ipcMain.handle('mail:message', guard(accountFor, (acc, mbox, uid) => acc.message(String(mbox), Number(uid))));
  ipcMain.handle('mail:search', guard(accountFor, (acc, query) => acc.search(String(query))));
  ipcMain.handle('mail:readAll', guard(accountFor, (acc, mbox) => acc.readAll(String(mbox))));
  const cleanMessage = (msg) => ({
    to: String((msg && msg.to) || ''),
    cc: String((msg && msg.cc) || ''),
    bcc: String((msg && msg.bcc) || ''),
    subject: String((msg && msg.subject) || ''),
    text: String((msg && msg.text) || ''),
    html: msg && msg.html ? String(msg.html) : '',
    inReplyTo: msg && msg.inReplyTo ? String(msg.inReplyTo) : '',
    references: msg && msg.references ? String(msg.references) : '',
    draftUid: Number(msg && msg.draftUid) || 0,
    attachments: Array.isArray(msg && msg.attachments)
      ? msg.attachments.filter((a) => a && picked.has(String(a.path)))
        .map((a) => ({ path: String(a.path), name: String(a.name || '') })) : [],
  });
  ipcMain.handle('mail:send', guard(accountFor, (acc, msg) => acc.send(cleanMessage(msg))));
  ipcMain.handle('mail:draftSave', guard(accountFor, (acc, msg) => acc.saveDraft(cleanMessage(msg), Number(msg && msg.draftUid) || 0)));
  ipcMain.handle('mail:draftDelete', guard(accountFor, (acc, uid) => acc.deleteDraft(Number(uid))));
  ipcMain.handle('mail:pickFiles', guard(accountFor, async () => {
    const list = await pickFiles();
    for (const f of list) {
      picked.add(f.path);
    }
    return list;
  }));
  ipcMain.handle('mail:download', guard(accountFor, (acc, mbox, uid, indexes, label) => acc.download(
    String(mbox), Number(uid),
    (Array.isArray(indexes) ? indexes : [indexes]).map(Number).filter((n) => Number.isInteger(n) && n >= 0),
    files.downloadDir(),
    String(label || 'attachment').slice(0, 120),
  )));
  ipcMain.on('mail:openFolder', guardOn(accountFor, (acc, dir) => {
    if (String(dir) === files.downloadDir()) {
      files.openPath(String(dir));
    }
  }));
  ipcMain.handle('mail:trust', guard(accountFor, (acc, email, on) => acc.setTrust(email, Boolean(on))));
  ipcMain.handle('mail:flag', guard(accountFor, (acc, mbox, uids, flags) => acc.flag(String(mbox), uidList(uids), flags || {})));
  ipcMain.handle('mail:move', guard(accountFor, (acc, mbox, uids, where) => {
    if (!MOVES.includes(where)) {
      throw new Error('bad move');
    }
    return acc.move(String(mbox), uidList(uids), where);
  }));
  ipcMain.on('mail:open', guardOn(accountFor, (acc, url) => {
    if (/^https:\/\/mail\.google\.com\//.test(String(url))) {
      openExternal(String(url));
    }
  }));
}

module.exports = { MailAccount, registerMailIpc, decodeUtf7, firstTextPart, makeSnippet };
