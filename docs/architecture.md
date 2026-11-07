# Architecture

Appbox is one Electron main process, a set of built-in pages loaded
from files and one `WebContentsView` per configured app. There is no
build step: `src/main/main.js` is the entry named in `package.json`,
modules are loaded with `require` by relative path and pages with
`loadFile` from `src/pages/`.

## Main process

`src/main/main.js` owns the window and the module state: `cfg`, the
`services` list and `settings` object that `config.load()` reads from
`services.json` and normalizes (`config.js` writes the file back
atomically on every change), `state`, the content of `state.json`
with the window bounds, the active app, remembered favicons,
permission grants per app, permission and origin, approved `launch`
commands and partitions to purge (saved with a 500 ms debounce and
before quitting), `views`, a `Map` from app id to `ServiceView`, and
`accounts`, a `Map` from app id to the `MailAccount` or `GhTracker`
behind a built-in app.

The main window is a `BrowserWindow` that loads the sidebar page, and
the app views, the context menu view and the welcome view are children
of its `contentView`. Settings, add, prompt and properties are
separate `BrowserWindow` dialogs.

## One view per app

`ServiceView` in `src/main/views.js` builds a `WebContentsView` with
`partition: persist:<partition>`, so cookies, storage and logins stay
in that partition, and two entries given the same `partition` share
one session on purpose. The preload is `src/main/preload-service.js`
for a web app, which bridges `Notification` to the main process, or
the page preload of a built-in type. `setupSession()` runs once per
partition and installs the permission, display capture and download
handlers. A view loads `svc.url`, or for the types `gmail` and
`github-tracker` the pages `mail.html` and `gh.html`.

## Built-in pages

Each page lives in `src/pages/<page>/` as `<page>.html`, `<page>.js`,
an optional `<page>.css` and a `preload.js`: `sidebar`, `menu`,
`props`, `add`, `settings`, `welcome`, `prompt`, `mail` and `gh`. A
page runs sandboxed with context isolation and no Node integration,
and its preload exposes one small object through `contextBridge`
whose methods map to `ipcRenderer.invoke`, `send` and `on`.

## IPC

Every `ipcMain.handle` and `ipcMain.on` call goes through
`src/main/ipc.js`. `guard(allowed, fn)` runs the handler only when
`allowed(event)` returns the context it works on (a window, a view or
an account) and throws `ipc: sender not allowed` otherwise, and
`guardOn` is the `on` counterpart that drops the message. The
predicates (`fromSidebar`, `fromMenu`, `fromProps`, `fromView`,
`fromPrompt` and the like) compare `event.sender` with the
`webContents` of one window or view. For the mail and tracker pages
`ownPage()` also requires the sender URL to start with `file://`, so
a site that navigated the view never reaches the account behind it.

Channel names carry the page or subsystem as prefix: `appbox:*` for
the sidebar, the menu, the welcome page, the properties dialog
(`appbox:props-*`) and the notifications of the app views,
`settings:*`, `add:*` and `prompt:*` for the dialogs, `mail:*` and
`gh:*` for the built-in apps, and `menu:open` for the data pushed to
the context menu view. Updates from the main process arrive as
`appbox:update`, `appbox:status`, `mail:event` and `gh:event`.

## Accounts

`MailAccount` in `src/mail/gmail.js` and `GhTracker` in
`src/tracker/ghtrack.js` extend `EventEmitter` and share one
lifecycle: the constructor takes the service entry `svc` and a `ctx`,
`init()` reads the stored secret through `safeStorage` when the
keyring is secure and starts the connections or the polling, `stop()`
clears timers and connections, `forget()` logs out and removes the
per-account files, and `status()` returns the snapshot the page
renders. The `ctx` built in `main.js` offers `onBadge(id, n)`,
`onProgress(id, p)`, `patch(id, patch)`, `notify({ title, body,
onClick })` and `activate(id)`. The events `status`, `list`,
`folders` and `open` of the mail account and `status` and `data` of
the tracker are forwarded to the page as `mail:event` and `gh:event`.

## Command line

`src/main/cli.js` handles the one-shot flags before the app starts:
`--version`, `--export-profile [file] [--with-sessions]`,
`--import-profile <file> [--yes]` and `--autostart on|off`, with the
passphrase taken from `APPBOX_PASSPHRASE`. `main.js` handles
`--show`, `--hidden` and `--quit` and holds the single instance lock:
a second start raises the window, or quits the running instance when
started with `--quit`.

## Profile export format

A profile is a `tar.gz` with `manifest.json` (`app`, `version`,
`exported_at`, `host`, `sessions`), `config/services.json`,
`state/state.json` and, when the sessions are included,
`state/mail-accounts.json`, `state/mail-trust.json`,
`state/gh-tokens.json` and `sessions/` with the partitions minus the
Chromium caches. Including the sessions requires a passphrase of at
least eight characters. With a passphrase the file is encrypted: the
magic `APPBOXENC1`, a 16 byte scrypt salt, a 12 byte nonce, the
AES-256-GCM ciphertext and the 16 byte tag, the key derived with
scrypt (N 2^15, r 8, p 1). An import is staged in the cache directory
after checking the entry names and sizes and applied at the next
start before any window exists.

## Data directories

- `$XDG_CONFIG_HOME/appbox`: `services.json` (`APPBOX_CONFIG`
  overrides it). The autostart entry is written to
  `$XDG_CONFIG_HOME/autostart/io.github.sylvioalves.appbox.desktop`.
- `$XDG_STATE_HOME/appbox`: `state.json`, the keyring-encrypted
  `mail-accounts.json`, `mail-trust.json` and `gh-tokens.json`,
  `mail-cache/<id>.json` and `gh/<id>.json`.
- `$XDG_DATA_HOME/appbox`: Electron's `userData` and `sessionData`,
  with one Chromium profile per partition under `Partitions/`.
- `$XDG_CACHE_HOME/appbox`: the Node compile cache, the export
  staging trees, `import-staging/` and `pending-import.json`.

The four directories are created with mode 0700.

## Security model

- Every renderer runs with the Chromium sandbox, context isolation
  and no Node integration, and the `webview` tag is denied.
- Every built-in page carries a `Content-Security-Policy` meta tag
  with `default-src 'none'` that allows only its own resources.
- Every IPC channel is guarded by a sender check, and the built-in
  app pages are reached only from a `file://` main frame.
- Secrets go through `safeStorage` only when a real keyring backend
  is selected, otherwise the app refuses to store them.
- Browser permissions are granted per app, permission and exact
  origin, never to the sign-in hosts, and remembered in `state.json`.
