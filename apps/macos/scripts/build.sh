#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
configuration="${CONFIGURATION:-release}"
swift build -c "$configuration" "$@"
binary_dir="$(swift build -c "$configuration" "$@" --show-bin-path)"
bundle="$PWD/build/Karakeep Capture.app"
mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources"
cp "$binary_dir/KarakeepCapture" "$bundle/Contents/MacOS/KarakeepCapture"
cp Resources/Info.plist "$bundle/Contents/Info.plist"
cp Resources/KarakeepStatus.pdf "$bundle/Contents/Resources/KarakeepStatus.pdf"
codesign --force --sign "${CODESIGN_IDENTITY:--}" "$bundle"
printf '%s\n' "$bundle"
