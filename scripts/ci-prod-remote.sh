#!/usr/bin/env bash
# Оркестратор production deploy для GitHub Actions.
# Запускается на сервере (cwd = корень Stell22).
#
# Обязательно: EXPECTED_SHA — полный SHA origin/main на момент запуска workflow.
# Запускать только из файла (не через pipe):
#   EXPECTED_SHA=<sha> bash scripts/ci-prod-remote.sh
#
# При `git show … | bash` stdin — это pipe со скриптом. deploy.sh/docker compose
# наследуют fd 0 и могут прочитать оставшиеся строки orchestrator (verify/health).
set -euo pipefail

: "${EXPECTED_SHA:?EXPECTED_SHA is required}"

if [[ ! -f docker-compose.prod.yml ]]; then
  echo "ERROR: run from Stell22 repo root (docker-compose.prod.yml not found)" >&2
  exit 1
fi

if [[ ! -f scripts/ci-prod-remote.sh ]]; then
  echo "ERROR: run scripts/ci-prod-remote.sh from repo checkout, not from a pipe" >&2
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

echo "===== STAGE: checkout ====="
if git show-ref --verify --quiet refs/heads/main; then
  git checkout main
  git reset --hard "$EXPECTED_SHA"
else
  git checkout -B main "$EXPECTED_SHA"
fi

echo "===== STAGE: preflight ====="
bash scripts/preflight-prod.sh

echo "===== STAGE: deploy ====="
# Закрываем stdin: deploy/docker не должны читать fd orchestrator.
DEPLOY_SHA="$EXPECTED_SHA" sh scripts/deploy.sh </dev/null

echo "===== STAGE: verify ====="
actual="$(git rev-parse HEAD)"
echo "expected_sha=${EXPECTED_SHA}"
echo "deployed_sha=${actual}"
if [[ "$actual" != "$EXPECTED_SHA" ]]; then
  echo "ERROR: deployed SHA (${actual}) != expected (${EXPECTED_SHA})" >&2
  exit 1
fi

echo "===== STAGE: health ====="
if ! docker compose -f docker-compose.prod.yml exec -T app \
  node -e "fetch('${HEALTH_URL}').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
  echo "ERROR: health check failed: ${HEALTH_URL}" >&2
  exit 1
fi
echo "Health OK: ${HEALTH_URL}"
echo "DEPLOY VERIFY OK"
