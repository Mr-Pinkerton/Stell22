#!/bin/sh
# Detach HEAD at an exact commit. Do not hard-reset, clean, or stash.
# Server bytes of scripts/backup-db.sh and scripts/restore-db.sh are copied
# aside and written back. They are never merged. mail.log is left in place.
# An interrupted run is finished by: sh scripts/release-checkout.sh --recover
set -eu
umask 077

REC=""

hash_file() {
  sum=$(sha256sum "$1" | awk 'NR == 1 { print $1; exit }')
  printf '%s\n' "$sum" | grep -Eq '^[0-9a-f]{64}$' || return 1
  printf '%s\n' "$sum"
}

recovery_dir() {
  git_dir=$(git rev-parse --absolute-git-dir 2>/dev/null || git rev-parse --git-dir) || return 1
  case "$git_dir" in
    /*|[A-Za-z]:*) ;;
    *) git_dir="$(pwd)/$git_dir" ;;
  esac
  printf '%s\n' "$git_dir/stell22-release-checkout"
}

write_state() {
  printf '%s\n' "$1" > "$REC/state"
  chmod 600 "$REC/state"
}

snapshot_file() {
  name=$1
  path=$2
  if [ ! -f "$path" ]; then
    echo "RESULT=STOP_PROTECTED_FILE" >&2
    exit 1
  fi
  cp "$path" "$REC/$name.body"
  chmod 600 "$REC/$name.body"
  hash_file "$path" > "$REC/$name.sha256" || {
    echo "RESULT=STOP_PROTECTED_FILE" >&2
    exit 1
  }
  stat -c %a "$path" > "$REC/$name.mode"
  stat -c %u "$path" > "$REC/$name.uid"
  stat -c %g "$path" > "$REC/$name.gid"
  chmod 600 "$REC/$name.sha256" "$REC/$name.mode" "$REC/$name.uid" "$REC/$name.gid"
}

apply_file() {
  name=$1
  path=$2
  if [ -e "$path" ]; then
    chmod u+w "$path" || return 1
  fi
  cp "$REC/$name.body" "$path" || return 1
  mode=$(cat "$REC/$name.mode")
  chmod "$mode" "$path" || return 1
  uid=$(cat "$REC/$name.uid")
  gid=$(cat "$REC/$name.gid")
  now_uid=$(stat -c %u "$path")
  now_gid=$(stat -c %g "$path")
  if [ "$now_uid" != "$uid" ] || [ "$now_gid" != "$gid" ]; then
    chown "${uid}:${gid}" "$path" || return 1
  fi
  now=$(hash_file "$path") || return 1
  want=$(cat "$REC/$name.sha256")
  [ "$now" = "$want" ]
}

align_scripts_to_head() {
  head_now=$(git rev-parse HEAD) || return 1
  chmod u+w scripts/backup-db.sh scripts/restore-db.sh 2>/dev/null || return 1
  git show "${head_now}:scripts/backup-db.sh" > scripts/backup-db.sh || return 1
  git show "${head_now}:scripts/restore-db.sh" > scripts/restore-db.sh || return 1
}

switch_to() {
  target=$1
  current=$(git rev-parse HEAD) || return 1
  if [ "$current" = "$target" ]; then
    return 0
  fi
  align_scripts_to_head || return 1
  git -c advice.detachedHead=false checkout --detach "$target" >/dev/null
}

restore_mail() {
  existed=$(cat "$REC/mail.exists")
  if [ "$existed" = 0 ]; then
    if [ -e mail.log ]; then
      return 1
    fi
    return 0
  fi
  apply_file mail mail.log
}

no_conflict() {
  if grep -Eq '^(<<<<<<<|=======|>>>>>>>)' scripts/backup-db.sh scripts/restore-db.sh; then
    return 1
  fi
  return 0
}

rollback_to_original() {
  trap '' HUP INT TERM
  if [ ! -f "$REC/original-head" ] || [ ! -f "$REC/backup.body" ] || [ ! -f "$REC/restore.body" ]; then
    trap on_signal HUP INT TERM
    return 1
  fi
  write_state restoring
  original=$(cat "$REC/original-head")
  if ! switch_to "$original"; then
    trap on_signal HUP INT TERM
    return 1
  fi
  if ! apply_file backup scripts/backup-db.sh; then
    trap on_signal HUP INT TERM
    return 1
  fi
  if ! apply_file restore scripts/restore-db.sh; then
    trap on_signal HUP INT TERM
    return 1
  fi
  if ! restore_mail; then
    trap on_signal HUP INT TERM
    return 1
  fi
  if ! no_conflict; then
    trap on_signal HUP INT TERM
    return 1
  fi
  if [ "$(git rev-parse HEAD)" != "$original" ]; then
    trap on_signal HUP INT TERM
    return 1
  fi
  trap on_signal HUP INT TERM
  return 0
}

on_signal() {
  trap '' HUP INT TERM
  set +e
  if [ -n "$REC" ] && [ -d "$REC" ]; then
    rollback_to_original
    restored=$?
    if [ "$restored" -eq 0 ]; then
      rm -rf "$REC"
      echo "RESULT=STOP_CHECKOUT" >&2
      exit 1
    fi
    echo "RESULT=STOP_PROTECTED_FILE" >&2
    exit 1
  fi
  echo "RESULT=STOP_CHECKOUT" >&2
  exit 1
}

stop_checkout() {
  if rollback_to_original; then
    rm -rf "$REC"
    echo "RESULT=STOP_CHECKOUT" >&2
    exit 1
  fi
  echo "RESULT=STOP_PROTECTED_FILE" >&2
  exit 1
}

stop_protected() {
  if rollback_to_original; then
    rm -rf "$REC"
  fi
  echo "RESULT=STOP_PROTECTED_FILE" >&2
  exit 1
}

prepare_private_dir() {
  REC=$(recovery_dir) || {
    echo "RESULT=STOP_PROTECTED_FILE" >&2
    exit 1
  }
  mkdir -p "$REC"
  chmod 700 "$REC" || {
    echo "RESULT=STOP_PROTECTED_FILE" >&2
    exit 1
  }
  rec_mode=$(stat -c %a "$REC")
  case "$rec_mode" in
    700) ;;
    *)
      case "$(uname -s 2>/dev/null || echo unknown)" in
        Linux)
          echo "RESULT=STOP_PROTECTED_FILE" >&2
          exit 1
          ;;
      esac
      ;;
  esac
}

checkout_release_tree() {
  recover_only=0
  if [ "${1:-}" = "--recover" ]; then
    recover_only=1
  fi
  trap on_signal HUP INT TERM
  prepare_private_dir
  interrupted=0
  if [ -f "$REC/state" ]; then
    state=$(cat "$REC/state")
    case "$state" in
      writing|done)
        rm -rf "$REC"
        prepare_private_dir
        ;;
      saved|switching|restoring)
        if ! rollback_to_original; then
          echo "RESULT=STOP_PROTECTED_FILE" >&2
          exit 1
        fi
        rm -rf "$REC"
        interrupted=1
        prepare_private_dir
        ;;
      *)
        echo "RESULT=STOP_PROTECTED_FILE" >&2
        exit 1
        ;;
    esac
  fi
  if [ "$recover_only" = 1 ]; then
    rm -rf "$REC"
    if [ "$interrupted" = 1 ]; then
      echo "RESULT=STOP_CHECKOUT" >&2
      exit 1
    fi
    echo "RESULT=RECOVERY_CLEAR"
    exit 0
  fi
  if [ "$interrupted" = 1 ]; then
    echo "RESULT=RECOVERY_RESTORED" >&2
  fi

  sha=${1:-}
  if ! printf '%s' "$sha" | grep -Eq '^[0-9a-f]{40}$'; then
    echo "RESULT=STOP_CHECKOUT" >&2
    exit 1
  fi
  if ! git cat-file -e "${sha}^{commit}"; then
    echo "RESULT=STOP_CHECKOUT" >&2
    exit 1
  fi
  unexpected=$(git status --porcelain=v1 | awk '
    {
      status = substr($0, 1, 2)
      path = substr($0, 4)
      if (path == "scripts/backup-db.sh" || path == "scripts/restore-db.sh") {
        if (status == " M" || status == "M " || status == "MM") next
      }
      if (path == "mail.log" && status == "??") next
      print path
    }
  ')
  if [ -n "$unexpected" ]; then
    echo "RESULT=STOP_UNEXPECTED_LOCAL_CHANGES" >&2
    exit 1
  fi
  if [ ! -f scripts/backup-db.sh ] || [ ! -f scripts/restore-db.sh ]; then
    echo "RESULT=STOP_PROTECTED_FILE" >&2
    exit 1
  fi

  original=$(git rev-parse HEAD)
  printf '%s\n' "$original" > "$REC/original-head"
  chmod 600 "$REC/original-head"
  write_state writing
  snapshot_file backup scripts/backup-db.sh
  snapshot_file restore scripts/restore-db.sh
  if [ -e mail.log ]; then
    if [ ! -f mail.log ]; then
      echo "RESULT=STOP_PROTECTED_FILE" >&2
      exit 1
    fi
    snapshot_file mail mail.log
    printf '%s\n' 1 > "$REC/mail.exists"
  else
    printf '%s\n' 0 > "$REC/mail.exists"
  fi
  chmod 600 "$REC/mail.exists"
  write_state saved
  write_state switching
  # Production does not set this. It enters the signal path before detach.
  case "${STELL22_CHECKOUT_SIGNAL_SELF:-}" in
    HUP|INT|TERM) kill -s "$STELL22_CHECKOUT_SIGNAL_SELF" $$ ;;
  esac

  if ! switch_to "$sha"; then
    stop_checkout
  fi
  if ! apply_file backup scripts/backup-db.sh; then
    stop_protected
  fi
  if ! apply_file restore scripts/restore-db.sh; then
    stop_protected
  fi
  if ! restore_mail; then
    stop_protected
  fi
  if ! no_conflict; then
    stop_protected
  fi
  if [ "$(git rev-parse HEAD)" != "$sha" ]; then
    stop_checkout
  fi
  write_state done
  rm -rf "$REC"
  echo "RESULT=CHECKOUT_PRESERVED"
  echo "HEAD=$(git rev-parse HEAD)"
}

script_name=${0##*/}
script_name=${script_name##*\\}
if [ "$script_name" = "release-checkout.sh" ]; then
  checkout_release_tree "${1:-}"
fi
