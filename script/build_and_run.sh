#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"
APP_NAME="VideoOSStudio"
BUNDLE_ID="com.videoos.studio"
MIN_SYSTEM_VERSION="14.0"
MIN_VERIFY_WINDOW_WIDTH=900
MIN_VERIFY_WINDOW_HEIGHT=600

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
APP_BUNDLE="$DIST_DIR/$APP_NAME.app"
APP_CONTENTS="$APP_BUNDLE/Contents"
APP_MACOS="$APP_CONTENTS/MacOS"
APP_RESOURCES="$APP_CONTENTS/Resources"
APP_BINARY="$APP_MACOS/$APP_NAME"
INFO_PLIST="$APP_CONTENTS/Info.plist"
PKG_INFO="$APP_CONTENTS/PkgInfo"

pkill -x "$APP_NAME" >/dev/null 2>&1 || true

swift build --package-path "$ROOT_DIR"
BUILD_BINARY="$(swift build --package-path "$ROOT_DIR" --show-bin-path)/$APP_NAME"

rm -rf "$APP_BUNDLE"
mkdir -p "$APP_MACOS"
mkdir -p "$APP_RESOURCES"
cp "$BUILD_BINARY" "$APP_BINARY"
chmod +x "$APP_BINARY"

cat >"$INFO_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>$APP_NAME</string>
  <key>CFBundleIdentifier</key>
  <string>$BUNDLE_ID</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>$APP_NAME</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>$MIN_SYSTEM_VERSION</string>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
  <key>VideoOSStudioRepositoryRoot</key>
  <string>$ROOT_DIR</string>
</dict>
</plist>
PLIST
printf 'APPL????' >"$PKG_INFO"

/usr/bin/xattr -cr "$APP_BUNDLE" >/dev/null 2>&1 || true
/usr/bin/codesign --force --deep --sign - "$APP_BUNDLE" >/dev/null

open_app() {
  /usr/bin/open -n "$APP_BUNDLE"
}

case "$MODE" in
  run)
    open_app
    ;;
  --debug|debug)
    lldb -- "$APP_BINARY"
    ;;
  --logs|logs)
    open_app
    /usr/bin/log stream --info --style compact --predicate "process == \"$APP_NAME\""
    ;;
  --telemetry|telemetry)
    open_app
    /usr/bin/log stream --info --style compact --predicate "subsystem == \"$BUNDLE_ID\""
    ;;
  --verify|verify)
    open_app
    WINDOW_COUNT="0"
    for _ in {1..40}; do
      sleep 0.5
      if ! pgrep -x "$APP_NAME" >/dev/null; then
        open_app
        continue
      fi
      WINDOW_COUNT="$(swift -e 'import CoreGraphics; let windows = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []; let count = windows.filter { window in guard (window[kCGWindowOwnerName as String] as? String) == "'"$APP_NAME"'", (window[kCGWindowLayer as String] as? Int) == 0, (window[kCGWindowName as String] as? String) == "Video OS Studio", let bounds = window[kCGWindowBounds as String] as? [String: Any], let width = bounds["Width"] as? Int, let height = bounds["Height"] as? Int else { return false }; return width >= '"$MIN_VERIFY_WINDOW_WIDTH"' && height >= '"$MIN_VERIFY_WINDOW_HEIGHT"' }.count; print(count)')"
      if [[ "$WINDOW_COUNT" -lt 1 ]]; then
        WINDOW_COUNT="$(osascript <<APPLESCRIPT 2>/dev/null || printf '0'
tell application "System Events"
  tell process "$APP_NAME"
    repeat with candidateWindow in windows
      if name of candidateWindow is "Video OS Studio" then
        set windowSize to size of candidateWindow
        set isMinimized to value of attribute "AXMinimized" of candidateWindow
        if isMinimized is false and item 1 of windowSize >= $MIN_VERIFY_WINDOW_WIDTH and item 2 of windowSize >= $MIN_VERIFY_WINDOW_HEIGHT then
          return 1
        end if
      end if
    end repeat
  end tell
end tell
return 0
APPLESCRIPT
)"
      fi
      if [[ "$WINDOW_COUNT" -ge 1 ]]; then
        break
      fi
    done
    if [[ "$WINDOW_COUNT" -lt 1 ]]; then
      echo "$APP_NAME launched but no visible main window was created" >&2
      exit 1
    fi
    ;;
  *)
    echo "usage: $0 [run|--debug|--logs|--telemetry|--verify]" >&2
    exit 2
    ;;
esac
