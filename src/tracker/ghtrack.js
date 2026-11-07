'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { safeStorage } = require('electron');
const config = require('../main/config');
const { keyringSecure } = require('../main/keyring');
const { guard, guardOn } = require('../main/ipc');

const POLL_MS = 10 * 60 * 1000;
const RETRY_MS = 2 * 60 * 1000;
const RETRY_MAX_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 60 * 1000;
const FETCH_DEADLINE_MS = 3 * 60 * 1000;
const MAX_BODY = 16 * 1024 * 1024;
const PAGE = 25;
const MAX_PAGES = 4;
const LIST_PAGES = 2;
const RETRY_5XX_MS = 3000;
const WINDOW_DAYS = 30;
const QUERY_MAX = 256;
const SEARCHES_MAX = 120;
const ERROR_MAX = 300;
const MERGED_MAX = 100;
const STATE_DIR = path.join(config.paths.state, 'gh');
const TOKENS_FILE = path.join(config.paths.state, 'gh-tokens.json');
const TOKEN_RE = /^[\x21-\x7e]{20,512}$/;
const GITHUB = 'https://github.com/';
const SNAP_FIELDS = ['draft', 'additions', 'deletions', 'changed_files', 'ci', 'mergeable', 'reviews'];

/* One search per role the user can have on a pull request. The two
 * activity roles and the merged list are bounded to the recent window.
 */
const ROLES = {
  author: { q: 'is:pr is:open author:%u', window: false },
  assignee: { q: 'is:pr is:open assignee:%u', window: false },
  requested: { q: 'is:pr is:open review-requested:%u', window: false },
  issues: { q: 'is:issue is:open assignee:%u', window: false },
  reviewed: { q: 'is:pr is:open reviewed-by:%u', window: true },
  commented: { q: 'is:pr is:open commenter:%u', window: true },
  merged: { q: 'is:pr is:merged author:%u', window: true },
};

const PR_FRAGMENT = `fragment pr on PullRequest {
  number title url isDraft mergeable merged mergedAt updatedAt createdAt
  additions deletions changedFiles reviewDecision baseRefName
  author { login }
  repository { nameWithOwner }
  assignees(first: 10) { nodes { login } }
  labels(first: 10) { nodes { name color } }
  reviewRequests(first: 20) { nodes { requestedReviewer {
    __typename ... on User { login } ... on Team { name } } } }
  latestReviews(first: 20) { nodes { author { login } state } }
  myReviews: reviews(author: $me, last: 1) { nodes { state } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  comments { totalCount }
}`;

const ISSUE_FRAGMENT = `fragment issue on Issue {
  number title url updatedAt createdAt
  author { login }
  repository { nameWithOwner }
  assignees(first: 10) { nodes { login } }
  labels(first: 10) { nodes { name color } }
  comments { totalCount }
}`;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const readTokens = () => readJson(TOKENS_FILE, {});
const writeTokens = (data) => writeJson(TOKENS_FILE, data);

/* Removes the stored token of one service, whether or not it runs. */
function forgetToken(id) {
  const all = readTokens();
  if (!all[id]) {
    return false;
  }
  delete all[id];
  writeTokens(all);
  return true;
}

class HttpError extends Error {
  constructor(status, headers, message) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

function graphql(token, query, variables) {
  const body = JSON.stringify({ query, variables });
  return new Promise((resolve, reject) => {
    const req = https.request('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        'User-Agent': 'appbox',
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: `bearer ${token}`,
      },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          req.destroy(new Error('response too large'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          let msg = `GitHub answered HTTP ${res.statusCode}`;
          try {
            msg = JSON.parse(text).message || msg;
          } catch {
            /* keep the status text */
          }
          reject(new HttpError(res.statusCode, res.headers, msg));
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch (err) {
          reject(new Error(`bad JSON from GitHub: ${err.message}`));
        }
      });
      res.on('error', reject);
    });
    req.setTimeout(FETCH_TIMEOUT_MS, () => req.destroy(new Error('timeout')));
    /* A trickling server cannot hold a request open for good. */
    const deadline = setTimeout(() => req.destroy(new Error('timeout')), FETCH_DEADLINE_MS);
    req.on('close', () => clearTimeout(deadline));
    req.on('error', reject);
    req.end(body);
  });
}

