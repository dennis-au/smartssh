#!/usr/bin/env python3
"""Credential-free check that a SmartSSH portable exe actually carries its plugins.

Why this exists: an electron-builder portable target is an NSIS stub wrapping a 7z payload, and the
payload is the only thing that tells you what the exe will do at runtime. Run 19's payload had 362
entries and zero `resources/builtin-plugins` entries, so the app threw "Did not find any bootstrap
components", no terminal plugin loaded, and `data/metrics.json` could never be written — while every
build step stayed green. This script reads that payload with no token, no 7-Zip install and no
Windows host, so anyone holding the exe can settle the question in one command.

Usage (needs py7zr; `uv` fetches it without touching the system Python):

    uv run --with py7zr python3 smartssh/verify/verify-exe.py dist/smartssh-1.0.241-portable-x64.exe

Exit codes: 0 = every check passed, 1 = at least one failed, 2 = the file is not a portable exe.

The exe is opened read-only; only the terminal bundle is extracted, into a temporary directory that
is removed before exit.
"""
import io
import os
import sys
import tempfile

MAGIC = b"7z\xbc\xaf\x27\x1c"

REQUIRED_PLUGINS = ("tabby-core", "tabby-settings", "tabby-terminal")

# The three literals run 19's exe lacked. `SMARTSSH_MEASURE` lives in smartssh/app/metricsPath.mjs
# and reaches the shipped bundle through tabby-terminal/src/api/baseTerminalTab.component.ts.
REQUIRED_SYMBOLS = ("xterm", "smartssh-bar", "SMARTSSH_MEASURE")

BUNDLE_SUFFIX = "resources/builtin-plugins/tabby-terminal/dist/index.js"


def count_symbols(data: bytes, symbols) -> dict:
    return {symbol: data.count(symbol.encode()) for symbol in symbols}


def main(argv) -> int:
    if len(argv) != 2:
        print("usage: verify-exe.py <path-to-portable-exe>", file=sys.stderr)
        return 2
    path = argv[1]
    try:
        with open(path, "rb") as handle:
            blob = handle.read()
    except OSError as error:
        print(f"FAIL  open exe  {error}", file=sys.stderr)
        return 2

    offset = blob.find(MAGIC)
    if offset < 0:
        print("FAIL  7z payload  no 7z signature: this is not an electron-builder portable exe", file=sys.stderr)
        return 2

    try:
        import py7zr
    except ImportError:
        print("FAIL  py7zr  not installed; run: uv run --with py7zr python3 " + __file__, file=sys.stderr)
        return 2

    print(f"MEASURE  exe bytes = {len(blob)}")
    print(f"MEASURE  payload offset = {offset}")

    checks = []

    with py7zr.SevenZipFile(io.BytesIO(blob[offset:]), "r") as archive:
        names = archive.getnames()
        normalised = {name.replace("\\", "/") for name in names}
        builtin = sorted(name for name in normalised if "resources/builtin-plugins/" in name)
        print(f"MEASURE  payload entries = {len(names)}")
        print(f"MEASURE  builtin-plugins entries = {len(builtin)}")

        for plugin in REQUIRED_PLUGINS:
            wanted = f"resources/builtin-plugins/{plugin}/package.json"
            checks.append((f"payload has {wanted}", wanted in normalised))

        checks.append(("payload has the terminal bundle", BUNDLE_SUFFIX in normalised))

        if BUNDLE_SUFFIX in normalised:
            # py7zr 1.x has no in-memory read(): extract just this one member into a temp dir, read
            # it, and remove the dir before exit. Nothing else is unpacked.
            with tempfile.TemporaryDirectory(prefix="smartssh-exe-") as scratch:
                archive.extract(path=scratch, targets=[BUNDLE_SUFFIX])
                extracted = os.path.join(scratch, *BUNDLE_SUFFIX.split("/"))
                with open(extracted, "rb") as handle:
                    bundle = handle.read()
            counts = count_symbols(bundle, REQUIRED_SYMBOLS)
            print(f"MEASURE  {BUNDLE_SUFFIX} bytes = {len(bundle)}")
            for symbol in REQUIRED_SYMBOLS:
                print(f"MEASURE  {symbol} count = {counts[symbol]}")
                checks.append((f"bundle contains {symbol}", counts[symbol] > 0))

    failed = [name for name, ok in checks if not ok]
    for name, ok in checks:
        print(f"{'PASS' if ok else 'FAIL'}  {name}")
    print(f"\n{len(checks) - len(failed)}/{len(checks)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
