# Contributing

Appbox is plain JavaScript loaded by the system Electron package.
There is no build step and there are no dependencies to install.
`docs/architecture.md` describes how the pieces fit together, and
`SECURITY.md` says how to report a vulnerability privately.

## Running from source

```
./bin/appbox
```

The launcher looks for Electron under `/usr/lib/electron44` and a
few other paths, and `ELECTRON_BIN` points it elsewhere. Set
`APPBOX_CONFIG` to a scratch services file to keep your own apps and
sessions out of the way while testing, or point `XDG_CONFIG_HOME`,
`XDG_STATE_HOME`, `XDG_DATA_HOME` and `XDG_CACHE_HOME` at a scratch
directory to start from nothing.

## Checking a change

```
sh scripts/check.sh
```

The script parses every JavaScript file, runs the tests, verifies
that every page directory holds its html and preload, checks the
shell scripts, rejects non-ASCII content, and compares the version
in `package.json`, the PKGBUILD, the changelog and the metainfo.
The same script runs in CI on every push and pull request. Linting
is optional and fetched on demand:

```
npx --yes eslint@9 src test
```

Then run the app and exercise the part you changed.

## Tests

Tests live in `test/<module>.test.js` and use `node:test` with
`node:assert/strict`, so `node --test test/*.test.js` runs them without
Electron. They cover the modules that load without Electron: the
parsers in `src/mail`, the configuration, the catalog and the
profile. To add one, create or extend the file named after the
module, require the module by relative path, and keep each test
independent of the others and of the user's directories: set `HOME`
and the XDG variables to a temporary directory before requiring a
module that reads them, as the config and profile tests do.

## Style

- Comments use the `/* */` form, with text on the first line and
  the closing `*/` alone on its last line when they span several.
- Every file is ASCII. A non-ASCII character in a string or a regex
  is written as a `\uXXXX` escape.
- Match the style of the surrounding code: two-space indentation,
  single quotes, semicolons, explicit comparisons.

## Commits

One logical change per commit. The title is `area: imperative
summary`, lowercase, where the area is the directory or subsystem
the change touches: `app`, `mail`, `gh`, `profile`, `docs`,
`scripts`, `repo`, `release`. The body says what the change does and
why, wrapped at 65 columns. Every commit carries a `Signed-off-by:`
line (`git commit -s`), which certifies the Developer Certificate of
Origin for the work.

Open pull requests against `main`. Small, focused pull requests are
reviewed faster than large ones.

## Versioning

Releases follow semantic versioning: MAJOR when the configuration
or a data format changes incompatibly, MINOR for new features, PATCH
for fixes. The version lives in `package.json` and is mirrored by
the PKGBUILD, the newest `CHANGELOG.md` entry, the metainfo release
list and the tag `vX.Y.Z`. `scripts/check.sh` enforces the match.

## Security issues

Do not open a public issue for a vulnerability. See `SECURITY.md`
for how to report one privately.
