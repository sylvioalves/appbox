'use strict';

const os = require('os');
const path = require('path');
const nodeModule = require('module');

nodeModule.enableCompileCache(
  path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'appbox', 'compile'),
);

const {
  app, BrowserWindow, Menu, Tray, Notification, WebContentsView, dialog, ipcMain, nativeImage, nativeTheme, session,
  safeStorage, shell,
} = require('electron');
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const config = require('./config');
const catalog = require('./catalog');
const { ServiceView, stripUserAgent, resetPartition, openExternal } = require('./views');
const { MailAccount, registerMailIpc } = require('../mail/gmail');
const { GhTracker, registerGhIpc, forgetToken } = require('../tracker/ghtrack');
const profile = require('./profile');
const { colors } = require('./theme');
const { guard, guardOn } = require('./ipc');
const { handleCli } = require('./cli');
const { createProfileDialogs } = require('./profile-dialogs');

const REBUILD_KEYS = ['enabled', 'url', 'partition', 'userAgent', 'forceDark', 'hosts', 'permissions', 'username', 'repos'];
const PROP_KEYS = {
  enabled: 'boolean',
  name: 'string',
  url: 'string',
  color: 'string',
  notifications: 'boolean',
  sounds: 'boolean',
  forceDark: 'boolean',
  userAgent: 'string',
  links: 'string',
  startup: 'string',
  zoom: 'number',
  username: 'string',
  repos: 'string',
  sleep: 'object',
};
const LINK_MODES = ['external', 'window'];
const STARTUP_MODES = ['load', 'lazy'];

const ASSETS = path.join(__dirname, '..', '..', 'assets');
const PAGES = path.join(__dirname, '..', 'pages');
const APP_ICON = path.join(ASSETS, 'appbox.png');
const TITLEBAR_H = 36;
const STATUSBAR_H = 22;
const DISK_CACHE_BYTES = 64 * 1024 * 1024;
const CACHE_PURGE_MS = 7 * 24 * 60 * 60 * 1000;
const USAGE_MS = 2000;
const NOTIFY_WINDOW_MS = 10000;
const NOTIFY_MAX = 8;
const PERMISSION_TEXT = {
  media: 'use your camera and microphone',
  'display-capture': 'share your screen',
  'clipboard-read': 'read your clipboard',
  geolocation: 'know your location',
};

app.setName('Appbox');
app.setDesktopName(`${config.APP_ID}.desktop`);
process.title = 'appbox';
app.setPath('userData', config.paths.data);
app.setPath('sessionData', config.paths.data);
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
/* Window class and Wayland app id, so the desktop matches the desktop
 * file for the dock icon.
 */
app.commandLine.appendSwitch('class', config.APP_ID);
app.commandLine.appendSwitch('disable-smooth-scrolling');
app.commandLine.appendSwitch('disk-cache-size', String(DISK_CACHE_BYTES));
app.commandLine.appendSwitch('enable-features', 'WaylandWindowDecorations,WebRTCPipeWireCapturer');
app.userAgentFallback = stripUserAgent(app.userAgentFallback);

/* Hardware acceleration can only be turned off before the app is ready. */
let hwAccelAtStart = true;
try {
  hwAccelAtStart = config.load().settings.hardwareAcceleration !== false;
} catch {
  /* reported when the config is loaded for real */
}
if (!hwAccelAtStart) {
  app.disableHardwareAcceleration();
}

let cfg;
let state;
let win = null;
let tray = null;
let propsWin = null;
let settingsWin = null;
let addWin = null;
let welcomeView = null;
const SETTINGS_MENU = '__settings';

/* Every web contents: no <webview>. The app's own pages: no navigation
 * and no popups.
 */
app.on('web-contents-created', (e, contents) => {
  contents.on('will-attach-webview', (ev) => ev.preventDefault());
});
/* A client certificate from the user's store is never offered on its own. */
app.on('select-client-certificate', (e, wc, url, list, cb) => {
  e.preventDefault();
  cb();
});

/* Service ids index the state maps, so only own entries count. */
const own = (o, k) => (o && Object.hasOwn(o, k) ? o[k] : undefined);

function lockPage(wc) {
  wc.on('will-navigate', (ev) => ev.preventDefault());
  wc.on('will-redirect', (ev) => ev.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
}

/* A modal dialog page of the app's own: locked, sandboxed, one preload. */
function openDialogWindow({ title, page, width, height, parent = win, resizable = false }) {
  const w = new BrowserWindow({
    width,
    height,
    ...(resizable ? { minWidth: width, minHeight: 420 } : {}),
    parent,
    modal: !resizable,
    show: false,
    resizable,
    minimizable: false,
    maximizable: false,
    title,
    backgroundColor: colors().bg,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: colors().bg, symbolColor: colors().fg, height: TITLEBAR_H },
    webPreferences: {
      preload: path.join(PAGES, page, 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  lockPage(w.webContents);
  w.loadFile(path.join(PAGES, page, `${page}.html`));
  w.once('ready-to-show', () => w.show());
  return w;
}

function openSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus();
    return;
  }
  settingsWin = openDialogWindow({
    title: 'Appbox settings', page: 'settings', width: 640, height: 700, resizable: true,
  });
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
}

function openAddWindow() {
  if (addWin && !addWin.isDestroyed()) {
    addWin.focus();
    return;
  }
  addWin = openDialogWindow({
    title: 'Add apps', page: 'add', width: 760, height: 760,
  });
  addWin.on('closed', () => {
    addWin = null;
  });
}

function addTemplates() {
  return catalog.list().map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    color: t.color,
    icon: t.icon ? resolveIcon({ icon: t.icon }) : null,
    inputs: t.inputs || [],
    copies: t.id === 'custom' ? 0 : catalog.copies(t.id, cfg.services),
  }));
}

/* Adds one app from the catalog, builds its view and shows it when
 * nothing else is on screen.
 */
function addApp(templateId, input) {
  const entry = catalog.build(templateId, input, cfg.services);
  cfg = config.addService(entry);
  syncServices();
  const svc = cfg.services.find((s) => s.id === entry.id);
  if (svc.enabled && !svc.launch) {
    buildView(svc);
    layout();
  }
  if (!views.has(activeId)) {
    activate(svc.id);
  }
  pushUpdate();
  return { id: svc.id, name: svc.name, copies: templateId === 'custom' ? 0 : catalog.copies(templateId, cfg.services) };
}