/* Repository qualifiers grouped so that each search query stays
 * within the length GitHub accepts.
 */
function repoChunks(repos, prefixLen) {
  const chunks = [];
  let cur = [];
  let len = prefixLen;
  for (const r of repos) {
    const add = ` repo:${r}`.length;
    if (cur.length > 0 && len + add > QUERY_MAX) {
      chunks.push(cur);
      cur = [];
      len = prefixLen;
    }
    cur.push(r);
    len += add;
  }
  if (cur.length > 0) {
    chunks.push(cur);
  }
  return chunks;
}

function windowDate() {
  return new Date(Date.now() - WINDOW_DAYS * 86400 * 1000).toISOString().slice(0, 10);
}

function labelsOf(node) {
  return ((node.labels && node.labels.nodes) || []).map((l) => ({ name: String(l.name || ''), color: String(l.color || '') }));
}

function ciState(node) {
  const c = node.commits && node.commits.nodes && node.commits.nodes[0];
  const roll = c && c.commit && c.commit.statusCheckRollup;
  return roll ? roll.state : null;
}

function ciFailed(pr) {
  return pr.ci === 'FAILURE' || pr.ci === 'ERROR';
}

function namesText(names) {
  return names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', ');
}

function snapshot(pr) {
  const out = {};
  for (const f of SNAP_FIELDS) {
    out[f] = pr[f];
  }
  return out;
}

class GhTracker extends EventEmitter {
  constructor(svc, ctx) {
    super();
    this.svc = svc;
    this.ctx = ctx;
    this.stateFile = path.join(STATE_DIR, `${svc.id}.json`);
    this.token = null;
    this.timer = null;
    this.stopped = false;
    this.loading = false;
    this.error = null;
    this.failures = 0;
    this.state = { seen: {}, snaps: {}, prs: {}, merged: {}, fetchedAt: 0, rateLimit: null };
  }

  get username() {
    return String(this.svc.username || '').trim();
  }

  get repos() {
    return Array.isArray(this.svc.repos) ? this.svc.repos : [];
  }

  get lists() {
    return Array.isArray(this.svc.lists) ? this.svc.lists : [];
  }

  setLists(raw) {
    const lists = config.normalizeLists(raw);
    this.ctx.patch(this.svc.id, { lists });
    if (this.token && !this.loading) {
      this.schedule(0);
    }
    return this.status();
  }

  init() {
    this.state = { ...this.state, ...readJson(this.stateFile, {}) };
    this.publishBadge();
    const entry = readTokens()[this.svc.id];
    if (!entry) {
      return;
    }
    if (!keyringSecure()) {
      /* The keyring is not up: keep the entry for the next start. */
      this.error = 'the keyring is not available, the stored token will be tried again at the next start';
      this.emit('status', this.status());
      return;
    }
    try {
      this.token = safeStorage.decryptString(Buffer.from(entry.secret, 'base64'));
    } catch {
      /* The keyring entry no longer decrypts: ask for the token again. */
      this.dropToken();
      this.error = 'the stored token could not be read, please sign in again';
      this.emit('status', this.status());
      return;
    }
    this.schedule(0);
  }

  stop() {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  forget() {
    this.logout();
    fs.rmSync(this.stateFile, { force: true });
  }

  dropToken() {
    this.token = null;
    forgetToken(this.svc.id);
  }

  async login(token) {
    const t = String(token || '').trim();
    if (!TOKEN_RE.test(t)) {
      throw new Error('Paste a GitHub personal access token');
    }
    if (!keyringSecure()) {
      throw new Error('no keyring available to store the token');
    }
    let res;
    try {
      res = await graphql(t, 'query { viewer { login } }', {});
    } catch (err) {
      throw new Error(err.status === 401 ? 'GitHub rejected the token' : err.message);
    }
    const login = res.data && res.data.viewer ? res.data.viewer.login : '';
    if (!login) {
      throw new Error('GitHub did not identify the token owner');
    }
    if (login.toLowerCase() !== this.username.toLowerCase()) {
      throw new Error(`The token belongs to @${login}, this app tracks @${this.username}`);
    }
    const all = readTokens();
    all[this.svc.id] = { secret: safeStorage.encryptString(t).toString('base64') };
    writeTokens(all);
    this.token = t;
    this.stopped = false;
    this.failures = 0;
    this.error = null;
    this.schedule(0);
    return this.status();
  }

  logout() {
    this.stop();
    this.dropToken();
    this.error = null;
    this.emit('status', this.status());
    return this.status();
  }

  schedule(ms) {
    if (this.stopped) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => this.poll(), ms);
  }

