'use strict';

const { BrowserWindow, WebContentsView, desktopCapturer, shell, webContents } = require('electron');
const fs = require('fs');
const path = require('path');
const { hostOf, ASKED_PERMISSIONS, downloadDir } = require('./config');
const { colors } = require('./theme');

const PRELOAD = path.join(__dirname, 'preload-service.js');
const PAGES = path.join(__dirname, '..', 'pages');
const BUILTIN = {
  gmail: { preload: path.join(PAGES, 'mail', 'preload.js'), page: path.join(PAGES, 'mail', 'mail.html') },
  'github-tracker': { preload: path.join(PAGES, 'gh', 'preload.js'), page: path.join(PAGES, 'gh', 'gh.html') },
};
const BADGE_RE = /\((\d+)\)/;
const LEAVE_MIN_MS = 1000;
const OPEN_WINDOWS_MAX = 6;
const DOWNLOADS_MAX = 4;
const DOWNLOAD_WINDOW_MS = 60000;
const DOWNLOAD_RATE_MAX = 10;
const DOWNLOAD_NAME_MAX = 200;

const configuredPartitions = new Set();
/* The service behind each web contents: its view, popups and windows. */
const owners = new WeakMap();
const partitionViews = new Map();
const savingTo = new Set();
const ICON_WORLD = 999;

const ICON_SCAN = `(() => [...document.querySelectorAll('link[rel]')]
  .filter((l) => /icon/i.test(l.rel) && !/mask-icon/i.test(l.rel))
  .slice(0, 50)
  .map((l) => ({
    href: String(l.href).slice(0, 2048),
    rel: String(l.rel).slice(0, 100),
    sizes: String(l.getAttribute('sizes') || '').slice(0, 100),
    type: String(l.type || '').slice(0, 100),
  })))()`;

function stripUserAgent(ua) {
  return ua.replace(/\s?\bElectron\/\S+/, '').replace(/\s?\bAppbox\/\S+/, '');
}

function hostMatches(host, patterns) {
  return patterns.some((p) => {
    if (p.startsWith('*.')) {
      const base = p.slice(2);
      return host === base || host.endsWith(p.slice(1));
    }
    return host === p;
  });
}

function openExternal(url) {
  if (/^(https?|mailto):/i.test(url)) {
    shell.openExternal(url);
  }
}

/* Plain http stays inside the app only for a service configured with
 * an http address.
 */
function allowedScheme(svc, url) {
  return /^https:/i.test(url) || (/^http:/i.test(url) && /^http:/i.test(svc.url));
}

function allowedHost(svc, settings, url) {
  const host = hostOf(url);
  return host !== '' && allowedScheme(svc, url)
    && (hostMatches(host, svc.hosts) || hostMatches(host, settings.authHosts));
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/* Permissions the user is asked for are never granted to the sign-in
 * hosts, only to the service's own.
 */
function allowedPermission(svc, settings, permission, origin) {
  if (!svc.permissions.includes(permission) || !allowedHost(svc, settings, origin)) {
    return false;
  }
  return !ASKED_PERMISSIONS.includes(permission) || hostMatches(hostOf(origin), svc.hosts);
}

function parseBadge(svc, title) {
  if (svc.badge === 'none') {
    return 0;
  }
  const re = svc.badgeRegex ? new RegExp(svc.badgeRegex) : BADGE_RE;
  const m = title.slice(0, 120).match(re);
  if (m) {
    return Math.min(9999, Number(m[1]) || 0);
  }
  return /^[*\u2022\u25cf]/.test(title.trim()) ? 'dot' : 0;
}

function resetPartition(name) {
  configuredPartitions.delete(name);
}

function contentsOfFrame(frame) {
  try {
    return frame ? webContents.fromFrame(frame) : null;
  } catch {
    return null;
  }
}

/* A free name in the download folder: the download's own name, never
 * hidden, never replacing a file already there.
 */
function downloadTarget(dir, suggested) {
  const name = path.basename(String(suggested || '')).replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^\.+/, '').trim() || 'download';
  const ext = path.extname(name).slice(0, 20);
  const stem = name.slice(0, name.length - ext.length).slice(0, DOWNLOAD_NAME_MAX - ext.length) || 'download';
  fs.mkdirSync(dir, { recursive: true });
  for (let n = 0; n < 1000; n++) {
    const file = path.join(dir, n === 0 ? `${stem}${ext}` : `${stem} (${n})${ext}`);
    if (!savingTo.has(file) && !fs.existsSync(file)) {
      savingTo.add(file);
      return file;
    }
  }
  throw new Error('no free file name');
}

