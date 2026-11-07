# Changelog

All notable changes to Appbox are recorded in this file. The format
follows Keep a Changelog and the version numbers follow semantic
versioning. The version in package.json, the pkgver in the PKGBUILD
and the newest entry below always agree, which scripts/check.sh
verifies.

## [Unreleased]

## [1.0.0] - 2026-11-07

First public release.

### Added

- One window for web apps, each in its own isolated session, with a
  sidebar to switch between them and a catalog of ready-made entries
  for common services plus a custom entry for any address.
- A built-in Gmail client that talks IMAP and SMTP directly, with
  notifications and an unread badge.
- A GitHub tracker that lists the pull requests waiting on you and
  runs saved searches against the repositories you follow.
- Profile export and import, with the sessions included only in an
  archive encrypted with a passphrase.
- A user-level install script, an Arch Linux PKGBUILD and an
  AppStream metainfo file under the id io.github.sylvioalves.appbox.

[Unreleased]: https://github.com/sylvioalves/appbox/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/sylvioalves/appbox/releases/tag/v1.0.0
