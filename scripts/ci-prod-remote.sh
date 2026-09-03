#!/usr/bin/env bash
# Оркестратор production deploy для GitHub Actions.
# Запускается на сервере (cwd = корень Stell22).
#
# Обязательно: EXPECTED_SHA — полный SHA origin/main на момент запуска workflow.
# Скрипт можно выполнить через pipe, если файла ещё нет на диске:
#   git show SHA:scripts/ci-prod-remote.sh | EXPECTED_SHA=... bash
set -euo pipefail

: "${EXPECTED_SHA:?EXPECTED_SHA is required}"

if [[ ! -f docker-compose.prod.yml ]]; then
  echo "ERROR: run from Stell22 repo root (docker-compose.prod.yml not found)" >&2
  exit 1
fi

HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/api/health}"

echo "===== STAGE: context ====="
echo "expected_sha=${EXPECTED_SHA}"
echo "branch=main"
echo "started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "local_head=$(git rev-parse HEAD)"

echo "===== STAGE: fetch ====="
git fetch origin
if ! git cat-file -e "${EXPECTED_SHA}^{commit}"; then
  echo "ERROR: ${EXPECTED_SHA} not found after git fetch origin" >&2
  exit 1
fi

origin_main="$(git rev-parse origin/main)"
echo "origin/main=${origin_main}"
if [[ "$origin_main" != "$EXPECTED_SHA" ]]; then
  if git merge-base --is-ancestor "$EXPECTED_SHA" origin/main; then
    echo "NOTE: origin/main moved ahead; deploying CI-tested SHA ${EXPECTED_SHA}"
  else
    echo "ERROR: ${EXPECTED_SHA} is not on origin/main history (origin/main=${origin_main})" >&2
    exit 1
  fi
fi

echo "===== STAGE: preflight ====="
git show "${EXPECTED_SHA}:scripts/preflight-prod.sh" | bash

echo "===== STAGE: deploy ====="
if git show-ref --verify --quiet refs/heads/main; then
  git checkout main
  git reset --hard "$EXPECTED_SHA"
else
  git checkout -B main "$EXPECTED_SHA"
fi

DEPLOY_SHA="$EXPECTED_SHA" sh scripts/deploy.sh

echo "===== STAGE: verify ====="
actual="$(git rev-parse HEAD)"
echo "expected_sha=${EXPECTED_SHA}"
echo "deployed_sha=${actual}"
if [[ "$actual" != "$EXPECTED_SHA" ]]; then
  echo "ERROR: deployed SHA (${actual}) != expected (${EXPECTED_SHA})" >&2
  exit 1
fi

echo "===== STAGE: health ====="
docker compose -f docker-compose.prod.yml exec -T app \
  node -e "fetch('${HEALTH_URL}').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
echo "Health OK: ${HEALTH_URL}"
echo "===== DONE ====="
