# Security policy

## Supported versions

Only the latest release receives fixes. Update to the newest tag
before reporting a problem.

## Reporting a vulnerability

Do not open a public issue. Send the report by e-mail to the address
on the author's GitHub profile, https://github.com/sylvioalves, with
the version, the steps to reproduce and the impact you see. You get
an acknowledgement within a few days and a fix or a public note once
the issue is understood.

## What Appbox protects

- Every renderer, including the sidebar, the dialogs, each web app
  and the windows opened for outside links, runs with the Chromium
  sandbox, context isolation and no Node integration. Renderers
  reach the main process only through the small preload bridges.
- Each app runs in its own Chromium session. Cookies, storage and
  logins of one app are not visible to another unless two entries
  are given the same `partition` on purpose. A window opened for an
  outside link shares the session of the app it came from.
- Navigation outside an app's allowed hosts opens in the system
  browser, or in a window with the same session when the app is set
  up that way.
- The Gmail app password and the GitHub token are encrypted through
  the system keyring with Electron's `safeStorage`. Without a Secret
  Service keyring unlocked at start, the app refuses to store them.
- A profile export that includes the sessions is encrypted with
  AES-256-GCM under a key derived from a passphrase with scrypt.

## What Appbox does not protect

- The services file, the window state and the mail cache under
  `~/.local/state/appbox/mail-cache` are plain files, readable by
  any process running as your user. The directories are created
  with mode 0700.
- The Chromium profiles under `~/.local/share/appbox/Partitions`
  are stored the way Chromium stores them. Without a desktop keyring
  their cookie and login encryption falls back to a fixed built-in
  key, and the app warns about it once.
- The web apps themselves run remote code inside the sandbox. Appbox
  does not inspect or filter what they do within their own session.
- A profile export without a passphrase is a plain `tar.gz`.
