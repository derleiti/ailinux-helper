#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
# Reproducible installed-package permissions even under a restrictive shell umask.
umask 022
# FPM copies this icon separately from the afterPack application tree.
icon_dir=$(mktemp -d)
trap 'rm -rf -- "$icon_dir"' EXIT
install -m 0644 ../../assets/desktop/icon.png "$icon_dir/icon.png"
./node_modules/.bin/electron-builder --linux AppImage deb "$@" --config.linux.icon="$icon_dir/icon.png"
version=$(node -p 'require("./package.json").version')
shopt -s nullglob
packages=(dist/AILinux-Helper-"$version"-linux-*.deb)
(( ${#packages[@]} > 0 )) || { echo "No Linux DEB generated" >&2; exit 1; }
for package in "${packages[@]}"; do
    python3 ../../scripts/verify-linux-deb.py "$package" --version "$version"
done
