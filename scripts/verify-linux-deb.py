#!/usr/bin/env python3
"""Reject a desktop DEB that a non-root user cannot access."""
from __future__ import annotations

import argparse
from pathlib import Path, PurePosixPath
import subprocess
import tarfile

APP_ROOT = PurePosixPath("opt/AILinux Helper")
REQUIRED = {
    APP_ROOT: "directory",
    APP_ROOT / "ailinux-helper": "executable",
    APP_ROOT / "resources/app.asar": "file",
    PurePosixPath("usr/share/applications/ailinux-helper.desktop"): "file",
}


def verify_payload(members):
    found = set()
    failures = []
    for member in members:
        name = PurePosixPath(member.name)
        if member.name == "." or member.name == "./":
            continue
        found.add(name)
        expected = REQUIRED.get(name)
        if expected == "directory" and not member.isdir():
            failures.append(f"{name}: expected directory")
        elif expected in {"file", "executable"} and not member.isreg():
            failures.append(f"{name}: expected regular file")
        elif expected == "executable" and not member.mode & 0o001:
            failures.append(f"{name}: executable bit missing")
        # All public payload files must be accessible to ordinary users.
        if member.isdir() and (member.mode & 0o005 != 0o005 or member.mode & 0o002):
            failures.append(f"{name}: directory mode {member.mode:04o}")
        elif member.isreg():
            if not member.mode & 0o004:
                failures.append(f"{name}: unreadable file mode {member.mode:04o}")
            if member.mode & 0o100 and not member.mode & 0o001:
                failures.append(f"{name}: executable inaccessible, mode {member.mode:04o}")
            if member.mode & 0o002:
                failures.append(f"{name}: world-writable payload")
    failures.extend(f"missing {name}" for name in sorted(set(REQUIRED) - found))
    return failures


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("package", type=Path)
    parser.add_argument("--version", required=True)
    args = parser.parse_args()
    def field(name):
        return subprocess.check_output(
            ["dpkg-deb", "-f", str(args.package), name], text=True
        ).strip()
    if field("Package") != "ailinux-helper" or field("Version") != args.version:
        raise SystemExit("Unexpected package name/version")
    with subprocess.Popen(
        ["dpkg-deb", "--fsys-tarfile", str(args.package)], stdout=subprocess.PIPE
    ) as proc:
        with tarfile.open(fileobj=proc.stdout, mode="r|*") as tar:
            failures = verify_payload(tar)
        if proc.wait():
            raise SystemExit("Could not read DEB payload")
    if failures:
        raise SystemExit("Linux package permissions invalid:\n" + "\n".join(failures))
    print(f"Validated ordinary-user payload access: {args.package.name}")


if __name__ == "__main__":
    main()
