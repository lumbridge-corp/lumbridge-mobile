#!/usr/bin/env bash
# Runs on a Mac with Xcode. Builds the Tauri shell for an iPhone.
#   APPLE_DEVELOPMENT_TEAM=<team id> scripts/build-ios.sh          a debug build for a connected, registered iPhone
#   APPLE_DEVELOPMENT_TEAM=<team id> scripts/build-ios.sh --ipa    a release .ipa (needs a provisioning profile)
# Notifications don't work in this shell until APNs is wired.
set -euo pipefail
: "${APPLE_DEVELOPMENT_TEAM:?set APPLE_DEVELOPMENT_TEAM to the Apple team id that signs com.lumbridgecorp.mobile}"
export PATH="$HOME/.cargo/bin:$PATH"
root="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$root/web/dist/index.html" ] || (cd "$root/web" && npm ci && npm run build)
cd "$root/app/src-tauri"
rustup target list --installed | grep -q '^aarch64-apple-ios$' || rustup target add aarch64-apple-ios
cargo tauri --version >/dev/null 2>&1 || cargo install tauri-cli --version '^2' --locked
cargo tauri icon ../../web/public/icon-512.png >/dev/null
[ -d gen/apple ] || cargo tauri ios init
# The assistant's tab needs the mic. gen/ is generated, so this is added here rather than committed.
plist="$(find gen/apple -name Info.plist -path '*_iOS*' | head -1)"
[ -n "$plist" ] || { echo "no iOS Info.plist under gen/apple" >&2; exit 1; }
/usr/libexec/PlistBuddy -c 'Print :NSMicrophoneUsageDescription' "$plist" >/dev/null 2>&1 ||
  /usr/libexec/PlistBuddy -c 'Add :NSMicrophoneUsageDescription string Lumbridge uses the microphone when you talk to the assistant.' "$plist"
if [ "${1:-}" = "--ipa" ]; then
  cargo tauri ios build --export-method debugging
  find gen/apple -name '*.ipa' -newer tauri.conf.json -print
else
  cargo tauri ios build --debug
  find gen/apple -name '*.app' -newer tauri.conf.json -maxdepth 6 -print | head -3
fi