  refresh() {
    if (this.token) {
      this.schedule(0);
    }
    return this.status();
  }

  status() {
    let state = 'signed-out';
    if (this.token) {
      state = this.loading ? 'loading' : (this.error ? 'error' : 'idle');
    }
    return {
      state,
      error: this.error,
      username: this.username,
      repos: this.repos,
      fetchedAt: this.state.fetchedAt,
      rateLimit: this.state.rateLimit,
      keyring: keyringSecure(),
      window: WINDOW_DAYS,
      unread: this.unreadCount(),
      lists: this.lists,
      listErrors: this.state.listErrors || {},
    };
  }

  save() {
    try {
      writeJson(this.stateFile, this.state);
    } catch (err) {
      console.error(`${this.svc.id}: save state: ${err.message}`);
    }
  }

  /* The search queries of one poll, one per role and repository group. */
  searches() {
    const since = windowDate();
    const out = [];
    for (const [role, def] of Object.entries(ROLES)) {
      const base = `${def.q.replace('%u', this.username)}${def.window ? ` updated:>=${since}` : ''} sort:updated-desc`;
      for (const chunk of repoChunks(this.repos, base.length)) {
        out.push({ role, q: `${base}${chunk.map((r) => ` repo:${r}`).join('')}` });
      }
    }
    /* A custom list names its own repositories or inherits the tracked ones. */
    for (const l of this.lists) {
      const base = `${l.query} sort:updated-desc`;
      if (/(^|\s)(repo|org|user|owner):/i.test(l.query)) {
        out.push({ role: `list:${l.id}`, list: l.id, q: base });
        continue;
      }
      for (const chunk of repoChunks(this.repos, base.length)) {
        out.push({ role: `list:${l.id}`, list: l.id, q: `${base}${chunk.map((r) => ` repo:${r}`).join('')}` });
      }
    }
    return out;
  }