/* The content area when no app is on screen. */
function updateWelcome() {
  if (!win || win.isDestroyed()) {
    return;
  }
  if (views.has(activeId)) {
    if (welcomeView) {
      welcomeView.setVisible(false);
    }
    return;
  }
  if (!welcomeView) {
    welcomeView = new WebContentsView({
      webPreferences: {
        preload: path.join(PAGES, 'welcome', 'preload.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    welcomeView.setBackgroundColor(colors().bg);
    lockPage(welcomeView.webContents);
    welcomeView.webContents.loadFile(path.join(PAGES, 'welcome', 'welcome.html'));
    win.contentView.addChildView(welcomeView);
    raiseMenu();
  }
  welcomeView.setBounds(viewBounds());
  welcomeView.setVisible(true);
}

function saveSettings(patch, autostart) {
  const clean = {};
  if ('startHidden' in patch) {
    clean.startHidden = Boolean(patch.startHidden);
  }
  if ('showTray' in patch) {
    clean.showTray = Boolean(patch.showTray);
  }
  if ('useFavicons' in patch) {
    clean.useFavicons = Boolean(patch.useFavicons);
  }
  if ('hardwareAcceleration' in patch) {
    clean.hardwareAcceleration = Boolean(patch.hardwareAcceleration);
  }
  if ('theme' in patch) {
    if (!config.THEMES.includes(patch.theme)) {
      throw new Error('unknown theme');
    }
    clean.theme = patch.theme;
  }
  if ('downloadDir' in patch) {
    const dir = String(patch.downloadDir || '').trim();
    if (dir !== '' && !config.isDownloadDir(dir)) {
      throw new Error('the download folder cannot be the home folder or a hidden folder');
    }
    clean.downloadDir = dir;
  }
  if (Array.isArray(patch.authHosts)) {
    clean.authHosts = config.hostList(patch.authHosts);
  }
  if (Array.isArray(patch.spellcheckLanguages)) {
    clean.spellcheckLanguages = patch.spellcheckLanguages.map(String).filter((l) => /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(l));
  }
  cfg = config.patchSettings(clean);
  applyTheme();
  setAutostart(autostart);
  if (cfg.settings.showTray && !tray) {
    createTray();
  } else if (!cfg.settings.showTray && tray) {
    tray.destroy();
    tray = null;
  }
  if (clean.spellcheckLanguages) {
    for (const v of views.values()) {
      try {
        if (v.wc && !v.wc.isDestroyed()) {
          v.wc.session.setSpellCheckerLanguages(clean.spellcheckLanguages);
        }
      } catch (err) {
        console.error(`spellcheck: ${err.message}`);
      }
    }
  }
  pushUpdate();
  if ('hardwareAcceleration' in clean && clean.hardwareAcceleration !== hwAccelAtStart) {
    setImmediate(askRestartForHwAccel);
  }
  return cfg.settings;
}

async function askRestartForHwAccel() {
  const choice = await dialog.showMessageBox(win, {
    type: 'question',
    title: 'Hardware acceleration',
    message: `Hardware acceleration will be ${cfg.settings.hardwareAcceleration ? 'enabled' : 'disabled'} after a restart.`,
    detail: 'Restart Appbox now to apply it?',
    buttons: ['Restart now', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });
  if (choice.response !== 0) {
    return;
  }
  quitting = true;
  config.saveState(state);
  app.relaunch();
  app.exit(0);
}

function openSettingsMenu(x, y, focus = null) {
  const items = [
    { key: 'add', label: 'Add apps...', type: 'action' },
    { key: 'settings', label: 'Settings...', type: 'action' },
    { key: 'autostart', label: 'Start at login', type: 'toggle', checked: autostartEnabled() },
    { key: 'downloads', label: 'Download folder', type: 'action', sub: config.downloadDir(cfg.settings).replace(/^\/home\/[^/]+/, '~') },
    { key: 'export', label: 'Export profile...', type: 'action' },
    { key: 'import', label: 'Import profile...', type: 'action' },
    { key: 'editor', label: 'Open services.json in an editor', type: 'action', sep: true },
    { key: 'reload', label: 'Reload configuration', type: 'action' },
    { key: 'quit', label: 'Quit Appbox', type: 'action', sep: true },
  ];
  menuArgs = { id: SETTINGS_MENU, x, y };
  showMenu(SETTINGS_MENU, { name: `Appbox ${app.getVersion()}` }, items, x, y, 'up', SETTINGS_MENU_W, focus);
}

function settingsMenuAction(key) {
  if (key === 'add') {
    openAddWindow();
  } else if (key === 'settings') {
    openSettingsWindow();
  } else if (key === 'autostart') {
    setAutostart(!autostartEnabled());
  } else if (key === 'downloads') {
    pickDownloadDir();
  } else if (key === 'export') {
    exportProfileDialog();
  } else if (key === 'import') {
    importProfileDialog();
  } else if (key === 'editor') {
    shell.openPath(config.paths.services);
  } else if (key === 'reload') {
    reloadConfig();
  } else if (key === 'quit') {
    app.quit();
  }
}
let quitting = false;
let activeId = null;
let notifSeq = 0;
const views = new Map();
const accounts = new Map();
const badges = new Map();
const liveNotifications = new Map();
let saveTimer = null;

function debounceSaveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => config.saveState(state), 500);
}

function viewBounds() {
  const [width, height] = win.getContentSize();
  const x = cfg.settings.sidebarWidth;
  return {
    x,
    y: TITLEBAR_H,
    width: Math.max(0, width - x),
    height: Math.max(0, height - TITLEBAR_H - STATUSBAR_H),
  };
}

/* Bottom strip: hovered link target and load state of the active view. */
const viewStatus = new Map();

function pushStatus() {
  if (!win || win.isDestroyed()) {
    return;
  }
  const svc = cfg.services.find((s) => s.id === activeId);
  const st = viewStatus.get(activeId) || {};
  win.webContents.send('appbox:status', {
    name: svc ? svc.name : '',
    url: st.url || (svc ? svc.url : ''),
    target: st.target || '',
    loading: Boolean(st.loading),
    transfer: transfer || '',
    usage: usage.id === activeId ? usage.text : '',
  });
}

let usage = { id: null, text: '' };
let cpuSeen = new Map();

async function sampleUsage() {
  if (!win || win.isDestroyed() || !win.isVisible()) {
    return;
  }
  const now = Date.now();
  const cpuNow = new Map(app.getAppMetrics().map((m) => [m.pid, { cum: m.cpu.cumulativeCPUUsage, at: now }]));
  const cpuPrev = cpuSeen;
  cpuSeen = cpuNow;
  const id = activeId;
  const v = views.get(id);
  let text = '';
  if (v && v.sleeping) {
    text = 'sleeping';
  } else if (v && v.wc && !v.wc.isDestroyed()) {
    const pids = [...new Set(v.wc.mainFrame.framesInSubtree.map((f) => f.osProcessId))];
    let cpu = 0;
    for (const pid of pids) {
      const a = cpuPrev.get(pid);
      const b = cpuNow.get(pid);
      if (a && b && typeof a.cum === 'number' && typeof b.cum === 'number' && b.at > a.at) {
        cpu += ((b.cum - a.cum) / ((b.at - a.at) / 1000)) * 100;
      }
    }
    const pss = await Promise.all(pids.map((pid) => fs.promises.readFile(`/proc/${pid}/smaps_rollup`, 'utf8')
      .then((t) => Number((t.match(/^Pss:\s+(\d+)/m) || [0, 0])[1]) * 1024)
      .catch(() => 0)));
    text = `CPU ${Math.max(0, Math.round(cpu))}% \u00b7 ${fmtBytes(pss.reduce((x, y) => x + y, 0))}`;
  }
  if (id === activeId && (usage.id !== id || usage.text !== text)) {
    usage = { id, text };
    pushStatus();
  }
}

/* Download progress shown in the status bar whatever the active app. */
let transfer = null;
let transferTimer = null;

function fmtBytes(n) {
  if (n >= 1024 * 1024) {
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }
  if (n >= 1024) {
    return `${Math.round(n / 1024)} KB`;
  }
  return `${n} B`;
}

function onProgress(id, p) {
  const svc = cfg.services.find((s) => s.id === id);
  const app = svc ? svc.name : id;
  clearTimeout(transferTimer);
  if (p.phase === 'downloading') {
    const pct = p.size > 0 ? ` ${Math.min(100, Math.round((p.have / p.size) * 100))}% of ${fmtBytes(p.size)}` : '';
    transfer = `${app}: downloading ${p.label}...${pct}`;
  } else if (p.phase === 'saved') {
    const what = p.files.length === 1 ? p.files[0] : `${p.files.length} files`;
    transfer = `${app}: saved ${what} (${fmtBytes(p.size)}) to ${p.dir}`;
    transferTimer = setTimeout(() => {
      transfer = null;
      pushStatus();
    }, 8000);
  } else {
    transfer = `${app}: download of ${p.label} failed: ${p.error}`;
    transferTimer = setTimeout(() => {
      transfer = null;
      pushStatus();
    }, 10000);
  }
  pushStatus();
}

function setTransfer(text, ms) {
  clearTimeout(transferTimer);
  transfer = text;
  transferTimer = setTimeout(() => {
    transfer = null;
    pushStatus();
  }, ms);
  pushStatus();
}

function onStatus(id, patch) {
  viewStatus.set(id, { ...(viewStatus.get(id) || {}), ...patch });
  if (id === activeId) {
    pushStatus();
    if (menuOpen) {
      raiseMenu();
    }
  }
}

/* The menu stays the topmost child: a view created or navigating under
 * it would otherwise take the clicks meant for it.
 */
function raiseMenu() {
  if (menuView && win && !win.isDestroyed()) {
    win.contentView.removeChildView(menuView);
    win.contentView.addChildView(menuView);
  }
}

function layout() {
  if (!win) {
    return;
  }
  const bounds = viewBounds();
  for (const v of views.values()) {
    v.setBounds(bounds);
  }
  if (welcomeView) {
    welcomeView.setBounds(bounds);
  }
  closeServiceMenu();
}

/* Views and accounts keep the service objects of the current config. */
function syncServices() {
  for (const s of cfg.services) {
    const v = views.get(s.id);
    if (v) {
      v.svc = s;
    }
    if (accounts.has(s.id)) {
      accounts.get(s.id).svc = s;
    }
  }
}

function resolveIcon(svc) {
  if (svc.icon) {
    if (/^(https?:|data:)/.test(svc.icon)) {
      return svc.icon;
    }
    const file = path.isAbsolute(svc.icon) ? svc.icon : path.join(ASSETS, 'icons', svc.icon);
    return fs.existsSync(file) ? `file://${file}` : null;
  }
  if (cfg.settings.useFavicons && own(state.favicons, svc.id)) {
    return own(state.favicons, svc.id);
  }
  return null;
}

function iconScore(l) {
  const href = String(l.href || '').toLowerCase();
  if (!/^https?:/.test(href)) {
    return -1;
  }
  if (href.endsWith('.svg') || /svg/.test(l.type || '')) {
    return 512;
  }
  const sizes = String(l.sizes || '').match(/(\d+)x\d+/g);
  if (sizes) {
    return Math.max(...sizes.map((s) => parseInt(s, 10)));
  }
  if (/apple-touch/i.test(l.rel || '')) {
    return 180;
  }
  return href.endsWith('.ico') ? 48 : 32;
}

function snapshot() {
  const sleeping = {};
  for (const [id, v] of views) {
    sleeping[id] = v.sleeping;
  }
  return {
    version: app.getVersion(),
    services: cfg.services.map((s) => ({
      id: s.id,
      name: s.name,
      color: s.color,
      icon: resolveIcon(s),
      external: Boolean(s.launch),
      enabled: s.enabled,
      divider: Boolean(s.divider),
    })),
    activeId,
    badges: Object.fromEntries(badges),
    sleeping,
  };
}

function pushUpdate() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('appbox:update', snapshot());
  }
  updateWelcome();
  updateTray();
}

function totalUnread() {
  let total = 0;
  let dot = false;
  for (const n of badges.values()) {
    if (n === 'dot') {
      dot = true;
    } else {
      total += n;
    }
  }
  return { total, dot };
}

function showWindow() {
  if (!win) {
    return;
  }
  if (!win.isVisible()) {
    win.show();
  }
  if (win.isMinimized()) {
    win.restore();
  }
  win.focus();
}

async function launchExternal(svc) {
  const argv = svc.launch.split(/\s+/).map((a) => a.replace('%u', svc.url));
  state.launchApproved = state.launchApproved || {};
  if (own(state.launchApproved, svc.id) !== argv.join(' ')) {
    const choice = await dialog.showMessageBox(win, {
      type: 'warning',
      title: 'Run command',
      message: `${svc.name} runs a command on this computer.`,
      detail: `${argv.join(' ')}\n\nRun it only if you added it to services.json yourself.`,
      buttons: ['Run', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    });
    if (choice.response !== 0) {
      return;
    }
    state.launchApproved[svc.id] = argv.join(' ');
    debounceSaveState();
  }
  const [cmd, ...args] = argv;
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch (err) {
    console.error(`${svc.id}: launch failed: ${err.message}`);
  }
}

function activate(id) {
  const svc = cfg.services.find((s) => s.id === id);
  if (svc && !svc.enabled) {
    return;
  }
  if (svc && svc.launch) {
    launchExternal(svc);
    return;
  }
  const next = views.get(id);
  if (!next) {
    return;
  }
  const prev = activeId;
  activeId = id;
  for (const [vid, v] of views) {
    v.setVisible(vid === id);
  }
  next.cancelSleep();
  if (next.sleeping) {
    next.wake();
  }
  next.focus();
  if (prev && prev !== id && views.has(prev)) {
    views.get(prev).armSleep();
  }
  state.activeId = id;
  debounceSaveState();
  pushUpdate();
  pushStatus();
}

function activateIndex(i) {
  const svc = cfg.services[i];
  if (svc) {
    activate(svc.id);
  }
}

function cycle(step) {
  const ids = cfg.services.filter((s) => !s.launch && s.enabled).map((s) => s.id);
  if (ids.length === 0) {
    activeId = null;
    state.activeId = null;
    debounceSaveState();
    pushUpdate();
    pushStatus();
    return;
  }
  const i = ids.indexOf(activeId);
  activate(ids[(i + step + ids.length) % ids.length]);
}

function handleInput(e, input) {
  if (input.type !== 'keyDown' || !input.control || input.alt || input.meta) {
    return;
  }
  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key;
  const active = views.get(activeId);
  let handled = true;

  if (/^[1-9]$/.test(key) && !input.shift) {
    activateIndex(Number(key) - 1);
  } else if (key === 'Tab') {
    cycle(input.shift ? -1 : 1);
  } else if (key === 'q' && !input.shift) {
    app.quit();
  } else if (key === 'r' && !input.shift && active) {
    active.reload();
  } else if (key === 'i' && input.shift && active && active.wc && (!active.builtin || process.env.APPBOX_DEVTOOLS)) {
    active.wc.toggleDevTools();
  } else if (key === '=' || key === '+') {
    zoomActive(0.5);
  } else if (key === '-' || key === '_') {
    zoomActive(-0.5);
  } else if (key === '0') {
    zoomActive(null);
  } else {
    handled = false;
  }
  if (handled) {
    e.preventDefault();
  }
}

/* Steps the active view's zoom, or resets it when step is null, and
 * remembers it per service.
 */
function zoomActive(step) {
  const active = views.get(activeId);
  if (!active || !active.wc || active.wc.isDestroyed()) {
    return;
  }
  const level = step === null ? 0 : Math.max(-3, Math.min(5, active.wc.getZoomLevel() + step));
  updateService(activeId, { zoom: level });
}

/* Accelerators reach a focused service view even when the page swallows
 * the key event before before-input-event handlers see it.
 */
function installAccelerators() {
  const item = (label, accelerators, click) => accelerators.map((accelerator, i) => ({
    label, accelerator, click, visible: i === 0,
  }));
  Menu.setApplicationMenu(Menu.buildFromTemplate([{
    label: 'View',
    submenu: [
      ...item('Zoom In', ['CommandOrControl+=', 'CommandOrControl+Plus', 'CommandOrControl+numadd'], () => zoomActive(0.5)),
      ...item('Zoom Out', ['CommandOrControl+-', 'CommandOrControl+numsub'], () => zoomActive(-0.5)),
      ...item('Reset Zoom', ['CommandOrControl+0', 'CommandOrControl+num0'], () => zoomActive(null)),
    ],
  }]));
}

const ctx = {
  get settings() {
    return cfg.settings;
  },
  zoomLevel(id) {
    const svc = cfg.services.find((s) => s.id === id);
    return svc ? Number(svc.zoom) || 0 : 0;
  },
  get win() {
    return win;
  },
  userAgent: null,
  viewBounds,
  handleInput,
  onBadge(id, n) {
    if (badges.get(id) === n) {
      return;
    }
    badges.set(id, n);
    const { total } = totalUnread();
    app.setBadgeCount(total);
    pushUpdate();
  },
  onFavicon(id, url) {
    if (!cfg.settings.useFavicons || badges.get(id) || typeof url !== 'string' || url.length > 2048 || !/^https:/.test(url)) {
      return;
    }
    state.favicons = state.favicons || {};
    if (!own(state.favicons, id)) {
      state.favicons[id] = url;
      debounceSaveState();
      pushUpdate();
    }
  },
  onStatus,
  onIcons(id, links) {
    if (!cfg.settings.useFavicons || badges.get(id) || !Array.isArray(links)) {
      return;
    }
    let best = null;
    for (const l of links.slice(0, 50)) {
      if (!l || typeof l.href !== 'string' || l.href.length > 2048 || !/^https:/.test(l.href)) {
        continue;
      }
      const score = iconScore(l);
      if (score > 0 && (!best || score > best.score)) {
        best = { href: l.href, score };
      }
    }
    if (!best) {
      return;
    }
    state.favicons = state.favicons || {};
    state.iconScores = state.iconScores || {};
    if (own(state.favicons, id) !== best.href && (own(state.iconScores, id) || 0) <= best.score) {
      state.favicons[id] = best.href;
      state.iconScores[id] = best.score;
      debounceSaveState();
      pushUpdate();
    }
  },
  onSleepChange: pushUpdate,
  onViewAdded: raiseMenu,
  /* Grants are kept per service, permission and exact origin. */
  permissionGranted(svc, permission, origin) {
    const entry = own(own(state.permissions, svc.id), permission);
    return Boolean(origin && entry && typeof entry === 'object' && own(entry, origin) === true);
  },
  /* Asks once per service, permission and origin. A refusal lasts the
   * session, and concurrent requests share one dialog.
   */
  askPermission(svc, permission, origin) {
    if (!origin || origin === 'null') {
      return Promise.resolve(false);
    }
    if (ctx.permissionGranted(svc, permission, origin)) {
      return Promise.resolve(true);
    }
    const key = `${svc.id}\0${permission}\0${origin}`;
    if (refused.has(key)) {
      return Promise.resolve(false);
    }
    if (asking.has(key)) {
      return asking.get(key);
    }
    const ask = dialog.showMessageBox(win, {
      type: 'question',
      title: svc.name,
      message: `${svc.name} wants to ${PERMISSION_TEXT[permission] || `use ${permission}`}.`,
      detail: `Asked by ${origin}. Appbox will not ask again for this app and site.`,
      buttons: ['Allow', 'Block'],
      defaultId: 1,
      cancelId: 1,
    }).then((choice) => {
      asking.delete(key);
      if (choice.response !== 0) {
        refused.add(key);
        return false;
      }
      state.permissions = state.permissions || {};
      const mine = state.permissions[svc.id] = own(state.permissions, svc.id) || {};
      const entry = own(mine, permission) && typeof mine[permission] === 'object' ? mine[permission] : {};
      mine[permission] = { ...entry, [origin]: true };
      debounceSaveState();
      return true;
    });
    asking.set(key, ask);
    return ask;
  },
  /* The user picks what to share, since Linux has no system picker
   * outside the Wayland portal.
   */
  async pickSource(svc, sources) {
    const list = sources.slice(0, 8);
    if (list.length === 0) {
      return null;
    }
    const choice = await dialog.showMessageBox(win, {
      type: 'question',
      title: svc.name,
      message: `What should ${svc.name} share?`,
      buttons: [...list.map((s) => s.name.slice(0, 60)), 'Cancel'],
      defaultId: list.length,
      cancelId: list.length,
    });
    return choice.response < list.length ? list[choice.response] : null;
  },
};
const refused = new Set();
const asking = new Map();

function showNotification({ title, body, onClick }) {
  if (!Notification.isSupported()) {
    return null;
  }
  const n = new Notification({
    title: String(title || 'Appbox').slice(0, 200),
    body: String(body || '').slice(0, 1000),
    icon: nativeImage.createFromPath(APP_ICON),
  });
  if (onClick) {
    n.on('click', onClick);
  }
  n.show();
  return n;
}

const builtinCtx = {
  onBadge: (id, n) => ctx.onBadge(id, n),
  onProgress,
  patch: (id, patch) => updateService(id, patch),
  notify: showNotification,
  activate: (id) => {
    showWindow();
    activate(id);
  },
};

function ensureAccount(svc) {
  if (accounts.has(svc.id)) {
    return;
  }
  const send = (channel, data) => {
    const v = views.get(svc.id);
    if (v && v.wc && !v.wc.isDestroyed()) {
      v.wc.send(channel, data);
    }
  };
  if (svc.type === 'gmail') {
    const acc = new MailAccount(svc, builtinCtx);
    acc.on('status', (status) => send('mail:event', { type: 'status', status }));
    acc.on('list', () => send('mail:event', { type: 'list' }));
    acc.on('folders', () => send('mail:event', { type: 'folders' }));
    acc.on('open', ({ uid, thrid, box }) => send('mail:event', { type: 'open', uid, thrid, box }));
    accounts.set(svc.id, acc);
    acc.init();
  } else if (svc.type === 'github-tracker') {
    const tracker = new GhTracker(svc, builtinCtx);
    tracker.on('status', (status) => send('gh:event', { type: 'status', status }));
    tracker.on('data', () => send('gh:event', { type: 'data' }));
    accounts.set(svc.id, tracker);
    tracker.init();
  }
}

function dropAccount(id) {
  const acc = accounts.get(id);
  if (acc) {
    acc.stop();
    accounts.delete(id);
  }
}

function buildView(svc) {
  ensureAccount(svc);
  const v = new ServiceView(svc, ctx);
  views.set(svc.id, v);
  v.setVisible(svc.id === activeId);
  v.create();
  if (svc.id !== activeId) {
    v.armSleep();
  }
  return v;
}

function createViews() {
  let delay = 0;
  for (const svc of cfg.services) {
    if (svc.launch || !svc.enabled) {
      continue;
    }
    ensureAccount(svc);
    const v = new ServiceView(svc, ctx);
    views.set(svc.id, v);
    v.setVisible(svc.id === activeId);
    if (svc.startup === 'lazy' && svc.id !== activeId) {
      v.sleeping = true;
      continue;
    }
    setTimeout(() => {
      if (views.get(svc.id) === v) {
        v.create();
        if (svc.id !== activeId) {
          v.armSleep();
        }
      }
    }, delay);
    delay += 300;
  }
}

function reloadConfig() {
  let next;
  try {
    next = config.load();
  } catch (err) {
    console.error(`config: ${err.message}`);
    return;
  }
  const nextIds = new Set(next.services.map((s) => s.id));
  for (const [id, v] of views) {
    if (!nextIds.has(id)) {
      v.destroy();
      views.delete(id);
      badges.delete(id);
      viewStatus.delete(id);
      dropAccount(id);
    }
  }
  cfg = next;
  applyTheme();
  for (const svc of cfg.services) {
    const v = views.get(svc.id);
    if (accounts.has(svc.id)) {
      accounts.get(svc.id).svc = svc;
    }
    if (v && REBUILD_KEYS.some((k) => JSON.stringify(v.svc[k]) !== JSON.stringify(svc[k]))) {
      replaceView(svc);
    } else if (v) {
      v.svc = svc;
    } else if (!svc.launch && svc.enabled) {
      buildView(svc);
    }
  }
  if (!views.has(activeId)) {
    cycle(1);
  }
  layout();
  pushUpdate();
}

/* Quotes an Exec argument as the desktop entry specification asks. */
function desktopQuote(arg) {
  const clean = String(arg).replace(/[\u0000-\u001f\u007f]/g, '');
  return `"${clean.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$').replace(/%/g, '%%')}"`;
}

function applyTheme() {
  nativeTheme.themeSource = cfg.settings.theme;
}

/* Repaints the window frame and the view backgrounds after a theme
 * change, the pages follow through their own color-scheme queries.
 */
function repaintShell() {
  const c = colors();
  if (win && !win.isDestroyed()) {
    win.setBackgroundColor(c.bg);
    if (typeof win.setTitleBarOverlay === 'function') {
      try {
        win.setTitleBarOverlay({ color: c.bg, symbolColor: c.fg });
      } catch {
        /* no overlay on this platform */
      }
    }
  }
  if (welcomeView) {
    welcomeView.setBackgroundColor(c.bg);
  }
  for (const v of views.values()) {
    if (v.view) {
      v.view.setBackgroundColor(c.bg);
    }
  }
}

function autostartEnabled() {
  return fs.existsSync(config.paths.autostart);
}

function setAutostart(enabled) {
  if (enabled) {
    fs.mkdirSync(path.dirname(config.paths.autostart), { recursive: true });
    fs.writeFileSync(config.paths.autostart, [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Appbox',
      'Comment=Web app manager',
      `Exec=${desktopQuote(process.env.APPBOX_LAUNCHER || 'appbox')} --hidden`,
      `Icon=${config.APP_ID}`,
      'Terminal=false',
      'X-GNOME-Autostart-enabled=true',
      '',
    ].join('\n'));
  } else {
    fs.rmSync(config.paths.autostart, { force: true });
  }
}

function trayMenu() {
  const items = cfg.services.map((s) => {
    const n = badges.get(s.id);
    const suffix = n === 'dot' ? '  *' : n > 0 ? `  (${n})` : '';
    return {
      label: `${s.name}${suffix}`,
      click: () => {
        showWindow();
        activate(s.id);
      },
    };
  });
  return Menu.buildFromTemplate([
    ...items,
    { type: 'separator' },
    {
      label: win && win.isVisible() ? 'Hide' : 'Show',
      click: () => (win.isVisible() ? win.hide() : showWindow()),
    },
    { label: 'Reload config', click: reloadConfig },
    {
      label: 'Start at login',
      type: 'checkbox',
      checked: autostartEnabled(),
      click: (item) => setAutostart(item.checked),
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
}

function updateTray() {
  if (!tray) {
    return;
  }
  const { total, dot } = totalUnread();
  const unread = total > 0 || dot;
  tray.setImage(nativeImage.createFromPath(path.join(ASSETS, unread ? 'tray-unread.png' : 'tray.png')));
  tray.setToolTip(total > 0 ? `Appbox: ${total} unread` : 'Appbox');
  tray.setContextMenu(trayMenu());
}

/* GNOME has no tray without the AppIndicator extension. Electron's Tray
 * speaks StatusNotifierItem, so a registered watcher is the signal.
 */
function trayHostPresent() {
  try {
    const out = execFileSync('gdbus', [
      'call', '--session', '--dest', 'org.freedesktop.DBus',
      '--object-path', '/org/freedesktop/DBus',
      '--method', 'org.freedesktop.DBus.NameHasOwner', 'org.kde.StatusNotifierWatcher',
    ], { encoding: 'utf8', timeout: 2000 });
    return out.includes('true');
  } catch {
    return true;
  }
}

function createTray() {
  if (!cfg.settings.showTray) {
    return;
  }
  if (!trayHostPresent()) {
    console.log('tray: no StatusNotifierWatcher on the session bus, tray disabled');
    return;
  }
  try {
    tray = new Tray(nativeImage.createFromPath(path.join(ASSETS, 'tray.png')));
    tray.on('click', () => (win.isVisible() ? win.hide() : showWindow()));
    updateTray();
  } catch (err) {
    console.error(`tray: ${err.message}`);
    tray = null;
  }
}

/* Tear the service down and build it again on a freshly configured
 * session, so url, user agent and permission changes take effect.
 */
function replaceView(svc) {
  const old = views.get(svc.id);
  if (old) {
    old.destroy();
    views.delete(svc.id);
    badges.delete(svc.id);
  }
  dropAccount(svc.id);
  resetPartition(svc.partition);
  if (svc.enabled && !svc.launch) {
    buildView(svc);
    layout();
  }
  if (activeId === svc.id && !views.has(svc.id)) {
    cycle(1);
  }
}

function rebuildService(id) {
  try {
    cfg = config.load();
  } catch (err) {
    console.error(`config: ${err.message}`);
    return;
  }
  syncServices();
  const svc = cfg.services.find((s) => s.id === id);
  if (svc) {
    replaceView(svc);
  }
  pushUpdate();
}

function updateService(id, patch) {
  const before = cfg.services.find((s) => s.id === id);
  cfg = config.patchService(id, patch);
  const svc = cfg.services.find((s) => s.id === id);
  if (!before || !svc) {
    return;
  }
  syncServices();

  const rebuild = REBUILD_KEYS.some((k) => JSON.stringify(before[k]) !== JSON.stringify(svc[k]));
  if (rebuild) {
    replaceView(svc);
  } else {
    const v = views.get(id);
    if (v && 'sounds' in patch) {
      v.setSounds(svc.sounds);
    }
    if ('zoom' in patch && v && v.wc && !v.wc.isDestroyed()) {
      v.wc.setZoomLevel(Number(svc.zoom) || 0);
    }
    if (v && 'sleep' in patch && id !== activeId) {
      v.armSleep();
    }
  }
  pushUpdate();
}

function openProps(id) {
  const svc = cfg.services.find((s) => s.id === id);
  if (!svc) {
    return;
  }
  if (propsWin && !propsWin.isDestroyed()) {
    propsWin.close();
  }
  propsWin = new BrowserWindow({
    width: 640,
    height: 960,
    parent: win,
    modal: true,
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: `${svc.name} - properties`,
    backgroundColor: colors().bg,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: colors().bg, symbolColor: colors().fg, height: TITLEBAR_H },
    webPreferences: {
      preload: path.join(PAGES, 'props', 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  propsWin.serviceId = id;
  lockPage(propsWin.webContents);
  propsWin.loadFile(path.join(PAGES, 'props', 'props.html'));
  propsWin.once('ready-to-show', () => propsWin.show());
  propsWin.on('closed', () => {
    propsWin = null;
  });
}

async function removeAppDialog(id) {
  const svc = cfg.services.find((s) => s.id === id);
  if (!svc) {
    return;
  }
  const choice = await dialog.showMessageBox(propsWin && !propsWin.isDestroyed() ? propsWin : win, {
    type: 'warning',
    title: 'Remove app',
    message: `Remove ${svc.name} from Appbox?`,
    detail: 'The app leaves the sidebar and its settings are dropped from services.json.',
    checkboxLabel: 'Also delete its login, cookies and cached data',
    checkboxChecked: true,
    buttons: ['Remove', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  });
  if (choice.response !== 0) {
    return;
  }
  if (propsWin && !propsWin.isDestroyed() && propsWin.serviceId === id) {
    propsWin.close();
  }
  await removeApp(id, choice.checkboxChecked);
}

/* Takes the app out of the window and the config. With wipe, its
 * stored data goes too: the session storage now, the profile directory
 * at the next start, when no session holds it open.
 */
async function removeApp(id, wipe) {
  const svc = cfg.services.find((s) => s.id === id);
  if (!svc) {
    return;
  }
  const v = views.get(id);
  if (v) {
    v.destroy();
    views.delete(id);
  }
  badges.delete(id);
  viewStatus.delete(id);
  /* Stored secrets never outlive the app that owns them. */
  const acc = accounts.get(id);
  if (acc && typeof acc.forget === 'function') {
    acc.forget();
  }
  forgetToken(id);
  dropAccount(id);
  cfg = config.removeService(id);
  syncServices();
  if (wipe) {
    for (const store of [state.permissions, state.launchApproved, state.favicons, state.iconScores]) {
      if (store) {
        delete store[id];
      }
    }
    if (!svc.launch && !cfg.services.some((s) => s.partition === svc.partition)) {
      const ses = session.fromPartition(`persist:${svc.partition}`);
      try {
        await ses.clearStorageData();
        await ses.clearCache();
        await ses.clearAuthCache();
        await ses.clearCodeCaches({});
      } catch (err) {
        console.error(`${id}: clear session: ${err.message}`);
      }
      resetPartition(svc.partition);
      state.purgePartitions = [...new Set([...(state.purgePartitions || []), svc.partition])];
    }
    debounceSaveState();
  }
  app.setBadgeCount(totalUnread().total);
  if (activeId === id) {
    cycle(1);
  }
  layout();
  pushUpdate();
}

/* Profile directories of removed apps, deleted before any session opens. */
function purgePartitions() {
  const list = Array.isArray(state.purgePartitions) ? state.purgePartitions : [];
  const root = path.join(config.paths.data, 'Partitions');
  for (const name of list) {
    if (typeof name !== 'string' || !config.ID_RE.test(name)) {
      continue;
    }
    const dir = path.resolve(root, name);
    if (path.dirname(dir) !== root) {
      continue;
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      console.error(`purge ${name}: ${err.message}`);
    }
  }
  delete state.purgePartitions;
}

function sanitizeProps(patch) {
  const out = {};
  for (const [k, type] of Object.entries(PROP_KEYS)) {
    if (!(k in patch)) {
      continue;
    }
    const v = patch[k];
    if (k === 'sleep') {
      out.sleep = {
        enabled: Boolean(v && v.enabled),
        minutes: Math.min(1440, Math.max(1, parseInt(v && v.minutes, 10) || 15)),
      };
    } else if (k === 'userAgent') {
      out.userAgent = typeof v === 'string' && v.trim() ? v.trim().replace(/[^\x20-\x7e]/g, '').slice(0, 500) : null;
    } else if (k === 'url') {
      if (!config.isWebUrl(String(v))) {
        throw new Error(`not an http or https address: ${config.oneLine(v, 200)}`);
      }
      out.url = new URL(String(v)).href;
    } else if (k === 'repos') {
      out.repos = catalog.parseRepos(String(v));
    } else if (k === 'username') {
      if (!config.USERNAME_RE.test(String(v))) {
        throw new Error('not a GitHub user name');
      }
      out.username = String(v);
    } else if (typeof v === type) {
      out[k] = type === 'string' ? config.oneLine(v, 200) : v;
    }
  }
  if ('name' in out && out.name.trim() === '') {
    delete out.name;
  }
  if ('color' in out && !/^#[0-9a-f]{6}$/i.test(out.color)) {
    delete out.color;
  }
  if ('links' in out && !LINK_MODES.includes(out.links)) {
    delete out.links;
  }
  if ('startup' in out && !STARTUP_MODES.includes(out.startup)) {
    delete out.startup;
  }
  if ('zoom' in out) {
    out.zoom = Number.isFinite(out.zoom) ? Math.max(-3, Math.min(5, Math.round(out.zoom * 2) / 2)) : 0;
  }
  return out;
}

let menuOpen = false;

/* The service menu is its own view stacked above the app views, so no
 * app has to be hidden or captured while it is open.
 */
let menuView = null;
let menuReady = null;
const MENU_W = 236;
const SETTINGS_MENU_W = 320;
const MENU_HEAD = 48;
const MENU_ITEM = 34;

function ensureMenuView() {
  if (menuView) {
    return menuView;
  }
  menuView = new WebContentsView({
    webPreferences: {
      preload: path.join(PAGES, 'menu', 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  menuView.setBackgroundColor('#00000000');
  menuView.setVisible(false);
  lockPage(menuView.webContents);
  menuReady = menuView.webContents.loadFile(path.join(PAGES, 'menu', 'menu.html')).catch(() => {});
  menuView.webContents.on('blur', closeServiceMenu);
  win.contentView.addChildView(menuView);
  return menuView;
}

const MENU_TOGGLES = ['enabled', 'notifications', 'sounds', 'divider', 'autostart'];
let menuArgs = null;

async function openServiceMenu(id, x, y, focus = null) {
  const svc = cfg.services.find((s) => s.id === id);
  if (!svc || !win) {
    return;
  }
  const items = svc.launch
    ? [{ key: 'launch', label: 'Open', type: 'action' }]
    : [
      { key: 'enabled', label: 'Enabled', type: 'toggle', checked: svc.enabled },
      { key: 'notifications', label: 'Notifications', type: 'toggle', checked: svc.notifications },
      { key: 'sounds', label: 'Sounds', type: 'toggle', checked: svc.sounds },
      { key: 'reload', label: 'Reload', type: 'action' },
    ];
  items.push({ key: 'divider', label: 'Divider above', type: 'toggle', checked: Boolean(svc.divider), sep: true });
  items.push({ key: 'props', label: 'Properties', type: 'action', sep: true });
  menuArgs = { id, x, y };
  showMenu(id, { name: svc.name, icon: resolveIcon(svc), color: svc.color }, items, x, y, 'down', MENU_W, focus);
}

/* Shows the menu view next to the sidebar: anchored below y, or above
 * it for the gear at the bottom.
 */
async function showMenu(id, header, items, x, y, anchor, width = MENU_W, focus = null) {
  ensureMenuView();
  await menuReady;
  const seps = items.filter((it, i) => it.sep || (i > 0 && it.type === 'action' && items[i - 1].type === 'toggle')).length;
  const height = MENU_HEAD + items.length * MENU_ITEM + seps * 9 + 14;
  const [, winH] = win.getContentSize();
  const view = ensureMenuView();
  raiseMenu();
  const top = anchor === 'up' ? y - height - 6 : y - 10;
  view.setBounds({
    x: cfg.settings.sidebarWidth + 4,
    y: Math.max(TITLEBAR_H, Math.min(top, winH - STATUSBAR_H - height - 4)),
    width,
    height,
  });
  view.webContents.send('menu:open', { id, header, items, focus });
  view.setVisible(true);
  view.webContents.focus();
  menuOpen = true;
}

function closeServiceMenu() {
  if (!menuOpen || !menuView) {
    return;
  }
  menuOpen = false;
  menuView.setVisible(false);
}

function serviceMenuAction(id, key) {
  const svc = cfg.services.find((s) => s.id === id);
  if (svc && key === 'launch' && svc.launch) {
    launchExternal(svc);
    return;
  }
  if (svc && key === 'props') {
    openProps(id);
    return;
  }
  if (svc && key === 'divider') {
    updateService(id, { divider: !svc.divider });
    return;
  }
  if (svc && key === 'enabled') {
    updateService(id, { enabled: !svc.enabled });
    return;
  }
  const v = views.get(id);
  if (!v) {
    return;
  }
  if (key === 'notifications' || key === 'sounds') {
    updateService(id, { [key]: !v.svc[key] });
  } else if (key === 'reload') {
    rebuildService(id);
  }
}

/* Only a plain position and size are taken from the saved state. */
function windowBounds() {
  const saved = state.bounds && typeof state.bounds === 'object' ? state.bounds : {};
  const out = {};
  for (const [k, lo, hi] of [['x', -20000, 20000], ['y', -20000, 20000], ['width', 700, 20000], ['height', 480, 20000]]) {
    if (Number.isInteger(saved[k])) {
      out[k] = Math.min(hi, Math.max(lo, saved[k]));
    }
  }
  return { width: 1400, height: 900, ...out };
}

function createWindow() {
  win = new BrowserWindow({
    ...windowBounds(),
    minWidth: 700,
    minHeight: 480,
    show: false,
    title: 'Appbox',
    backgroundColor: colors().bg,
    icon: nativeImage.createFromPath(APP_ICON),
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: colors().bg, symbolColor: colors().fg, height: TITLEBAR_H },
    webPreferences: {
      preload: path.join(PAGES, 'sidebar', 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (state.maximized) {
    win.maximize();
  }
  lockPage(win.webContents);
  win.loadFile(path.join(PAGES, 'sidebar', 'sidebar.html'));
  win.webContents.on('before-input-event', handleInput);
  installAccelerators();
  win.setMenuBarVisibility(false);

  const saveBounds = () => {
    state.maximized = win.isMaximized();
    if (!state.maximized) {
      state.bounds = win.getNormalBounds();
    }
    debounceSaveState();
  };
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
    win.on(ev, () => {
      layout();
      saveBounds();
    });
  }
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      if (tray) {
        win.hide();
        updateTray();
      } else {
        win.minimize();
      }
    }
  });
  win.on('show', updateTray);
  win.on('hide', updateTray);
  win.on('focus', () => {
    const v = views.get(activeId);
    if (v) {
      v.focus();
    }
  });
  win.on('blur', closeServiceMenu);
}

const { exportProfileDialog, importProfileDialog, registerPromptIpc } = createProfileDialogs({
  app,
  dialog,
  profile,
  config,
  fmtBytes,
  openDialogWindow,
  mainWindow: () => win,
  settingsWindow: () => settingsWin,
  settings: () => cfg.settings,
  setTransfer,
  restart: () => {
    quitting = true;
    app.relaunch();
    app.exit(0);
  },
});

/* Chromium encrypts the stored logins of every app with the keyring
 * key; without a desktop keyring that key is a fixed built-in value.
 */
function warnWeakKeyring() {
  if (safeStorage.getSelectedStorageBackend() !== 'basic_text' || state.keyringWarned) {
    return;
  }
  state.keyringWarned = true;
  debounceSaveState();
  dialog.showMessageBox(win, {
    type: 'warning',
    title: 'No keyring',
    message: 'No desktop keyring was found.',
    detail: 'The logins of your apps are stored on disk without real encryption, and the mail client '
      + 'will not store its password. Install and unlock GNOME Keyring or KWallet, then restart Appbox.',
    buttons: ['OK'],
  });
}

async function pickDownloadDir() {
  const r = await dialog.showOpenDialog(win, {
    title: 'Download folder',
    defaultPath: config.downloadDir(cfg.settings),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (!r.canceled && r.filePaths && r.filePaths[0] && config.isDownloadDir(r.filePaths[0])) {
    cfg = config.patchSettings({ downloadDir: r.filePaths[0] });
  }
  return config.downloadDir(cfg.settings);
}

const fromSidebar = (e) => (win !== null && !win.isDestroyed() && e.sender === win.webContents ? win : null);
const fromMenu = (e) => (menuView !== null && e.sender === menuView.webContents ? menuView : null);
const fromSettings = (e) => (
  settingsWin !== null && !settingsWin.isDestroyed() && e.sender === settingsWin.webContents ? settingsWin : null);
const fromAdd = (e) => (addWin !== null && !addWin.isDestroyed() && e.sender === addWin.webContents ? addWin : null);
const fromWelcome = (e) => (welcomeView !== null && e.sender === welcomeView.webContents ? welcomeView : null);
const fromProps = (e) => (propsWin !== null && e.sender === propsWin.webContents ? propsWin : null);
const fromView = (e) => [...views.values()].find((x) => x.wc === e.sender) || null;
/* Only the app's own page, never a site loaded in its view, reaches
 * the account behind it.
 */
const ownPage = (e, type) => {
  const v = [...views.values()].find((x) => x.wc === e.sender && x.svc.type === type);
  return v && e.sender.getURL().startsWith('file://') ? accounts.get(v.svc.id) || null : null;
};

function registerIpc() {
  ipcMain.handle('appbox:list', guard(fromSidebar, () => snapshot()));
  ipcMain.on('appbox:activate', guardOn(fromSidebar, (w, id) => activate(String(id))));
  ipcMain.on('appbox:reorder', guardOn(fromSidebar, (w, ids) => {
    if (!Array.isArray(ids)) {
      return;
    }
    cfg = config.saveOrder(ids.map(String));
    for (const svc of cfg.services) {
      const v = views.get(svc.id);
      if (v) {
        v.svc = svc;
      }
    }
    pushUpdate();
  }));
  ipcMain.on('appbox:menu', guardOn(fromSidebar, (w, id, x, y) => openServiceMenu(String(id), Number(x) || 0, Number(y) || 0)));
  ipcMain.on('appbox:menu-close', guardOn((e) => fromSidebar(e) || fromMenu(e), () => closeServiceMenu()));
  ipcMain.handle('appbox:props-get', guard(fromProps, (w) => {
    const svc = cfg.services.find((s) => s.id === w.serviceId);
    return svc ? { ...svc, icon: resolveIcon(svc) } : null;
  }));
  ipcMain.on('appbox:props-save', guardOn(fromProps, (w, patch) => {
    if (!patch || typeof patch !== 'object') {
      return;
    }
    const id = w.serviceId;
    try {
      updateService(id, sanitizeProps(patch));
    } catch (err) {
      console.error(`props: ${err.message}`);
      return;
    }
    w.close();
  }));
  ipcMain.on('appbox:props-close', guardOn(fromProps, (w) => w.close()));
  ipcMain.on('appbox:props-remove', guardOn(fromProps, (w) => removeAppDialog(w.serviceId)));
  ipcMain.handle('appbox:props-forget-token', guard(fromProps, (w) => {
    const id = w.serviceId;
    const svc = cfg.services.find((s) => s.id === id);
    if (!svc || svc.type !== 'github-tracker') {
      return false;
    }
    const acc = accounts.get(id);
    const had = Boolean(acc && acc.token);
    if (acc) {
      acc.logout();
    }
    return forgetToken(id) || had;
  }));
  ipcMain.on('appbox:menu-action', guardOn(fromMenu, (v, id, key) => {
    const toggle = MENU_TOGGLES.includes(String(key));
    if (!toggle) {
      closeServiceMenu();
    }
    if (String(id) === SETTINGS_MENU) {
      settingsMenuAction(String(key));
    } else {
      serviceMenuAction(String(id), String(key));
    }
    if (toggle && menuArgs && menuArgs.id === String(id)) {
      /* The switch flips in place, the menu stays until a click elsewhere. */
      if (menuArgs.id === SETTINGS_MENU) {
        openSettingsMenu(menuArgs.x, menuArgs.y, String(key));
      } else {
        openServiceMenu(menuArgs.id, menuArgs.x, menuArgs.y, String(key));
      }
    }
  }));
  ipcMain.on('appbox:settings-menu', guardOn(fromSidebar, (w, x, y) => openSettingsMenu(Number(x) || 0, Number(y) || 0)));
  ipcMain.on('appbox:add-apps', guardOn((e) => fromSidebar(e) || fromWelcome(e), () => openAddWindow()));
  ipcMain.handle('add:get', guard(fromAdd, () => ({ templates: addTemplates() })));
  ipcMain.handle('add:add', guard(fromAdd, (w, id, input) => {
    const clean = {};
    for (const k of ['url', 'username', 'repos', 'name']) {
      if (input && typeof input === 'object' && typeof input[k] === 'string') {
        clean[k] = input[k].slice(0, 2048);
      }
    }
    return addApp(String(id), clean);
  }));
  ipcMain.on('add:close', guardOn(fromAdd, (w) => w.close()));
  ipcMain.handle('appbox:export-profile', guard(fromSettings, () => exportProfileDialog()));
  ipcMain.handle('appbox:import-profile', guard(fromSettings, () => importProfileDialog()));
  ipcMain.handle('settings:get', guard(fromSettings, () => ({
    settings: cfg.settings,
    autostart: autostartEnabled(),
    downloadDir: config.downloadDir(cfg.settings),
    version: app.getVersion(),
  })));
  ipcMain.handle('settings:save', guard(fromSettings, (w, patch, autostart) => (
    patch && typeof patch === 'object' ? saveSettings(patch, Boolean(autostart)) : null)));
  ipcMain.handle('settings:pick-dir', guard(fromSettings, async (w, current) => {
    const r = await dialog.showOpenDialog(w, {
      title: 'Download folder',
      defaultPath: String(current || config.downloadDir(cfg.settings)),
      properties: ['openDirectory', 'createDirectory'],
    });
    return !r.canceled && r.filePaths[0] ? r.filePaths[0] : null;
  }));
  ipcMain.on('settings:close', guardOn(fromSettings, (w) => w.close()));
  ipcMain.on('appbox:open-config', guardOn(fromSettings, () => shell.openPath(config.paths.services)));
  ipcMain.on('appbox:reload-config', guardOn(fromSettings, () => reloadConfig()));

  ipcMain.handle('appbox:notify', guard(fromView, (v, payload) => {
    if (!v.svc.notifications || !payload || typeof payload !== 'object') {
      return -1;
    }
    const now = Date.now();
    v.notifyTimes = (v.notifyTimes || []).filter((t) => now - t < NOTIFY_WINDOW_MS);
    if (v.notifyTimes.length >= NOTIFY_MAX) {
      return -1;
    }
    v.notifyTimes.push(now);
    const id = ++notifSeq;
    const sender = v.wc;
    const title = String(payload.title || '').slice(0, 200);
    const n = showNotification({
      title: title && title !== v.svc.name ? `${v.svc.name}: ${title}` : v.svc.name,
      body: String(payload.body || '').slice(0, 1000),
      onClick: () => {
        showWindow();
        activate(v.svc.id);
        if (!sender.isDestroyed()) {
          sender.send('appbox:notify-click', id);
        }
      },
    });
    if (!n) {
      return -1;
    }
    n.on('close', () => {
      liveNotifications.delete(id);
      if (!sender.isDestroyed()) {
        sender.send('appbox:notify-close', id);
      }
    });
    liveNotifications.set(id, { n, sender });
    return id;
  }));
  registerMailIpc(ipcMain, (e) => ownPage(e, 'gmail'), openExternal, async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
    return (r.filePaths || []).map((p) => {
      let size = 0;
      try {
        size = fs.statSync(p).size;
      } catch {
        /* unreadable: the send will report it */
      }
      return { path: p, name: path.basename(p), size };
    });
  }, {
    downloadDir: () => config.downloadDir(cfg.settings),
    openPath: (p) => shell.openPath(p),
  });
  registerGhIpc(ipcMain, (e) => ownPage(e, 'github-tracker'), openExternal);
  registerPromptIpc(ipcMain);
  ipcMain.on('appbox:notify-close', guardOn(fromView, (v, id) => {
    const live = liveNotifications.get(id);
    if (live && live.sender === v.wc) {
      live.n.close();
    }
  }));
}

async function purgeCaches() {
  if (Date.now() - (state.cachePurgedAt || 0) < CACHE_PURGE_MS) {
    return;
  }
  await Promise.all(cfg.services.filter((svc) => !svc.launch).map(async (svc) => {
    const ses = session.fromPartition(`persist:${svc.partition}`);
    try {
      await ses.clearCodeCaches({});
      await ses.clearStorageData({ storages: ['shadercache', 'serviceworkers', 'cachestorage'] });
    } catch (err) {
      console.error(`${svc.id}: cache purge: ${err.message}`);
    }
  }));
  state.cachePurgedAt = Date.now();
  config.saveState(state);
}

function main() {
  /* A fresh or empty install always shows its window: there is nothing
   * to wait for in the tray.
   */
  const startHidden = !config.isFirstRun() && cfg.services.length > 0
    && (process.argv.includes('--hidden') || (cfg.settings.startHidden && !process.argv.includes('--show')));
  applyTheme();
  nativeTheme.on('updated', repaintShell);
  ctx.userAgent = app.userAgentFallback;

  const first = cfg.services.find((s) => s.enabled && !s.launch);
  activeId = cfg.services.some((s) => s.id === state.activeId) ? state.activeId : (first ? first.id : null);

  registerIpc();
  createWindow();
  createViews();
  createTray();
  setInterval(sampleUsage, USAGE_MS);

  win.once('ready-to-show', () => {
    layout();
    updateWelcome();
    if (!startHidden || tray === null) {
      win.show();
    }
    if (startHidden && tray === null) {
      win.minimize();
    }
    if (win.isVisible()) {
      warnWeakKeyring();
    } else {
      win.once('show', warnWeakKeyring);
    }
  });
}

const cli = handleCli(process.argv, {
  profile,
  fmtBytes,
  setAutostart,
  autostartEnabled,
  getVersion: () => app.getVersion(),
  requestSingleInstanceLock: () => app.requestSingleInstanceLock(),
});
if (cli) {
  Promise.resolve(cli).then(() => app.exit(process.exitCode || 0));
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else if (process.argv.includes('--quit')) {
  app.exit(0);
} else {
  app.on('second-instance', (e, argv) => {
    if (argv.includes('--quit')) {
      app.quit();
    } else {
      showWindow();
    }
  });
  app.on('before-quit', () => {
    quitting = true;
    config.saveState(state);
  });
  app.on('window-all-closed', () => {});

  app.whenReady().then(() => {
    try {
      const imported = profile.applyPendingImport();
      if (imported) {
        console.log(`applied profile import: ${imported.applied.join(', ')}`);
      }
      cfg = config.load();
    } catch (err) {
      console.error(`config: ${err.message}`);
      app.exit(1);
      return;
    }
    state = config.loadState();
    purgePartitions();
    purgeCaches().then(main).then(() => nodeModule.flushCompileCache());
  });
}