/* The handlers look the service up from the requesting web contents on
 * each call, so a reloaded configuration applies at once and services
 * sharing a partition each get their own settings. Permissions the user
 * must agree to are asked once per service and origin and remembered.
 * Native notifications are left to the page's shim: frames and workers
 * get none.
 */
function setupSession(ses, view) {
  const { svc, ctx } = view;
  const { partition } = svc;
  if (configuredPartitions.has(partition)) {
    return;
  }
  configuredPartitions.add(partition);

  ses.setUserAgent(svc.userAgent || ctx.userAgent);
  ses.setSpellCheckerLanguages(ctx.settings.spellcheckLanguages);

  const owner = (wc) => {
    const v = wc ? owners.get(wc) : undefined;
    if (v) {
      return v;
    }
    const live = partitionViews.get(partition);
    return live && live.size > 0 ? live.values().next().value : view;
  };
  const allowed = (s, permission, url, details) => {
    if (permission === 'notifications' && (!s.notifications || !details || details.isMainFrame === false)) {
      return false;
    }
    if (ASKED_PERMISSIONS.includes(permission) && details && details.isMainFrame === false) {
      return false;
    }
    return allowedPermission(s, ctx.settings, permission, url);
  };
  ses.setPermissionRequestHandler(async (wc, permission, callback, details) => {
    const s = owner(wc).svc;
    const url = details.requestingUrl || '';
    if (!allowed(s, permission, url, details)) {
      callback(false);
      return;
    }
    if (ASKED_PERMISSIONS.includes(permission)) {
      callback(await ctx.askPermission(s, permission, originOf(url)));
      return;
    }
    callback(true);
  });
  ses.setPermissionCheckHandler((wc, permission, origin, details) => {
    const s = owner(wc).svc;
    const url = (details && details.requestingUrl) || origin;
    return allowed(s, permission, url, details)
      && (!ASKED_PERMISSIONS.includes(permission) || ctx.permissionGranted(s, permission, originOf(url)));
  });
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    const s = owner(contentsOfFrame(request.frame)).svc;
    const origin = request.securityOrigin || '';
    const details = { isMainFrame: !request.frame || request.frame.parent === null };
    if (!allowed(s, 'display-capture', origin, details)
        || !(await ctx.askPermission(s, 'display-capture', originOf(origin)))) {
      callback({});
      return;
    }
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 0, height: 0 },
    });
    const source = await ctx.pickSource(s, sources);
    callback(source ? { video: source } : {});
  }, { useSystemPicker: true });
  /* Downloads land in the download folder without a dialog, a few at a
   * time per service.
   */
  ses.on('will-download', (e, item, wc) => {
    const v = owner(wc);
    const now = Date.now();
    v.downloadTimes = v.downloadTimes.filter((t) => now - t < DOWNLOAD_WINDOW_MS);
    if (v.downloads >= DOWNLOADS_MAX || v.downloadTimes.length >= DOWNLOAD_RATE_MAX) {
      e.preventDefault();
      return;
    }
    let target;
    try {
      target = downloadTarget(downloadDir(ctx.settings), item.getFilename());
    } catch (err) {
      console.error(`${v.svc.id}: download refused: ${err.message}`);
      e.preventDefault();
      return;
    }
    v.downloads++;
    v.downloadTimes.push(now);
    item.setSavePath(target);
    item.once('done', (ev, status) => {
      v.downloads--;
      savingTo.delete(target);
      if (status === 'completed') {
        try {
          fs.chmodSync(target, fs.statSync(target).mode & 0o666);
        } catch {
          /* already gone */
        }
      }
    });
  });
}

