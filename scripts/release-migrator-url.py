"""Write the migrator DATABASE_URL without printing it.

The password bytes match the role password. A value that URL-parsing would
change is refused and no file is written.
"""

import os
import pathlib
import re
import urllib.parse

password = os.environ.get("MIGRATOR_DB_PASSWORD", "")
role = os.environ.get("ROLE", "")
out = os.environ.get("OUT", "")
if role != "stell22_migrator" or not out:
    raise SystemExit(1)
if re.fullmatch(r"[A-Za-z0-9_-]{24,128}", password) is None:
    raise SystemExit(1)
url = "postgresql://" + role + ":" + password + "@127.0.0.1:5432/stell22?schema=public"
parsed = urllib.parse.urlparse(url)
if parsed.username != role or parsed.password != password:
    raise SystemExit(1)
if parsed.hostname != "127.0.0.1" or parsed.path != "/stell22" or parsed.query != "schema=public":
    raise SystemExit(1)
pathlib.Path(out).write_text("DATABASE_URL=" + url + "\n")
