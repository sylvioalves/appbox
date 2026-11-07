#!/bin/sh
# Runs the checks a change must pass before it is pushed: syntax of
# every script, the tests, the page layout, the shell files, ASCII
# only content, agreement of the version numbers and the AppStream
# metadata. One line is printed per step and the exit status is
# non-zero when any step failed.
#
# Linting is optional and not part of this script: `npx eslint src
# test` applies the core rules in eslint.config.js through the eslint
# that npx fetches, so it needs network access once and nothing in
# package.json.
set -u
cd "$(dirname "$0")/.." || exit 1

status=0
pass() { echo "ok   $1"; }
fail() { echo "FAIL $1"; status=1; }

bad=
for f in $(find src bin scripts test -name '*.js' | sort); do
  node --check "$f" 2>/dev/null || bad="$bad $f"
done
if [ -z "$bad" ]; then pass "syntax"; else fail "syntax:$bad"; fi

out=$(node --test test/*.test.js 2>&1)
if [ $? -eq 0 ]; then
  pass "tests ($(printf '%s\n' "$out" | sed -n 's/^.* pass \([0-9]*\)$/\1/p' | head -n 1) passed)"
else
  printf '%s\n' "$out"
  fail "tests"
fi

bad=
for d in src/pages/*/; do
  page=$(basename "$d")
  [ -f "$d$page.html" ] && [ -f "${d}preload.js" ] || bad="$bad $page"
done
if [ -z "$bad" ]; then pass "pages"; else fail "pages:$bad"; fi

if sh -n install.sh && sh -n bin/appbox && sh -n packaging/flatpak/appbox && sh -n scripts/check.sh; then
  pass "shell"
else
  fail "shell"
fi

hits=$(git ls-files | grep -v '\.png$' | LC_ALL=C xargs grep -l '[^[:print:][:space:]]')
if [ -z "$hits" ]; then pass "ascii"; else fail "ascii: $(echo $hits)"; fi

pkg=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' package.json)
pkgver=$(sed -n 's/^pkgver=//p' packaging/arch/PKGBUILD)
log=$(sed -n 's/^## \[\([0-9][^]]*\)\].*/\1/p' CHANGELOG.md | head -n 1)
meta=$(sed -n 's/.*<release version="\([^"]*\)".*/\1/p' packaging/*.metainfo.xml | head -n 1)
flat=$(sed -n 's/^ *tag: v//p' packaging/flatpak/*.yml | head -n 1)
if [ -n "$pkg" ] && [ "$pkg" = "$pkgver" ] && [ "$pkg" = "$log" ] && [ "$pkg" = "$meta" ] && [ "$pkg" = "$flat" ]; then
  pass "version $pkg"
else
  fail "version: package.json $pkg, PKGBUILD $pkgver, CHANGELOG $log, metainfo $meta, flatpak $flat"
fi

if command -v appstreamcli >/dev/null 2>&1; then
  out=$(appstreamcli validate --no-net packaging/*.metainfo.xml 2>&1)
  if [ $? -eq 0 ]; then pass "appstream"; else printf '%s\n' "$out"; fail "appstream"; fi
else
  pass "appstream (skipped, appstreamcli not installed)"
fi

exit $status
