#!/bin/sh
# Builds a Debian package of Appbox with the Electron release pinned in
# the Flatpak manifest bundled under /usr/lib/appbox/electron, since
# Debian and Ubuntu do not package Electron.
# Usage: packaging/deb/build.sh amd64|arm64 [git ref] [output dir]
# ELECTRON_ZIP points at an already downloaded Electron zip.
set -eu

arch=${1:?usage: build.sh amd64|arm64 [git ref] [output dir]}
ref=${2:-HEAD}
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
out=$(mkdir -p "${3:-$here}" && cd "${3:-$here}" && pwd)

case $arch in
  amd64) zarch=x64 ;;
  arm64) zarch=arm64 ;;
  *) echo "build.sh: unknown architecture $arch" >&2; exit 1 ;;
esac

manifest=$repo/packaging/flatpak/io.github.sylvioalves.appbox.yml
url=$(sed -n "s/^ *url: \(https:.*electron-v[0-9.]*-linux-$zarch\.zip\)$/\1/p" "$manifest")
sha=$(grep -A1 -F "url: $url" "$manifest" | sed -n 's/^ *sha256: *//p')
if [ -z "$url" ] || [ -z "$sha" ]; then
  echo "build.sh: no Electron $zarch zip in $manifest" >&2
  exit 1
fi

version=$(git -C "$repo" describe --tags --match 'v*' --abbrev=7 "$ref" |
  sed 's/^v//;s/-\([0-9]*\)-g/+r\1.g/')
maintainer=$(git -C "$repo" log -1 --format='%an <%ae>' "$ref")

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
root=$work/root
lib=$root/usr/lib/appbox
id=io.github.sylvioalves.appbox

zip=${ELECTRON_ZIP:-$work/electron.zip}
[ -f "$zip" ] || curl -fsSL -o "$zip" "$url"
echo "$sha  $zip" | sha256sum -c --quiet

install -d "$lib/electron" "$work/src"
git -C "$repo" archive --format=tar "$ref" package.json LICENSE README.md src assets packaging |
  tar -x -C "$work/src"
cp -r "$work/src/package.json" "$work/src/LICENSE" "$work/src/README.md" \
  "$work/src/src" "$work/src/assets" "$lib/"
unzip -q "$zip" -d "$lib/electron"
mv "$lib/electron/electron" "$lib/electron/appbox"
find "$lib" -type d -exec chmod 755 {} +
find "$lib" -path "$lib/electron" -prune -o -type f -exec chmod 644 {} +
chmod 4755 "$lib/electron/chrome-sandbox"
install -m644 "$here/appbox.apparmor" "$lib/apparmor-profile"

install -d "$root/usr/bin"
cat > "$root/usr/bin/appbox" <<'LAUNCHER'
#!/bin/sh
unset ELECTRON_RUN_AS_NODE NODE_OPTIONS NODE_EXTRA_CA_CERTS
: "${ELECTRON_IS_DEV:=0}"; export ELECTRON_IS_DEV
: "${ELECTRON_FORCE_IS_PACKAGED:=true}"; export ELECTRON_FORCE_IS_PACKAGED
APPBOX_LAUNCHER=/usr/bin/appbox; export APPBOX_LAUNCHER
exec /usr/lib/appbox/electron/appbox /usr/lib/appbox "$@"
LAUNCHER
chmod 755 "$root/usr/bin/appbox"

src=$work/src
install -Dm644 "$src/packaging/$id.desktop" "$root/usr/share/applications/$id.desktop"
install -Dm644 "$src/packaging/$id.metainfo.xml" "$root/usr/share/metainfo/$id.metainfo.xml"
install -Dm644 "$src/assets/appbox.svg" "$root/usr/share/icons/hicolor/scalable/apps/$id.svg"
install -Dm644 "$src/assets/appbox.png" "$root/usr/share/icons/hicolor/256x256/apps/$id.png"
install -d "$root/usr/share/doc/appbox"
{
  echo 'Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/'
  echo 'Upstream-Name: appbox'
  echo 'Source: https://github.com/sylvioalves/appbox'
  echo
  echo 'Files: *'
  echo 'License: MIT'
  sed 's/^$/./;s/^/ /' "$src/LICENSE"
  echo
  echo 'Files: usr/lib/appbox/electron/*'
  echo 'Copyright: Electron contributors, The Chromium Authors'
  echo 'License: MIT and others, see LICENSE and LICENSES.chromium.html in that directory'
} > "$root/usr/share/doc/appbox/copyright"

install -d "$root/DEBIAN"
install -m755 "$here/postinst" "$here/postrm" "$root/DEBIAN/"
cat > "$root/DEBIAN/control" <<CONTROL
Package: appbox
Version: $version
Architecture: $arch
Maintainer: $maintainer
Installed-Size: $(du -sk "$root/usr" | cut -f1)
Depends: libasound2t64 | libasound2, libatk-bridge2.0-0t64 | libatk-bridge2.0-0, libatk1.0-0t64 | libatk1.0-0, libatspi2.0-0t64 | libatspi2.0-0, libc6 (>= 2.25), libcairo2, libcups2t64 | libcups2, libdbus-1-3, libdrm2, libexpat1, libgbm1, libgcc-s1, libglib2.0-0t64 | libglib2.0-0, libgtk-3-0t64 | libgtk-3-0, libnspr4, libnss3, libpango-1.0-0, libsecret-1-0, libudev1, libx11-6, libxcb1, libxcomposite1, libxdamage1, libxext6, libxfixes3, libxkbcommon0, libxrandr2, xdg-utils
Section: web
Priority: optional
Homepage: https://github.com/sylvioalves/appbox
Description: Web app manager: one window, one isolated session per service
 Appbox keeps your web apps in one window, each in its own isolated
 session, with a sidebar to switch between them. It ships a GitHub
 tracker that lists the pull requests waiting on you.
 .
 This package bundles the Electron release it was built with.
CONTROL

deb=$out/appbox_${version}_$arch.deb
dpkg-deb --root-owner-group -Zxz --build "$root" "$deb" >/dev/null
echo "$deb"