class ServiceView {
  constructor(svc, ctx) {
    this.svc = svc;
    this.ctx = ctx;
    this.view = null;
    this.visible = false;
    this.sleeping = false;
    this.timer = null;
    this.crashes = 0;
    this.leftAt = 0;
    this.openWindows = 0;
    this.downloads = 0;
    this.downloadTimes = [];
  }

  /* At most one link a second reaches the browser or another window. */
  rateLimited() {
    const now = Date.now();
    if (now - this.leftAt < LEAVE_MIN_MS) {
      return true;
    }
    this.leftAt = now;
    return false;
  }

  /* Secondary windows share the window budget and name their host in
   * the title (a window without one names its opener and nothing
   * else), and a page in them cannot refuse to be closed.
   */
  trackWindow(win, url, opener) {
    this.openWindows++;
    win.on('closed', () => {
      this.openWindows--;
    });
    win.setMenuBarVisibility(false);
    const wc = win.webContents;
    owners.set(wc, this);
    const titled = (title) => {
      const host = hostOf(wc.getURL()) || hostOf(url);
      return host ? `${host} - ${title || ''}`.replace(/ - $/, '') : opener;
    };
    win.setTitle(titled(wc.getTitle()));
    wc.on('page-title-updated', (e, title) => {
      e.preventDefault();
      win.setTitle(titled(title));
    });
    wc.on('did-navigate', () => win.setTitle(titled(wc.getTitle())));
    wc.on('will-attach-webview', (e) => e.preventDefault());
    wc.on('will-prevent-unload', (e) => e.preventDefault());
  }

  get wc() {
    return this.view ? this.view.webContents : null;
  }

  get builtin() {
    return BUILTIN[this.svc.type] || null;
  }

  create() {
    const view = new WebContentsView({
      webPreferences: {
        partition: `persist:${this.svc.partition}`,
        preload: this.builtin ? this.builtin.preload : PRELOAD,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        spellcheck: true,
        autoplayPolicy: 'no-user-gesture-required',
        backgroundThrottling: true,
      },
    });
    view.setBackgroundColor(colors().bg);
    this.view = view;
    this.sleeping = false;

    const wc = view.webContents;
    owners.set(wc, this);
    if (!partitionViews.has(this.svc.partition)) {
      partitionViews.set(this.svc.partition, new Set());
    }
    partitionViews.get(this.svc.partition).add(this);
    setupSession(wc.session, this);
    wc.setUserAgent(this.svc.userAgent || this.ctx.userAgent);
    this.wire(wc);

    this.ctx.win.contentView.addChildView(view);
    this.ctx.onViewAdded();
    view.setVisible(this.visible);
    view.setBounds(this.ctx.viewBounds());
    wc.setAudioMuted(!this.svc.sounds);
    if (this.builtin) {
      wc.loadFile(this.builtin.page);
    } else {
      wc.loadURL(this.svc.url);
    }
  }

  setSounds(enabled) {
    this.svc.sounds = enabled;
    if (this.wc) {
      this.wc.setAudioMuted(!enabled);
    }
  }

  applyForceDark(wc) {
    if (!this.svc.forceDark) {
      return;
    }
    try {
      if (!wc.debugger.isAttached()) {
        wc.debugger.attach('1.3');
      }
      wc.debugger.sendCommand('Emulation.setAutoDarkModeOverride', { enabled: true })
        .catch((err) => console.error(`${this.svc.id}: forceDark: ${err.message}`));
    } catch (err) {
      console.error(`${this.svc.id}: forceDark attach: ${err.message}`);
    }
  }

