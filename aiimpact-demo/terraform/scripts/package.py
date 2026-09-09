#!/usr/bin/env python3
"""Zip a Lambda bootstrap binary with the executable bit preserved.

provided.al2023 refuses to start if bootstrap is not executable, and the
archive produced by some tooling drops the mode bits. This sets them
explicitly and writes a deterministic timestamp so an unchanged binary
produces an unchanged zip -- otherwise Terraform sees a diff on every apply.
"""
import os
import stat
import sys
import zipfile

if len(sys.argv) != 3:
    sys.exit("usage: package.py <bootstrap-binary> <output.zip>")

binary, out = sys.argv[1], sys.argv[2]
os.makedirs(os.path.dirname(out) or ".", exist_ok=True)

info = zipfile.ZipInfo("bootstrap", date_time=(1980, 1, 1, 0, 0, 0))
info.external_attr = (stat.S_IFREG | 0o755) << 16
info.compress_type = zipfile.ZIP_DEFLATED

with open(binary, "rb") as fh, zipfile.ZipFile(out, "w") as z:
    z.writestr(info, fh.read())

print(f"{out}  {os.path.getsize(out):,} bytes")
