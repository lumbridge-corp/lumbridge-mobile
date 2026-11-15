#!/usr/bin/env bash
# Runs on a Linux build machine with the Android SDK and NDK and a JDK 17. Builds an arm64 APK of the Tauri shell.
#
#   scripts/build-android.sh            a signed RELEASE APK: the one to install and to hand to anyone
#   scripts/build-android.sh --debug    a debug APK, for development only (see the warning it prints)
#
# A release build is signed with your own keystore, given by these variables. Nothing about it is written to disk
# here: gradle reads them from the environment at build time, so no password lands in gen/ or in git.
#   LUMBRIDGE_ANDROID_KEYSTORE           path to the .jks/.keystore file
#   LUMBRIDGE_ANDROID_KEYSTORE_PASSWORD  the store's password
#   LUMBRIDGE_ANDROID_KEY_ALIAS          the key's alias in it
#   LUMBRIDGE_ANDROID_KEY_PASSWORD       the key's password (defaults to the store's)
# Make one once with, for example:
#   keytool -genkeypair -v -keystore ~/lumbridge-release.jks -keyalg RSA -keysize 4096 -validity 10000 -alias lumbridge
# Keep it, and its passwords, outside this repository: an update to an installed app has to be signed with the same key.
#
# JAVA_HOME, ANDROID_HOME and NDK_HOME are used as set; otherwise ~/.local/opt/jdk17, ~/Android/Sdk and its newest NDK.
set -euo pipefail

mode=release
case "${1:-}" in
  "") ;;
  --debug) mode=debug ;;
  -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
  *) echo "unknown option: $1 (use --debug for a development build)" >&2; exit 2 ;;
esac

if [ "$mode" = release ]; then
  : "${LUMBRIDGE_ANDROID_KEYSTORE:?set LUMBRIDGE_ANDROID_KEYSTORE to your release keystore (or pass --debug for a development build)}"
  : "${LUMBRIDGE_ANDROID_KEYSTORE_PASSWORD:?set LUMBRIDGE_ANDROID_KEYSTORE_PASSWORD}"
  : "${LUMBRIDGE_ANDROID_KEY_ALIAS:?set LUMBRIDGE_ANDROID_KEY_ALIAS}"
  export LUMBRIDGE_ANDROID_KEY_PASSWORD="${LUMBRIDGE_ANDROID_KEY_PASSWORD:-$LUMBRIDGE_ANDROID_KEYSTORE_PASSWORD}"
  [ -f "$LUMBRIDGE_ANDROID_KEYSTORE" ] || { echo "no keystore at $LUMBRIDGE_ANDROID_KEYSTORE" >&2; exit 1; }
  LUMBRIDGE_ANDROID_KEYSTORE="$(cd "$(dirname "$LUMBRIDGE_ANDROID_KEYSTORE")" && pwd)/$(basename "$LUMBRIDGE_ANDROID_KEYSTORE")"
  export LUMBRIDGE_ANDROID_KEYSTORE LUMBRIDGE_ANDROID_KEYSTORE_PASSWORD LUMBRIDGE_ANDROID_KEY_ALIAS
else
  cat >&2 <<'WARN'
WARNING: building a DEBUG APK. It is for development on your own phone only:
  - the app is marked debuggable, and its WebView can be inspected over USB (chrome://inspect),
  - so anyone with USB access to the unlocked phone can read the device token, which opens your terminals.
Don't install it on a phone you carry day to day, and don't give it to anyone. Build without --debug for that.
WARN
fi

export JAVA_HOME="${JAVA_HOME:-$HOME/.local/opt/jdk17}" ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
export NDK_HOME="${NDK_HOME:-$ANDROID_HOME/ndk/$(ls "$ANDROID_HOME/ndk" | tail -1)}"
export PATH="$JAVA_HOME/bin:$HOME/.cargo/bin:$PATH"
cd "$(dirname "$0")/../app/src-tauri"
cargo tauri --version >/dev/null 2>&1 || cargo install tauri-cli --version '^2' --locked
cargo tauri icon ../../web/public/icon-512.png >/dev/null
[ -d gen/android ] || cargo tauri android init

# The assistant's tab needs the mic. gen/ is generated, so this is added here rather than committed.
manifest=gen/android/app/src/main/AndroidManifest.xml
grep -q RECORD_AUDIO "$manifest" || sed -i 's#<uses-permission android:name="android.permission.INTERNET" />#&\n    <uses-permission android:name="android.permission.RECORD_AUDIO" />\n    <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />#' "$manifest"
grep -q RECORD_AUDIO "$manifest"

# Release signing, the Tauri v2 way (a signingConfig on the release build type), added here for the same reason. It reads
# the keystore and passwords from the environment when gradle runs; with LUMBRIDGE_ANDROID_KEYSTORE unset it does nothing.
gradle=gen/android/app/build.gradle.kts
grep -q 'LUMBRIDGE_ANDROID_KEYSTORE' "$gradle" || cat >>"$gradle" <<'KTS'

// Release signing from the environment (added by scripts/build-android.sh; no key or password is stored in this file).
android {
    System.getenv("LUMBRIDGE_ANDROID_KEYSTORE")?.takeIf { it.isNotEmpty() }?.let { keystore ->
        signingConfigs {
            create("release") {
                storeFile = file(keystore)
                storePassword = System.getenv("LUMBRIDGE_ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("LUMBRIDGE_ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("LUMBRIDGE_ANDROID_KEY_PASSWORD")
            }
        }
        buildTypes.getByName("release").signingConfig = signingConfigs.getByName("release")
    }
}
KTS
grep -q 'LUMBRIDGE_ANDROID_KEYSTORE' "$gradle"

if [ "$mode" = release ]; then
  # Release: not debuggable, WebView inspection off (Tauri/wry only turn it on in debug builds), Rust stripped with thin LTO.
  cargo tauri android build --apk --target aarch64
  apk="$(find gen/android -path '*release*' -name '*.apk' -newer tauri.conf.json -print | head -1)"
  [ -n "$apk" ] || { echo "no release APK was produced" >&2; exit 1; }
  case "$apk" in *unsigned*) echo "the APK is unsigned: $apk" >&2; exit 1 ;; esac
  apksigner="$(ls "$ANDROID_HOME"/build-tools/*/apksigner 2>/dev/null | tail -1)"
  [ -z "$apksigner" ] || "$apksigner" verify "$apk"
  echo "$apk"
else
  # A debug-signed build without debug info: it's 134 MB with it.
  CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_DEV_OPT_LEVEL=s cargo tauri android build --debug --apk --target aarch64
  find gen/android -name '*.apk' -newer tauri.conf.json -print
  echo "WARNING: that is a DEBUG APK (inspectable WebView). For development only." >&2
fi