  /* Opens an outside link in a plain window that shares the service
   * session, for services whose links setting is "window". The title
   * always names the host, since the window has no address bar.
   */
  openWindow(url) {
    if (!/^https?:/i.test(url)) {
      openExternal(url);
      return;
    }
    if (this.openWindows >= OPEN_WINDOWS_MAX) {
      return;
    }
    const win = new BrowserWindow({
      width: 1100,
      height: 800,
      title: hostOf(url),
      autoHideMenuBar: true,
      backgroundColor: colors().bg,
      webPreferences: {
        partition: `persist:${this.svc.partition}`,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    this.trackWindow(win, url, hostOf(url));
    const wc = win.webContents;
    const guard = (e, next) => {
      if (!/^https?:/i.test(next)) {
        e.preventDefault();
      }
    };
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);
    wc.setWindowOpenHandler(({ url: next }) => {
      if (!this.rateLimited()) {
        this.openWindow(next);
      }
      return { action: 'deny' };
    });
    win.loadURL(url);
  }

  /* A sign-in that left for a popup of the app's own page comes back
   * there: when such a popup lands under the app's address while the
   * app is still away on a sign-in host, the app loads it and the popup
   * closes. Built-in pages never navigate.
   */
  reclaim(contents) {
    return (e, url) => {
      if (this.builtin || !this.wc || this.wc.isDestroyed() || !/^https:/i.test(url)) {
        return;
      }
      const { hosts } = this.svc;
      const { authHosts } = this.ctx.settings;
      const home = new URL(this.svc.url);
      const from = hostOf(contents.getURL());
      if (!url.startsWith(home.origin + home.pathname) || hostMatches(hostOf(this.wc.getURL()), hosts)
          || !(hostMatches(from, hosts) || hostMatches(from, authHosts))) {
        return;
      }
      e.preventDefault();
      this.wc.loadURL(url);
      contents.close();
    };
  }

  /* Only a visible app in the focused window hands a link to the
   * outside, at most once a second, so a page cannot spam the browser.
   */
  leave(url) {
    if (!this.visible || !this.ctx.win.isFocused() || this.rateLimited()) {
      return;
    }
    if (this.svc.links === 'window') {
      this.openWindow(url);
    } else {
      openExternal(url);
    }
  }

  wire(wc) {
    const { svc, ctx } = this;
    /* Only the service's own hosts and the sign-in hosts load inside the
     * app. Everything else opens outside. Built-in pages never navigate,
     * and a server redirect out of the app is dropped without opening.
     */
    const inApp = (url) => !this.builtin && (url === 'about:blank' || allowedHost(this.svc, ctx.settings, url));
    const policy = (contents, closeOnLeave, fromView) => {
      const back = fromView ? this.reclaim(contents) : () => {};
      const guard = (open) => (e, url) => {
        back(e, url);
        if (e.defaultPrevented) {
          return;
        }
        if (!inApp(url)) {
          e.preventDefault();
          if (open) {
            this.leave(url);
          }
          if (closeOnLeave) {
            contents.close();
          }
        }
      };
      contents.on('will-navigate', guard(true));
      contents.on('will-redirect', guard(false));
      contents.setWindowOpenHandler(({ url }) => {
        if (inApp(url)) {
          if (this.openWindows >= OPEN_WINDOWS_MAX) {
            return { action: 'deny' };
          }
          return {
            action: 'allow',
            overrideBrowserWindowOptions: {
              width: 620,
              height: 780,
              autoHideMenuBar: true,
              backgroundColor: colors().bg,
              webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
            },
          };
        }
        this.leave(url);
        return { action: 'deny' };
      });
      contents.on('did-create-window', (child, details) => {
        this.trackWindow(child, details.url, hostOf(contents.getURL()) || hostOf(this.svc.url));
        policy(child.webContents, true, contents === wc);
      });
    };
    policy(wc, false, false);
    wc.on('will-prevent-unload', (e) => e.preventDefault());

    if (!this.builtin) {
      wc.on('page-title-updated', (e, title) => ctx.onBadge(svc.id, parseBadge(svc, title)));
    }
    wc.on('page-favicon-updated', (e, favicons) => {
      if (favicons.length > 0 && hostMatches(hostOf(wc.getURL()), this.svc.hosts)) {
        ctx.onFavicon(svc.id, favicons[0]);
      }
    });
    const scanIcons = () => {
      if (!hostMatches(hostOf(wc.getURL()), this.svc.hosts)) {
        return;
      }
      wc.executeJavaScriptInIsolatedWorld(ICON_WORLD, [{ code: ICON_SCAN }], false)
        .then((links) => ctx.onIcons(svc.id, links))
        .catch(() => {});
    };
    wc.on('dom-ready', scanIcons);
    wc.on('did-finish-load', () => setTimeout(() => this.wc === wc && scanIcons(), 2000));
    wc.on('before-input-event', ctx.handleInput);
    wc.on('update-target-url', (e, url) => ctx.onStatus(svc.id, { target: url }));
    wc.on('did-start-loading', () => ctx.onStatus(svc.id, { loading: true }));
    wc.on('did-stop-loading', () => ctx.onStatus(svc.id, { loading: false, url: wc.getURL() }));
    wc.on('did-navigate', (e, url) => ctx.onStatus(svc.id, { url }));
    wc.on('did-navigate-in-page', (e, url) => ctx.onStatus(svc.id, { url }));
    wc.on('dom-ready', () => this.applyForceDark(wc));
    /* Chromium keeps zoom per host and the apps hop hosts while signing
     * in, so the service level is re-applied on every navigation.
     */
    const applyZoom = () => {
      if (!wc.isDestroyed()) {
        wc.setZoomLevel(ctx.zoomLevel(svc.id));
      }
    };
    wc.on('did-navigate', applyZoom);
    wc.on('dom-ready', applyZoom);
    wc.on('did-finish-load', applyZoom);
    wc.on('render-process-gone', (e, details) => {
      console.error(`${svc.id}: renderer gone (${details.reason})`);
      if (details.reason !== 'clean-exit' && this.crashes++ < 3) {
        setTimeout(() => this.view && wc.reload(), 2000);
      }
    });
  }

  setVisible(visible) {
    this.visible = visible;
    if (this.view) {
      this.view.setVisible(visible);
    }
  }

  /* Hide the native view without changing which service is active. */
  suspend(hidden) {
    if (this.view) {
      this.view.setVisible(!hidden && this.visible);
    }
  }

  async snapshot() {
    if (!this.wc || !this.visible) {
      return null;
    }
    const dbg = this.wc.debugger;
    const attachedBefore = dbg.isAttached();
    try {
      if (!attachedBefore) {
        dbg.attach('1.3');
      }
      const { data } = await dbg.sendCommand('Page.captureScreenshot', {
        format: 'jpeg', quality: 80,
      });
      return `data:image/jpeg;base64,${data}`;
    } catch (err) {
      console.error(`${this.svc.id}: snapshot failed: ${err.message}`);
      return null;
    } finally {
      if (!attachedBefore && dbg.isAttached()) {
        dbg.detach();
      }
    }
  }

  setBounds(bounds) {
    if (this.view) {
      this.view.setBounds(bounds);
    }
  }

  focus() {
    if (this.wc) {
      this.wc.focus();
    }
  }

  reload() {
    if (this.sleeping) {
      this.wake();
    } else if (this.wc) {
      this.wc.reload();
    }
  }

  armSleep() {
    this.cancelSleep();
    if (this.svc.sleep.enabled && !this.sleeping) {
      this.timer = setTimeout(() => this.sleep(), this.svc.sleep.minutes * 60000);
    }
  }

  cancelSleep() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  sleep() {
    this.cancelSleep();
    if (!this.view) {
      return;
    }
    this.destroyView();
    this.sleeping = true;
    this.ctx.onBadge(this.svc.id, 0);
    this.ctx.onSleepChange();
  }

  wake() {
    if (this.sleeping) {
      this.create();
      this.ctx.onSleepChange();
    }
  }

  destroyView() {
    const view = this.view;
    this.view = null;
    const live = partitionViews.get(this.svc.partition);
    if (live) {
      live.delete(this);
    }
    this.ctx.win.contentView.removeChildView(view);
    try {
      view.webContents.close();
    } catch (err) {
      console.error(`${this.svc.id}: close failed, blanking: ${err.message}`);
      view.webContents.loadURL('about:blank');
    }
  }

  destroy() {
    this.cancelSleep();
    if (this.view) {
      this.destroyView();
    }
  }
}

module.exports = { ServiceView, stripUserAgent, openExternal, resetPartition };
