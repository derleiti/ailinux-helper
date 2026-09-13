#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
for f in assets/brand/ailinux-helper-base.svg assets/brand/ailinux-helper-master.png assets/desktop/icon.png assets/desktop/icon.ico apps/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png apps/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml; do test -s "$root/$f" || { echo "missing asset: $f" >&2; exit 1; }; done
file "$root/assets/desktop/icon.png" "$root/assets/desktop/icon.ico" "$root/apps/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png"
