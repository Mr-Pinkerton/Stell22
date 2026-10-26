"""Read one migrator password assignment without executing the env file.

Stdout is the password bytes on success. Failure writes only a reason code
to stderr and never writes the password.
"""

import os
import re
import stat
import sys

KEY = "MIGRATOR_DB_PASSWORD"
VALUE = re.compile(r"[A-Za-z0-9_-]{24,128}")


def fail(code):
    sys.stderr.write(code + "\n")
    raise SystemExit(1)


def main():
    if len(sys.argv) != 2:
        fail("AMBIGUOUS")
    path = sys.argv[1]
    if not os.path.lexists(path):
        fail("MISSING_FILE")
    info = os.lstat(path)
    if stat.S_ISLNK(info.st_mode):
        fail("SYMLINK")
    if not stat.S_ISREG(info.st_mode):
        fail("NOT_FILE")
    if hasattr(os, "geteuid"):
        if info.st_uid != os.geteuid():
            fail("OWNER")
        if info.st_mode & 0o077 or not info.st_mode & 0o400:
            fail("PERMISSION")
    try:
        raw = open(path, "rb").read()
    except OSError:
        fail("PERMISSION")
    values = []
    for line in raw.splitlines():
        if line.startswith(b"\xef\xbb\xbf"):
            line = line[3:]
        try:
            text = line.decode("utf-8")
        except UnicodeDecodeError:
            fail("AMBIGUOUS")
        body = text.lstrip(" \t")
        if not body or body.startswith("#"):
            continue
        if body.startswith("export "):
            body = body[7:].lstrip(" \t")
        prefix = KEY + "="
        if body.startswith(prefix):
            values.append(body[len(prefix) :])
        elif body.startswith(KEY):
            fail("AMBIGUOUS")
    if not values:
        fail("MISSING")
    if len(values) != 1:
        fail("DUPLICATE")
    value = values[0]
    if value == "":
        fail("EMPTY")
    if VALUE.fullmatch(value) is None:
        fail("FORMAT")
    sys.stdout.write(value)


if __name__ == "__main__":
    main()
