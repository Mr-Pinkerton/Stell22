#!/bin/bash
# Fail closed unless this runner checkout is canonical origin/main and the
# workflow_dispatch ref is refs/heads/main. This is the code-level boundary.
# It is not, by itself, protection against a different workflow file on
# another branch. The production GitHub Environment must also restrict refs.
set -euo pipefail

echo "GITHUB_REF=${GITHUB_REF:-}"
if [[ "${GITHUB_REF:-}" != "refs/heads/main" ]]; then
  echo "REFUSE code=DISPATCH_REF_NOT_MAIN" >&2
  exit 1
fi

git fetch origin main
checkout_sha="$(git rev-parse HEAD)"
origin_main="$(git rev-parse origin/main)"
echo "CONTROL_PLANE_CHECKOUT_SHA=${checkout_sha}"
echo "ORIGIN_MAIN_SHA=${origin_main}"
if [[ -z "$checkout_sha" || -z "$origin_main" || "$checkout_sha" != "$origin_main" ]]; then
  echo "REFUSE code=CONTROL_PLANE_NOT_ORIGIN_MAIN" >&2
  exit 1
fi
echo "CANONICAL_MAIN_CONTROL_PLANE_OK"
