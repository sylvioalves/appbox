#!/bin/sh
# Installs Appbox for the current user: sources under ~/.local/lib,
# launcher in ~/.local/bin, desktop entry and icons in the XDG dirs.
# Usage: ./install.sh [--uninstall]
set -e

src=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
data=${XDG_DATA_HOME:-$HOME/.local/share}
lib=$HOME/.local/lib/appbox
bin=$HOME/.local/bin
apps=$data/applications
icons=$data/icons/hicolor
meta=$data/metainfo
id=io.github.sylvioalves.appbox

if [ "$1" = "--uninstall" ]; then
  rm -rf "$lib"
  rm -f "$bin/appbox" "$apps/$id.desktop" "$meta/$id.metainfo.xml" \
        "$icons/scalable/apps/$id.svg" "$icons/256x256/apps/$id.png"
  command -v update-desktop-database >/dev/null && update-desktop-database "$apps" 2>/dev/null || true
  command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t "$icons" 2>/dev/null || true
  echo "Appbox removed (configuration and sessions were kept)"
  exit 0
fi

mkdir -p "$lib/assets/icons" "$lib/bin" "$bin" "$apps" "$meta" \
         "$icons/scalable/apps" "$icons/256x256/apps"
rm -rf "$lib/src"
cp -R "$src/src" "$lib/src"
find "$lib/src" -type d -exec chmod 755 {} + -o -type f -exec chmod 644 {} +
install -m644 "$src/package.json" "$lib/package.json"
install -m644 "$src/assets/appbox.svg" "$src/assets/appbox.png" \
              "$src/assets/tray.png" "$src/assets/tray-unread.png" "$lib/assets/"
install -m644 "$src"/assets/icons/*.svg "$lib/assets/icons/"
install -m755 "$src/bin/appbox" "$lib/bin/appbox"
ln -sfn "$lib/bin/appbox" "$bin/appbox"
install -m644 "$src/assets/appbox.svg" "$icons/scalable/apps/$id.svg"
install -m644 "$src/assets/appbox.png" "$icons/256x256/apps/$id.png"
install -m644 "$src/packaging/$id.metainfo.xml" "$meta/$id.metainfo.xml"

quoted=$(printf '%s' "$bin/appbox" | sed 's/[\\"`$]/\\&/g; s/%/%%/g')
{
  grep -v '^Exec=' "$src/packaging/$id.desktop"
  printf 'Exec="%s"\n' "$quoted"
} > "$apps/$id.desktop"

command -v update-desktop-database >/dev/null && update-desktop-database "$apps" 2>/dev/null || true
command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t "$icons" 2>/dev/null || true

version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$src/package.json")
echo "Appbox $version installed: launcher $bin/appbox, sources $lib"
case ":$PATH:" in
  *":$bin:"*) ;;
  *) echo "note: $bin is not in PATH; the desktop entry uses the full path" ;;
esac
