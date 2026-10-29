#!/bin/sh
# Builds "Wind Tunnel.app" into apps/mac/build/: a release build, the icon rendered by the app
# itself, and an ad-hoc signature (enough to run it on this Mac).
#
#   apps/mac/build.sh [--open]
set -eu
cd "$(dirname "$0")"
HERE=$(pwd)
REPO=$(cd ../.. && pwd)
APP="$HERE/build/Wind Tunnel.app"

swift build -c release
BIN="$(swift build -c release --show-bin-path)/WindTunnel"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/WindTunnel"
sed "s|__REPO_ROOT__|$REPO|" Resources/Info.plist > "$APP/Contents/Info.plist"

# The icon: rendered once by the app's snapshot mode, then cut into the sizes macOS wants.
ICONSET="$HERE/build/AppIcon.iconset"
rm -rf "$ICONSET"
mkdir -p "$ICONSET"
"$BIN" --snapshot icon "$HERE/build/icon-1024.png" 1024 1024
for size in 16 32 128 256 512; do
  sips -z $size $size "$HERE/build/icon-1024.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z $double $double "$HERE/build/icon-1024.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
rm -rf "$ICONSET"

codesign --force --sign - "$APP" >/dev/null
echo "Built $APP"
if [ "${1:-}" = "--open" ]; then open "$APP"; fi
