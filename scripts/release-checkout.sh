#!/bin/sh
# Move HEAD to an exact commit without git reset --hard.
# Local scripts/backup-db.sh, scripts/restore-db.sh, and untracked mail.log stay.
set -eu

checkout_release_tree() {
  sha=${1:-}
  if [ -z "$sha" ]; then
    echo "RESULT=STOP_CHECKOUT" >&2
    exit 1
  fi
  if ! git cat-file -e "${sha}^{commit}"; then
    echo "RESULT=STOP_CHECKOUT" >&2
    exit 1
  fi
  unexpected=$(git status --porcelain=v1 | awk '
    {
      path = substr($0, 4)
      if (path != "scripts/backup-db.sh" && path != "scripts/restore-db.sh" && path != "mail.log") {
        print path
      }
    }
  ')
  if [ -n "$unexpected" ]; then
    echo "RESULT=STOP_UNEXPECTED_LOCAL_CHANGES" >&2
    exit 1
  fi

  mail_existed=0
  if [ -e mail.log ]; then
    mail_existed=1
    mail_hash=$(sha256sum mail.log | awk 'NR==1 { print $1; exit }')
  fi
  backup_dirty=0
  restore_dirty=0
  if git status --porcelain=v1 -- scripts/backup-db.sh | grep -q .; then
    backup_dirty=1
    backup_hash=$(sha256sum scripts/backup-db.sh | awk 'NR==1 { print $1; exit }')
  fi
  if git status --porcelain=v1 -- scripts/restore-db.sh | grep -q .; then
    restore_dirty=1
    restore_hash=$(sha256sum scripts/restore-db.sh | awk 'NR==1 { print $1; exit }')
  fi

  stashed=0
  if [ "$backup_dirty" = 1 ] || [ "$restore_dirty" = 1 ]; then
    git stash push -m stell22-release-protected -- scripts/backup-db.sh scripts/restore-db.sh
    stashed=1
  fi
  if ! git checkout --detach "$sha"; then
    if [ "$stashed" = 1 ]; then
      git stash pop || true
    fi
    echo "RESULT=STOP_CHECKOUT" >&2
    exit 1
  fi
  if [ "$stashed" = 1 ]; then
    if ! git stash pop; then
      echo "RESULT=STOP_PROTECTED_FILE" >&2
      exit 1
    fi
  fi

  if [ "$backup_dirty" = 1 ]; then
    now=$(sha256sum scripts/backup-db.sh | awk 'NR==1 { print $1; exit }')
    if [ "$now" != "$backup_hash" ]; then
      echo "RESULT=STOP_PROTECTED_FILE" >&2
      exit 1
    fi
  fi
  if [ "$restore_dirty" = 1 ]; then
    now=$(sha256sum scripts/restore-db.sh | awk 'NR==1 { print $1; exit }')
    if [ "$now" != "$restore_hash" ]; then
      echo "RESULT=STOP_PROTECTED_FILE" >&2
      exit 1
    fi
  fi
  if [ "$mail_existed" = 1 ]; then
    if [ ! -e mail.log ]; then
      echo "RESULT=STOP_PROTECTED_FILE" >&2
      exit 1
    fi
    now=$(sha256sum mail.log | awk 'NR==1 { print $1; exit }')
    if [ "$now" != "$mail_hash" ]; then
      echo "RESULT=STOP_PROTECTED_FILE" >&2
      exit 1
    fi
  fi
  echo "RESULT=CHECKOUT_PRESERVED"
  echo "HEAD=$(git rev-parse HEAD)"
}

if [ "${0##*/}" = "release-checkout.sh" ]; then
  checkout_release_tree "${1:-}"
fi
