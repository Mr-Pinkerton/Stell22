#!/bin/sh
# Print the image Compose tagged for the app service after a build.
# `docker compose images` lists the created container and is not used.
# Stdout is IMAGE_REF and IMAGE_ID. Compose config, including secrets, is not printed.
set -eu

is_image_id() {
  case $1 in
    sha256:*) ;;
    *) return 1 ;;
  esac
  rest=${1#sha256:}
  [ "${#rest}" -eq 64 ] || return 1
  case $rest in
    *[!0-9a-f]*) return 1 ;;
  esac
}

if python3 -c "import sys" >/dev/null 2>&1; then
  release_python=python3
elif python -c "import sys" >/dev/null 2>&1; then
  release_python=python
else
  echo "RESULT=STOP_APP_START" >&2
  exit 1
fi

file=${1:-}
legacy=${2:-}
if [ -z "$file" ] || ! is_image_id "$legacy"; then
  echo "RESULT=STOP_APP_START" >&2
  exit 1
fi

ref=$(docker compose -f "$file" config --format json | "$release_python" -c '
import json, re, sys
try:
    config = json.loads(sys.stdin.read())
    services = config.get("services") or {}
    app = services.get("app")
    if not isinstance(app, dict):
        raise ValueError("app")
    chosen = app.get("image") if isinstance(app.get("image"), str) else ""
    project = config.get("name") if isinstance(config.get("name"), str) else ""
    if not chosen:
        if re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,62}", project) is None:
            raise ValueError("project")
        chosen = project + "-app"
    if re.fullmatch(r"[a-z0-9][a-z0-9._:/-]{0,200}", chosen) is None:
        raise ValueError("ref")
    for name, service in services.items():
        if name == "app" or not isinstance(service, dict):
            continue
        if service.get("image") == chosen:
            raise ValueError("shared")
except Exception:
    sys.exit(2)
sys.stdout.write(chosen)
') || {
  echo "RESULT=STOP_APP_START" >&2
  exit 1
}

case $ref in
  *[!a-z0-9._:/-]*|"") echo "RESULT=STOP_APP_START" >&2; exit 1 ;;
esac
count=$(docker compose -f "$file" config --images | grep -c -x -F "$ref" || true)
if [ "$count" != "1" ]; then
  echo "RESULT=STOP_APP_START" >&2
  exit 1
fi

id=$(docker image inspect --format '{{.Id}}' "$ref" 2>/dev/null || true)
if ! is_image_id "$id" || [ "$id" = "$legacy" ]; then
  echo "RESULT=STOP_APP_START" >&2
  exit 1
fi
printf 'IMAGE_REF=%s\nIMAGE_ID=%s\n' "$ref" "$id"
