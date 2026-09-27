#!/usr/bin/env bash
# Build the Kinterest (kinjar) APK: the guardian/child PWA bundled into a
# Kotlin WebView shell for the attached Pixel 8. Debug-signed by default.
#
# Pattern lifted from charter/android/scripts/publish-carrier-apk.sh,
# simplified: no keystore bridge, no manifest, no publishing step — this
# just builds the APK and reports where it landed.
#
# The APK bundles the BUILT web console (android/app/build.gradle.kts's
# `stageConsoleAssets` task copies `app/dist` into assets/console/ and fails
# loudly if it's missing), so the web build must run first, every time —
# a stale `app/dist` here would ship an old console inside a fresh APK.
#
# --release: assembles the release build type instead of debug. Release
# signing material (android/keystore.properties, git-ignored — see
# android/app/build.gradle.kts's own comment) is owned by whoever runs the
# deploy pipeline and never lives on this machine by default, so a
# --release build here is expected to come out debug-signed unless that
# file is present; it still succeeds either way.
set -euo pipefail
cd "$(dirname "$0")/../.."   # repo root

MODE="debug"
for arg in "$@"; do
    case "$arg" in
        --release) MODE="release" ;;
        --debug) MODE="debug" ;;
        *)
            echo "FATAL: unknown argument '$arg' (expected --debug or --release)" >&2
            exit 1
            ;;
    esac
done

echo "==> Building web console (app/dist)"
( cd app && npm run build ) || { echo "FATAL: web build failed (cd app && npm run build)" >&2; exit 1; }
[ -f app/dist/index.html ] || { echo "FATAL: app/dist/index.html missing after npm run build" >&2; exit 1; }

if [ "$MODE" = "release" ]; then
    echo "==> Assembling release APK (stageConsoleAssets runs as a preBuild dependency)"
    ( cd android && ./gradlew :app:assembleRelease ) || { echo "FATAL: gradlew :app:assembleRelease failed" >&2; exit 1; }
    APK=android/app/build/outputs/apk/release/app-release.apk
    if [ ! -f "$APK" ]; then
        # No android/keystore.properties -> release build type falls back to
        # debug signing (see build.gradle.kts) and AGP names the output
        # app-release-unsigned.apk isn't produced in that case (signingConfig
        # is still set), but cover the unsigned name too just in case.
        ALT=android/app/build/outputs/apk/release/app-release-unsigned.apk
        [ -f "$ALT" ] && APK="$ALT"
    fi
else
    echo "==> Assembling debug APK (stageConsoleAssets runs as a preBuild dependency)"
    ( cd android && ./gradlew :app:assembleDebug ) || { echo "FATAL: gradlew :app:assembleDebug failed" >&2; exit 1; }
    APK=android/app/build/outputs/apk/debug/app-debug.apk
fi

[ -f "$APK" ] || { echo "FATAL: $APK missing after assemble${MODE^}" >&2; exit 1; }

SHA=$(sha256sum "$APK" | cut -d' ' -f1)
SIZE=$(stat -c%s "$APK")

echo "==> Built ($MODE): $APK"
echo "    sha256: $SHA"
echo "    size:   $SIZE bytes"
if [ "$MODE" = "release" ] && [ ! -f android/keystore.properties ]; then
    echo "    note: android/keystore.properties not found — release APK is debug-signed (see build.gradle.kts)"
fi
