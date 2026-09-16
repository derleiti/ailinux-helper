#!/usr/bin/env python3
"""Regenerate release.json from a trusted local AILinux Helper artifact mirror."""
from __future__ import annotations
import argparse, hashlib, json
from pathlib import Path

ARTIFACTS = {
    "android": ("AILinux-Helper-{v}-android.apk", "application/vnd.android.package-archive"),
    "android-arm64": ("ailinux-helper-{v}-android-arm64", "application/octet-stream"),
    "linux-appimage": ("AILinux-Helper-{v}-linux-x86_64.AppImage", "application/vnd.appimage"),
    "linux-deb": ("AILinux-Helper-{v}-linux-amd64.deb", "application/vnd.debian.binary-package"),
    "linux-binary": ("ailinux-helper-{v}-linux-x86_64", "application/octet-stream"),
    "windows": ("AILinux-Helper-{v}-win-x64.exe", "application/vnd.microsoft.portable-executable"),
    "windows-capsule": ("ailinux-helper-{v}-windows-x86_64.exe", "application/vnd.microsoft.portable-executable"),
    "macos": ("AILinux-Helper-{v}-mac-arm64.dmg", "application/x-apple-diskimage"),
    "macos-pkg": ("ailinux-helper-{v}-macos.pkg", "application/vnd.apple.installer+xml"),
    "macos-universal": ("ailinux-helper-{v}-macos-universal", "application/octet-stream"),
    "arch": ("ailinux-helper-capsule-{v}-1-x86_64.pkg.tar.zst", "application/zstd"),
    "freebsd": ("ailinux-helper-{v}-freebsd-x86_64", "application/octet-stream"),
    "openbsd": ("ailinux-helper-{v}-openbsd-x86_64", "application/octet-stream"),
    "ios": ("ailinux-helper-{v}-ios-unsigned.ipa", "application/octet-stream"),
    "ios-simulator": ("ailinux-helper-{v}-ios-simulator.app.zip", "application/zip"),
}
PYODIDE_VERSION = "v314.0.6"
PYODIDE_FILES = ("pyodide.js", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json")

def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", required=True)
    parser.add_argument("--release-dir", required=True, type=Path)
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    version = args.version.removeprefix("v")
    root = args.repo_root.resolve()
    artifacts = {}
    missing = []
    for platform, (template, media_type) in ARTIFACTS.items():
        path = args.release_dir / template.format(v=version)
        if not path.is_file():
            missing.append(str(path))
            continue
        artifacts[platform] = {
            "filename": path.name,
            "media_type": media_type,
            "size": path.stat().st_size,
            "sha256": digest(path),
        }
    if missing:
        raise SystemExit("Missing required release artifacts:\n" + "\n".join(missing))
    pyroot = root / "apps/web/vendor/pyodide" / PYODIDE_VERSION
    pyfiles = {}
    for name in PYODIDE_FILES:
        path = pyroot / name
        if not path.is_file():
            raise SystemExit(f"Missing Pyodide asset: {path}")
        pyfiles[name] = {"size": path.stat().st_size, "sha256": digest(path)}
    document = {
        "schema_version": 1,
        "helper_version": version,
        "source_tag": f"v{version}",
        "artifacts": artifacts,
        "aliases": {"linux": "linux-appimage"},
        "webmcp": {
            "source_dir": "apps/web",
            "script": "app.js",
            "stylesheet": "styles.css",
            "worker": "pyodide-worker.js",
            "service_worker": "sw.js",
            "pyodide": {
                "version": PYODIDE_VERSION,
                "base_path": f"/v1/mcp/pyodide/{PYODIDE_VERSION}/",
                "files": pyfiles,
            },
            "threat_model": {
                "electron_preload_privileged": True,
                "third_party_scripts_allowed": False,
                "cloudflare_beacon_allowed": False,
            },
        },
    }
    output = args.output or root / "release.json"
    output.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n")
    print(output)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