  /* One page per request: GitHub times out on large documents, and a
   * 5xx answer gets one more try.
   */
  async page(token, q, after) {
    const query = `query($q: String!, $after: String, $me: String!) {\nsearch(type: ISSUE, query: $q, first: ${PAGE}, after: $after) {\n`
      + 'pageInfo { hasNextPage endCursor } nodes { __typename ...pr ...issue } }\nrateLimit { remaining resetAt }\n}\n'
      + `${PR_FRAGMENT}\n${ISSUE_FRAGMENT}`;
    const variables = { q, after, me: this.username };
    let res;
    try {
      res = await graphql(token, query, variables);
    } catch (err) {
      if (!(err.status >= 500 && err.status < 600)) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_5XX_MS));
      res = await graphql(token, query, variables);
    }
    if (res.errors && res.errors.length > 0) {
      const err = new Error(res.errors.map((e) => e.message).join('; '));
      err.rateLimited = res.errors.some((e) => e.type === 'RATE_LIMITED');
      throw err;
    }
    return res.data;
  }

  async search(token, q, pages = MAX_PAGES) {
    const nodes = [];
    let after = null;
    let rateLimit = null;
    for (let i = 0; i < pages; i++) {
      const data = await this.page(token, q, after);
      const page = data.search || {};
      nodes.push(...(page.nodes || []));
      rateLimit = data.rateLimit || rateLimit;
      if (!page.pageInfo || !page.pageInfo.hasNextPage || this.token !== token) {
        break;
      }
      after = page.pageInfo.endCursor;
    }
    return { nodes, rateLimit };
  }

  async poll() {
    if (this.loading || this.stopped || !this.token) {
      return;
    }
    if (!this.username || this.repos.length === 0) {
      this.error = 'Set a GitHub user and at least one repository in the app properties';
      this.emit('status', this.status());
      return;
    }
    const searches = this.searches();
    if (searches.length > SEARCHES_MAX) {
      this.error = `Too many searches per refresh (${searches.length}, at most ${SEARCHES_MAX}): `
        + 'use fewer repositories or lists, or shorter list queries';
      this.emit('status', this.status());
      return;
    }
    this.loading = true;
    this.error = null;
    this.emit('status', this.status());
    /* The token in hand for this poll: a sign-out or a new sign-in
     * while it runs makes its outcome stale.
     */
    const token = this.token;
    let delay = POLL_MS;
    try {
      if (this.verified !== token) {
        /* The user name comes from the configuration: the token in the
         * keyring must belong to that user.
         */
        const res = await graphql(token, 'query { viewer { login } }', {});
        const login = res.data && res.data.viewer ? String(res.data.viewer.login || '') : '';
        if (login.toLowerCase() !== this.username.toLowerCase()) {
          throw new Error(`The token belongs to @${login}, this app tracks @${this.username}`);
        }
        this.verified = token;
      }
      const results = [];
      let rateLimit = null;
      const listErrors = {};
      for (const s of searches) {
        if (this.token !== token) {
          break;
        }
        let page;
        try {
          page = await this.search(token, s.q, s.list ? LIST_PAGES : MAX_PAGES);
        } catch (err) {
          /* A broken custom query is reported on its list, not on the poll. */
          if (!s.list || err.status || err.rateLimited) {
            throw err;
          }
          listErrors[s.list] = config.oneLine(err.message, ERROR_MAX);
          continue;
        }
        results.push({ role: s.role, list: s.list || null, nodes: page.nodes });
        rateLimit = page.rateLimit || rateLimit;
      }
      if (this.token === token) {
        this.state.listErrors = listErrors;
        this.ingest(results, rateLimit);
        this.state.fetchedAt = Date.now();
        this.failures = 0;
        this.save();
      }
    } catch (err) {
      if (this.token === token) {
        this.error = config.oneLine(err.message, ERROR_MAX);
        delay = this.backoff(err);
        console.error(`${this.svc.id}: ${err.message}`);
        if (err.status === 401) {
          this.dropToken();
          this.error = 'GitHub rejected the token, please sign in again';
          delay = 0;
        }
      }
    }
    this.loading = false;
    this.emit('status', this.status());
    if (this.token && this.token !== token) {
      this.schedule(0);
    } else if (this.token && delay > 0) {
      this.schedule(delay);
    }
  }

  /* Delay after a failure: the rate-limit reset when GitHub names one,
   * otherwise a doubling retry.
   */
  backoff(err) {
    const h = err.headers || {};
    let until = 0;
    if (h['retry-after']) {
      until = Date.now() + Number(h['retry-after']) * 1000;
    } else if (h['x-ratelimit-remaining'] === '0' && h['x-ratelimit-reset']) {
      until = Number(h['x-ratelimit-reset']) * 1000;
    } else if (err.rateLimited && this.state.rateLimit && this.state.rateLimit.resetAt) {
      until = new Date(this.state.rateLimit.resetAt).getTime();
    }
    if (until > Date.now()) {
      return Math.min(until - Date.now() + 5000, 60 * 60 * 1000);
    }
    this.failures++;
    return Math.min(RETRY_MS * 2 ** (this.failures - 1), RETRY_MAX_MS);
  }

  record(node) {
    const me = this.username.toLowerCase();
    const reviews = {};
    for (const r of (node.latestReviews && node.latestReviews.nodes) || []) {
      if (r.author && r.author.login) {
        reviews[r.author.login] = r.state;
      }
    }
    const requested = [];
    for (const r of (node.reviewRequests && node.reviewRequests.nodes) || []) {
      const who = r.requestedReviewer;
      if (who && (who.login || who.name)) {
        requested.push(who.login || `team ${who.name}`);
      }
    }
    const mine = ((node.myReviews && node.myReviews.nodes) || [])[0];
    const myReview = Object.keys(reviews).find((l) => l.toLowerCase() === me);
    return {
      kind: 'pr',
      labels: labelsOf(node),
      repo: node.repository.nameWithOwner,
      number: node.number,
      title: node.title,
      url: node.url,
      author: node.author ? node.author.login : '',
      base: node.baseRefName,
      draft: Boolean(node.isDraft),
      mergeable: node.mergeable,
      ci: ciState(node),
      decision: node.reviewDecision,
      assignees: ((node.assignees && node.assignees.nodes) || []).map((a) => a.login),
      requested,
      reviews,
      myReview: mine ? mine.state : (myReview ? reviews[myReview] : null),
      comments: node.comments ? node.comments.totalCount : 0,
      additions: node.additions,
      deletions: node.deletions,
      changed_files: node.changedFiles,
      created_at: node.createdAt,
      updated_at: node.updatedAt,
      merged_at: node.mergedAt,
    };
  }

  /* An issue takes the shape of a pull request row with its review and
   * build fields empty.
   */
  recordIssue(node) {
    return {
      kind: 'issue',
      labels: labelsOf(node),
      repo: node.repository.nameWithOwner,
      number: node.number,
      title: node.title,
      url: node.url,
      author: node.author ? node.author.login : '',
      base: '',
      draft: false,
      mergeable: null,
      ci: null,
      decision: null,
      assignees: ((node.assignees && node.assignees.nodes) || []).map((a) => a.login),
      requested: [],
      reviews: {},
      myReview: null,
      comments: node.comments ? node.comments.totalCount : 0,
      additions: 0,
      deletions: 0,
      changed_files: 0,
      created_at: node.createdAt,
      updated_at: node.updatedAt,
      merged_at: null,
    };
  }

  ingest(results, rateLimit) {
    const prs = {};
    const merged = {};
    for (const s of results) {
      for (const node of s.nodes) {
        if (!node || !node.repository) {
          continue;
        }
        const key = `${node.repository.nameWithOwner}#${node.number}`;
        if (s.role === 'merged') {
          merged[key] = merged[key] || this.record(node);
          continue;
        }
        if (node.merged) {
          continue;
        }
        const pr = prs[key] || {
          ...(node.__typename === 'Issue' ? this.recordIssue(node) : this.record(node)), flags: {}, lists: {},
        };
        if (s.list) {
          pr.lists[s.list] = true;
        } else {
          pr.flags[s.role] = true;
        }
        prs[key] = pr;
      }
    }
    const firstRun = !this.state.fetchedAt;
    const before = new Set(this.actionKeys());
    const mergedBefore = this.state.merged || {};
    const trimmed = Object.entries(merged)
      .sort((a, b) => (a[1].merged_at < b[1].merged_at ? 1 : -1))
      .slice(0, MERGED_MAX);
    const seen = {};
    const snaps = {};
    for (const key of Object.keys(prs)) {
      if (firstRun) {
        seen[key] = prs[key].updated_at;
      } else if (this.state.seen[key]) {
        seen[key] = this.state.seen[key];
      }
      if (this.state.snaps[key]) {
        snaps[key] = this.state.snaps[key];
      } else if (seen[key] && seen[key] >= prs[key].updated_at) {
        snaps[key] = snapshot(prs[key]);
      }
    }
    for (const [key, m] of trimmed) {
      if (firstRun) {
        seen[key] = m.merged_at;
      } else if (this.state.seen[key]) {
        seen[key] = this.state.seen[key];
      }
    }
    this.state.prs = prs;
    this.state.merged = Object.fromEntries(trimmed);
    this.state.seen = seen;
    this.state.snaps = snaps;
    this.state.rateLimit = rateLimit;
    if (!firstRun) {
      this.announce(before);
      this.announceMerged(trimmed.filter(([key]) => !mergedBefore[key]).map(([, m]) => m));
    }
    this.publishBadge();
    this.emit('data');
  }

  isUnread(key, stamp) {
    const s = this.state.seen[key];
    return !s || s < stamp;
  }

  /* Pull requests waiting on the user's review: an assignment without
   * a review from them yet, a request that came after their review, or
   * a request on a repository that does not hand out assignees.
   * Projects that assign every pull request also request reviews in
   * bulk, so a first request alone does not count there.
   */
  needsAction(pr) {
    if (pr.kind === 'issue' || pr.flags.author || pr.draft) {
      return false;
    }
    if (pr.myReview) {
      return Boolean(pr.flags.requested);
    }
    if (pr.flags.assignee) {
      return true;
    }
    return Boolean(pr.flags.requested) && pr.assignees.length === 0;
  }

  actionKeys() {
    return Object.keys(this.state.prs).filter((k) => this.needsAction(this.state.prs[k]));
  }

  changes(key, pr) {
    const base = this.state.snaps[key];
    if (!base) {
      return null;
    }
    const out = [];
    if (base.draft && !pr.draft) {
      out.push({ kind: 'draft', text: 'ready for review', tone: 'me' });
    } else if (!base.draft && pr.draft) {
      out.push({ kind: 'draft', text: 'back to draft' });
    }
    if (base.additions !== pr.additions || base.deletions !== pr.deletions || base.changed_files !== pr.changed_files) {
      out.push({ kind: 'push', text: 'new push', tone: 'me' });
    }
    const approvers = [];
    const blockers = [];
    for (const [name, state] of Object.entries(pr.reviews)) {
      if (name.toLowerCase() === this.username.toLowerCase() || (base.reviews || {})[name] === state) {
        continue;
      }
      if (state === 'APPROVED') {
        approvers.push(name);
      } else if (state === 'CHANGES_REQUESTED') {
        blockers.push(name);
      }
    }
    if (blockers.length > 0) {
      out.push({ kind: 'review', text: `changes requested by ${namesText(blockers)}`, tone: 'err' });
    }
    if (approvers.length > 0) {
      out.push({ kind: 'review', text: `approved by ${namesText(approvers)}`, tone: 'ok' });
    }
    if (ciFailed(pr) && !ciFailed(base)) {
      out.push({ kind: 'ci', text: 'CI failed', tone: 'err' });
    } else if (pr.ci === 'SUCCESS' && ciFailed(base)) {
      out.push({ kind: 'ci', text: 'CI fixed', tone: 'ok' });
    }
    if (pr.mergeable === 'CONFLICTING' && base.mergeable !== 'CONFLICTING') {
      out.push({ kind: 'conflicts', text: 'conflicts', tone: 'warn' });
    }
    if (out.length === 0) {
      out.push({ kind: 'activity', text: 'new activity', tone: 'me' });
    }
    return out;
  }

  /* Whose move it is: the user's when something blocks their own pull
   * request or a review is waiting on them, everyone else's otherwise.
   */
  turn(pr) {
    if (pr.kind === 'issue') {
      return pr.flags.issues ? { turn: 'mine', why: 'issue' } : { turn: null, why: null };
    }
    if (pr.flags.author) {
      if (ciFailed(pr)) {
        return { turn: 'mine', why: 'ci' };
      }
      if (pr.mergeable === 'CONFLICTING') {
        return { turn: 'mine', why: 'conflicts' };
      }
      if (pr.decision === 'CHANGES_REQUESTED' || Object.values(pr.reviews).includes('CHANGES_REQUESTED')) {
        return { turn: 'mine', why: 'changes' };
      }
      return { turn: 'theirs', why: null };
    }
    if (this.needsAction(pr)) {
      return { turn: 'mine', why: 'review' };
    }
    return { turn: 'theirs', why: null };
  }

  rows() {
    const out = [];
    for (const [key, pr] of Object.entries(this.state.prs)) {
      const unread = this.isUnread(key, pr.updated_at);
      const { turn, why } = this.turn(pr);
      out.push({
        ...pr,
        kind: pr.kind || 'pr',
        labels: pr.labels || [],
        lists: pr.lists || {},
        key,
        unread,
        changes: unread ? this.changes(key, pr) : null,
        turn,
        why,
        action: this.needsAction(pr),
        merged: false,
      });
    }
    for (const [key, m] of Object.entries(this.state.merged || {})) {
      out.push({
        ...m,
        kind: 'pr',
        labels: m.labels || [],
        lists: {},
        key,
        updated_at: m.merged_at || m.updated_at,
        unread: this.isUnread(key, m.merged_at),
        changes: null,
        turn: null,
        why: null,
        action: false,
        merged: true,
        flags: { author: true },
      });
    }
    return out;
  }

  data() {
    return { status: this.status(), rows: this.rows() };
  }

  unreadCount() {
    let n = 0;
    for (const [key, pr] of Object.entries(this.state.prs)) {
      const unread = this.isUnread(key, pr.updated_at);
      if (unread && this.turn(pr).turn === 'mine') {
        n++;
      }
    }
    for (const [key, m] of Object.entries(this.state.merged || {})) {
      if (this.isUnread(key, m.merged_at)) {
        n++;
      }
    }
    return n;
  }

  publishBadge() {
    this.ctx.onBadge(this.svc.id, this.unreadCount());
  }

  announce(before) {
    if (!this.svc.notifications) {
      return;
    }
    const fresh = this.actionKeys().filter((k) => !before.has(k));
    if (fresh.length === 0) {
      return;
    }
    const first = this.state.prs[fresh[0]];
    this.ctx.notify({
      title: fresh.length === 1 ? 'PR waiting for your review' : `${fresh.length} PRs waiting for your review`,
      body: fresh.length === 1 ? first.title : `${first.title} and ${fresh.length - 1} more`,
      onClick: () => this.ctx.activate(this.svc.id),
    });
  }

  announceMerged(entries) {
    if (!this.svc.notifications || entries.length === 0) {
      return;
    }
    const first = entries[0];
    this.ctx.notify({
      title: entries.length === 1 ? 'Pull request merged' : `${entries.length} pull requests merged`,
      body: entries.length === 1 ? first.title : `${first.title} and ${entries.length - 1} more`,
      onClick: () => this.ctx.activate(this.svc.id),
    });
  }

  markSeen(keys) {
    let changed = false;
    for (const key of keys) {
      const pr = this.state.prs[key];
      const m = (this.state.merged || {})[key];
      const stamp = pr ? pr.updated_at : (m ? m.merged_at : null);
      if (stamp && this.state.seen[key] !== stamp) {
        this.state.seen[key] = stamp;
        changed = true;
        if (pr) {
          this.state.snaps[key] = snapshot(pr);
        }
      }
    }
    if (changed) {
      this.save();
      this.publishBadge();
      this.emit('data');
    }
    return changed;
  }

  markAllSeen() {
    return this.markSeen([...Object.keys(this.state.prs), ...Object.keys(this.state.merged || {})]);
  }

  openUrl(url) {
    return url.startsWith(GITHUB);
  }
}

function registerGhIpc(ipcMain, trackerFor, openExternal) {
  const keyList = (v) => (Array.isArray(v) ? v : [v]).map(String).slice(0, 10000);
  ipcMain.handle('gh:status', guard(trackerFor, (t) => t.status()));
  ipcMain.handle('gh:data', guard(trackerFor, (t) => t.data()));
  ipcMain.handle('gh:refresh', guard(trackerFor, (t) => t.refresh()));
  ipcMain.handle('gh:login', guard(trackerFor, (t, token) => t.login(String(token || ''))));
  ipcMain.handle('gh:logout', guard(trackerFor, (t) => t.logout()));
  ipcMain.handle('gh:seen', guard(trackerFor, (t, keys) => t.markSeen(keyList(keys))));
  ipcMain.handle('gh:seenAll', guard(trackerFor, (t) => t.markAllSeen()));
  ipcMain.handle('gh:lists', guard(trackerFor, (t, lists) => t.setLists(lists)));
  ipcMain.on('gh:open', guardOn(trackerFor, (t, url) => {
    if (t.openUrl(String(url))) {
      openExternal(String(url));
    }
  }));
}

module.exports = { GhTracker, registerGhIpc, forgetToken };
