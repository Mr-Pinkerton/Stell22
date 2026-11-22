#!/bin/sh
# Shared helpers for the Stell22 daily offsite backup.
# The producer remains scripts/backup-db.sh. This library never opens a
# database connection and never deletes a published backup.
set -eu

offsite_die() {
  _status=$1
  _reason=$2
  _code=$3
  printf '%s\n' "STATUS=${_status}" "REASON=${_reason}" "RESTORE_VERIFIED=0"
  printf '%s\n' "[offsite] ${_status}: ${_reason}" >&2
  if [ -n "${OFFSITE_STATE_DIR:-}" ] && [ -d "$OFFSITE_STATE_DIR" ]; then
    _tmp=$(mktemp "$OFFSITE_STATE_DIR/last-run.XXXXXX") || exit "$_code"
    printf '%s\n' "status=${_status}" "reason=${_reason}" "backup_date=${BACKUP_DATE:-}" > "$_tmp"
    mv "$_tmp" "$OFFSITE_STATE_DIR/last-run.env"
  fi
  exit "$_code"
}

offsite_need_cmd() {
  command -v "$1" >/dev/null 2>&1 || offsite_die FAILED "missing-tool:$1" 11
}

offsite_is_sha256() {
  printf '%s' "$1" | grep -Eq '^[0-9a-f]{64}$'
}

offsite_sha256() {
  sha256sum "$1" | awk 'NR == 1 { print $1 }'
}

offsite_size() {
  wc -c < "$1" | tr -d '[:space:]'
}

offsite_prepare() {
  set +x
  umask 077
  OFFSITE_ENDPOINT=${OFFSITE_ENDPOINT:-}
  OFFSITE_BUCKET=${OFFSITE_BUCKET:-}
  OFFSITE_REGION=${OFFSITE_REGION:-ru-central1}
  OFFSITE_PREFIX=${OFFSITE_PREFIX:-}
  OFFSITE_AGE_RECIPIENT=${OFFSITE_AGE_RECIPIENT:-}
  OFFSITE_BACKUP_DIR=${OFFSITE_BACKUP_DIR:-}
  OFFSITE_STATE_DIR=${OFFSITE_STATE_DIR:-}
  OFFSITE_MIN_FREE_KB=${OFFSITE_MIN_FREE_KB:-1048576}
  OFFSITE_MAX_AGE_HOURS=${OFFSITE_MAX_AGE_HOURS:-36}
  OFFSITE_GRACE_HHMM=${OFFSITE_GRACE_HHMM:-0330}
  OFFSITE_LOOKBACK_DAYS=${OFFSITE_LOOKBACK_DAYS:-40}
  OFFSITE_RUN_MAX_SECONDS=${OFFSITE_RUN_MAX_SECONDS:-21600}

  if [ "$OFFSITE_ENDPOINT" != "https://storage.yandexcloud.net" ]; then
    offsite_die FAILED configuration 10
  fi
  case "$OFFSITE_BUCKET" in
    [a-z0-9][a-z0-9.-][a-z0-9.-][a-z0-9.-]*) ;;
    *) offsite_die FAILED configuration 10 ;;
  esac
  case "$OFFSITE_BUCKET" in
    *[!a-z0-9.-]*|*[A-Z]*|*/|*\\*) offsite_die FAILED configuration 10 ;;
  esac
  case "$OFFSITE_PREFIX" in
    ""|/*|*/|*..*) offsite_die FAILED configuration 10 ;;
  esac
  case "$OFFSITE_BACKUP_DIR" in
    ""|/) offsite_die FAILED configuration 10 ;;
  esac
  case "$OFFSITE_STATE_DIR" in
    ""|/) offsite_die FAILED configuration 10 ;;
  esac
  case "$OFFSITE_MIN_FREE_KB" in
    ""|*[!0-9]*) offsite_die FAILED configuration 10 ;;
  esac
  case "$OFFSITE_RUN_MAX_SECONDS" in
    ""|*[!0-9]*) offsite_die FAILED configuration 10 ;;
  esac
  case "$OFFSITE_AGE_RECIPIENT" in
    "") offsite_die FAILED missing-recipient 25 ;;
    *SECRET*|*[!a-z0-9]*) offsite_die FAILED missing-recipient 25 ;;
    age1*) ;;
    *) offsite_die FAILED missing-recipient 25 ;;
  esac
  if [ "${#OFFSITE_AGE_RECIPIENT}" -lt 20 ] || [ "${#OFFSITE_AGE_RECIPIENT}" -gt 128 ]; then
    offsite_die FAILED missing-recipient 25
  fi
  case "${AWS_ACCESS_KEY_ID-}" in
    "") offsite_die FAILED configuration 10 ;;
  esac
  case "${AWS_SECRET_ACCESS_KEY-}" in
    "") offsite_die FAILED configuration 10 ;;
  esac
  if [ "${STELL22_OFFSITE_TEST_HOOKS:-}" = "1" ] && [ "${OFFSITE_ENVIRONMENT:-}" != "synthetic" ]; then
    offsite_die FAILED configuration 10
  fi
  if [ -n "${STELL22_OFFSITE_PRODUCER:-}" ] && [ "${STELL22_OFFSITE_TEST_HOOKS:-}" != "1" ]; then
    offsite_die FAILED configuration 10
  fi

  offsite_need_cmd age
  offsite_need_cmd aws
  offsite_need_cmd flock
  offsite_need_cmd sha256sum
  offsite_need_cmd gzip
  offsite_need_cmd date
  offsite_need_cmd df
  offsite_need_cmd awk
  offsite_need_cmd grep
  offsite_need_cmd mktemp
  offsite_need_cmd find

  mkdir -p "$OFFSITE_BACKUP_DIR" "$OFFSITE_STATE_DIR" "$OFFSITE_STATE_DIR/work" "$OFFSITE_STATE_DIR/attempts" \
    || offsite_die FAILED configuration 10

  _avail=$(df -Pk "$OFFSITE_STATE_DIR" | awk 'NR > 1 {
    for (i = 1; i <= NF; i++) {
      if ($i ~ /%$/) {
        print $(i - 1)
        exit
      }
    }
  }') || true
  case "$_avail" in
    ""|*[!0-9]*) offsite_die FAILED "low-disk" 12 ;;
  esac
  while :; do
    case "$_avail" in
      0) break ;;
      0*) _avail=${_avail#0} ;;
      *) break ;;
    esac
  done
  if [ "$_avail" -lt "$OFFSITE_MIN_FREE_KB" ]; then
    offsite_die FAILED low-disk 12
  fi

  _offset=$(TZ=Europe/Moscow date +%z) || offsite_die FAILED timezone 24
  case "$_offset" in
    +0300) ;;
    *) offsite_die FAILED timezone 24 ;;
  esac
  BACKUP_DATE=$(TZ=Europe/Moscow date +%Y-%m-%d) || offsite_die FAILED timezone 24
  case "$BACKUP_DATE" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
    *) offsite_die FAILED timezone 24 ;;
  esac
  CLOCK_HHMM=$(TZ=Europe/Moscow date +%H%M) || offsite_die FAILED timezone 24
  case "$CLOCK_HHMM" in
    [0-2][0-9][0-5][0-9]) ;;
    *) offsite_die FAILED timezone 24 ;;
  esac
  NOW_EPOCH=$(date +%s) || offsite_die FAILED timezone 24
  case "$NOW_EPOCH" in
    ""|*[!0-9]*) offsite_die FAILED timezone 24 ;;
  esac
  export AWS_PAGER=
  export AWS_CLI_AUTO_PROMPT=off
  export AWS_DEFAULT_REGION="$OFFSITE_REGION"
}

offsite_decimal() {
  _n=$1
  while :; do
    case "$_n" in
      ""|*[!0-9]*) return 1 ;;
      0) break ;;
      0*) _n=${_n#0} ;;
      *) break ;;
    esac
  done
  printf '%s\n' "$_n"
}

offsite_prev_day() {
  _y=${1%%-*}
  _rest=${1#*-}
  _m=${_rest%%-*}
  _d=${_rest#*-}
  _d=$(offsite_decimal "$_d") || return 1
  _m=$(offsite_decimal "$_m") || return 1
  _y=$(offsite_decimal "$_y") || return 1
  _d=$((_d - 1))
  if [ "$_d" -lt 1 ]; then
    _m=$((_m - 1))
    if [ "$_m" -lt 1 ]; then
      _m=12
      _y=$((_y - 1))
    fi
    case "$_m" in
      1|3|5|7|8|10|12) _d=31 ;;
      4|6|9|11) _d=30 ;;
      2)
        if [ $((_y % 400)) -eq 0 ]; then
          _d=29
        elif [ $((_y % 100)) -eq 0 ]; then
          _d=28
        elif [ $((_y % 4)) -eq 0 ]; then
          _d=29
        else
          _d=28
        fi
        ;;
    esac
  fi
  printf '%04d-%02d-%02d\n' "$_y" "$_m" "$_d"
}

offsite_archive_key() {
  printf '%s/daily/%s/archive.age\n' "$OFFSITE_PREFIX" "$1"
}

offsite_manifest_key() {
  printf '%s/daily/%s/manifest.json\n' "$OFFSITE_PREFIX" "$1"
}

offsite_success_key() {
  printf '%s/daily/%s/SUCCESS\n' "$OFFSITE_PREFIX" "$1"
}

offsite_aws() {
  AWS_OUT=$(mktemp "$OFFSITE_STATE_DIR/aws-out.XXXXXX")
  AWS_ERR=$(mktemp "$OFFSITE_STATE_DIR/aws-err.XXXXXX")
  _aws_errexit=0
  case $- in
    *e*) _aws_errexit=1 ;;
  esac
  set +e
  aws "$@" >"$AWS_OUT" 2>"$AWS_ERR"
  AWS_RC=$?
  if [ "$_aws_errexit" -eq 1 ]; then
    set -e
  fi
}

offsite_aws_err_text() {
  cat "$AWS_ERR" 2>/dev/null || true
}

offsite_s3_head() {
  _key=$1
  offsite_aws s3api head-object \
    --bucket "$OFFSITE_BUCKET" \
    --key "$_key" \
    --endpoint-url "$OFFSITE_ENDPOINT" \
    --region "$OFFSITE_REGION"
  if [ "$AWS_RC" -eq 0 ]; then
    S3_LENGTH=$(sed -n 's/.*ContentLength[^0-9]*\([0-9][0-9]*\).*/\1/p' "$AWS_OUT" | awk 'NR == 1 { print; exit }')
    case "$S3_LENGTH" in
      ""|*[!0-9]*) return 1 ;;
    esac
    return 0
  fi
  _err=$(offsite_aws_err_text)
  case "$_err" in
    *404*|*NotFound*|*Not\ Found*|*NoSuchKey*) return 2 ;;
  esac
  return 1
}

offsite_s3_get() {
  _key=$1
  _dest=$2
  offsite_aws s3api get-object \
    --bucket "$OFFSITE_BUCKET" \
    --key "$_key" \
    --endpoint-url "$OFFSITE_ENDPOINT" \
    --region "$OFFSITE_REGION" \
    "$_dest"
  if [ "$AWS_RC" -ne 0 ] || [ ! -s "$_dest" ]; then
    return 1
  fi
  return 0
}

offsite_s3_put_new() {
  _key=$1
  _body=$2
  offsite_aws s3api put-object \
    --bucket "$OFFSITE_BUCKET" \
    --key "$_key" \
    --body "$_body" \
    --if-none-match '*' \
    --endpoint-url "$OFFSITE_ENDPOINT" \
    --region "$OFFSITE_REGION"
  if [ "$AWS_RC" -eq 0 ]; then
    return 0
  fi
  _err=$(offsite_aws_err_text)
  case "$_err" in
    *PreconditionFailed*|*412*) return 2 ;;
  esac
  return 1
}

offsite_download_matches() {
  _key=$1
  _expect_sha=$2
  _expect_size=$3
  _dest=$(mktemp "$OFFSITE_STATE_DIR/download.XXXXXX")
  if offsite_s3_head "$_key"; then
    _head_rc=0
  else
    _head_rc=$?
  fi
  if [ "$_head_rc" -eq 2 ]; then
    return 2
  fi
  if [ "$_head_rc" -ne 0 ]; then
    offsite_die FAILED remote-head-failure 19
  fi
  if [ "$S3_LENGTH" != "$_expect_size" ]; then
    offsite_die FAILED remote-checksum-mismatch 21
  fi
  if offsite_s3_get "$_key" "$_dest"; then
    _get_rc=0
  else
    _get_rc=$?
  fi
  if [ "$_get_rc" -ne 0 ]; then
    offsite_die FAILED remote-get-failure 20
  fi
  _got=$(offsite_sha256 "$_dest")
  _got_size=$(offsite_size "$_dest")
  if [ "$_got" != "$_expect_sha" ] || [ "$_got_size" != "$_expect_size" ]; then
    offsite_die FAILED remote-checksum-mismatch 21
  fi
  return 0
}

offsite_load_attempt() {
  _file="$OFFSITE_STATE_DIR/attempts/$BACKUP_DATE.env"
  ATTEMPT_PRESENT=0
  if [ ! -f "$_file" ]; then
    return 0
  fi
  ATTEMPT_ARCHIVE=
  ATTEMPT_SHA=
  ATTEMPT_CREATED=
  ATTEMPT_EPOCH=
  ATTEMPT_CIPHER_SHA=
  ATTEMPT_CIPHER_SIZE=
  ATTEMPT_STAGE=
  while IFS= read -r _line || [ -n "$_line" ]; do
    case "$_line" in
      backup_date="$BACKUP_DATE") ;;
      archive_name=stell22_[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]_[0-9][0-9]-[0-9][0-9]-[0-9][0-9].sql.gz)
        ATTEMPT_ARCHIVE=${_line#archive_name=}
        ;;
      archive_sha256=*)
        ATTEMPT_SHA=${_line#archive_sha256=}
        offsite_is_sha256 "$ATTEMPT_SHA" || offsite_die INCOMPLETE incomplete 31
        ;;
      created_at=*)
        ATTEMPT_CREATED=${_line#created_at=}
        ;;
      created_at_epoch=*)
        ATTEMPT_EPOCH=${_line#created_at_epoch=}
        ;;
      ciphertext_sha256=)
        ;;
      ciphertext_sha256=*)
        ATTEMPT_CIPHER_SHA=${_line#ciphertext_sha256=}
        offsite_is_sha256 "$ATTEMPT_CIPHER_SHA" || offsite_die INCOMPLETE incomplete 31
        ;;
      ciphertext_size=)
        ;;
      ciphertext_size=*)
        ATTEMPT_CIPHER_SIZE=${_line#ciphertext_size=}
        ;;
      stage=BACKUP_CREATED|stage=encrypted|stage=uploaded|stage=manifest)
        ATTEMPT_STAGE=${_line#stage=}
        ;;
      "") ;;
      *) offsite_die INCOMPLETE incomplete 31 ;;
    esac
  done < "$_file"
  if [ -z "$ATTEMPT_ARCHIVE" ] || [ -z "$ATTEMPT_SHA" ] || [ -z "$ATTEMPT_STAGE" ]; then
    offsite_die INCOMPLETE incomplete 31
  fi
  ATTEMPT_PRESENT=1
}

offsite_save_attempt() {
  _file="$OFFSITE_STATE_DIR/attempts/$BACKUP_DATE.env"
  _tmp=$(mktemp "$OFFSITE_STATE_DIR/attempt.XXXXXX")
  {
    printf 'backup_date=%s\n' "$BACKUP_DATE"
    printf 'archive_name=%s\n' "$ATTEMPT_ARCHIVE"
    printf 'archive_sha256=%s\n' "$ATTEMPT_SHA"
    printf 'created_at=%s\n' "$ATTEMPT_CREATED"
    printf 'created_at_epoch=%s\n' "$ATTEMPT_EPOCH"
    printf 'ciphertext_sha256=%s\n' "${ATTEMPT_CIPHER_SHA:-}"
    printf 'ciphertext_size=%s\n' "${ATTEMPT_CIPHER_SIZE:-}"
    printf 'stage=%s\n' "$ATTEMPT_STAGE"
  } > "$_tmp"
  mv "$_tmp" "$_file"
}

offsite_verify_local_archive() {
  _path=$1
  _base=${_path##*/}
  case "$_base" in
    stell22_[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]_[0-9][0-9]-[0-9][0-9]-[0-9][0-9].sql.gz) ;;
    *) offsite_die FAILED missing-archive 15 ;;
  esac
  if [ "$_path" != "$OFFSITE_BACKUP_DIR/$_base" ]; then
    offsite_die FAILED missing-archive 15
  fi
  if [ -L "$_path" ] || [ ! -f "$_path" ] || [ ! -s "$_path" ]; then
    offsite_die FAILED missing-archive 15
  fi
  if [ ! -f "$_path.sha256" ] || [ -L "$_path.sha256" ]; then
    offsite_die FAILED checksum-failure 16
  fi
  if ! (CDPATH= cd "$OFFSITE_BACKUP_DIR" && sha256sum -c "$_base.sha256" >/dev/null); then
    offsite_die FAILED checksum-failure 16
  fi
  if ! gzip -t "$_path"; then
    offsite_die FAILED checksum-failure 16
  fi
  LOCAL_ARCHIVE_NAME=$_base
  LOCAL_ARCHIVE_PATH=$_path
  LOCAL_ARCHIVE_SHA=$(offsite_sha256 "$_path")
}

offsite_list_archives() {
  _out=$1
  find "$OFFSITE_BACKUP_DIR" -maxdepth 1 -type f -name 'stell22_*.sql.gz' | sort > "$_out"
}

offsite_run_producer_if_needed() {
  offsite_load_attempt
  if [ "$ATTEMPT_PRESENT" -eq 1 ]; then
    offsite_verify_local_archive "$OFFSITE_BACKUP_DIR/$ATTEMPT_ARCHIVE"
    if [ "$LOCAL_ARCHIVE_SHA" != "$ATTEMPT_SHA" ]; then
      offsite_die FAILED checksum-failure 16
    fi
    return 0
  fi

  _before=$(mktemp "$OFFSITE_STATE_DIR/before.XXXXXX")
  offsite_list_archives "$_before"
  _producer="$SCRIPT_DIR/backup-db.sh"
  if [ "${STELL22_OFFSITE_TEST_HOOKS:-}" = "1" ] && [ -n "${STELL22_OFFSITE_PRODUCER:-}" ]; then
    _producer=$STELL22_OFFSITE_PRODUCER
  fi
  if [ ! -f "$_producer" ]; then
    offsite_die FAILED producer-failure 14
  fi
  _perr=$(mktemp "$OFFSITE_STATE_DIR/producer-err.XXXXXX")
  set +e
  _pout=$(BACKUP_DIR="$OFFSITE_BACKUP_DIR" sh "$_producer" 2>"$_perr")
  _prc=$?
  set -e
  if [ -s "$_perr" ]; then
    cat "$_perr" >&2
  fi
  if [ "$_prc" -ne 0 ]; then
    offsite_die FAILED producer-failure 14
  fi
  _count=0
  _path=
  while IFS= read -r _line || [ -n "$_line" ]; do
    case "$_line" in
      "[backup] BACKUP SUCCESS: "*)
        _count=$((_count + 1))
        _path=${_line#"[backup] BACKUP SUCCESS: "}
        ;;
    esac
  done <<EOF
$_pout
EOF
  if [ "$_count" -ne 1 ] || [ -z "$_path" ]; then
    offsite_die FAILED missing-archive 15
  fi
  if grep -F -x -q "$_path" "$_before"; then
    offsite_die FAILED missing-archive 15
  fi
  _after=$(mktemp "$OFFSITE_STATE_DIR/after.XXXXXX")
  offsite_list_archives "$_after"
  _new=$(mktemp "$OFFSITE_STATE_DIR/new.XXXXXX")
  awk 'NR == FNR { seen[$0] = 1; next } !seen[$0] { print }' "$_before" "$_after" > "$_new"
  _new_count=$(grep -c . "$_new" || true)
  if [ "$_new_count" -ne 1 ] || [ "$(cat "$_new")" != "$_path" ]; then
    offsite_die FAILED missing-archive 15
  fi
  offsite_verify_local_archive "$_path"
  ATTEMPT_ARCHIVE=$LOCAL_ARCHIVE_NAME
  ATTEMPT_SHA=$LOCAL_ARCHIVE_SHA
  ATTEMPT_CREATED=$(TZ=UTC date +%Y-%m-%dT%H:%M:%SZ)
  ATTEMPT_EPOCH=$NOW_EPOCH
  ATTEMPT_CIPHER_SHA=
  ATTEMPT_CIPHER_SIZE=
  ATTEMPT_STAGE=BACKUP_CREATED
  offsite_save_attempt
  printf '%s\n' "[offsite] stage=BACKUP_CREATED" >&2
}

offsite_mark_run_started() {
  if [ "${STELL22_OFFSITE_LOCK_HELD:-}" != "1" ]; then
    offsite_die FAILED concurrent 13
  fi
  _stamp="$OFFSITE_STATE_DIR/offsite-run.started"
  _tmp=$(mktemp "$OFFSITE_STATE_DIR/offsite-run.XXXXXX") || offsite_die FAILED configuration 10
  printf '%s\n' "$NOW_EPOCH" > "$_tmp"
  mv "$_tmp" "$_stamp" || offsite_die FAILED configuration 10
}

offsite_encrypt() {
  _work="$OFFSITE_STATE_DIR/work/$BACKUP_DATE"
  mkdir -p "$_work" || offsite_die FAILED encryption-failure 17
  CIPHER_PATH="$_work/archive.age"
  if [ -n "${ATTEMPT_CIPHER_SHA:-}" ] && [ -f "$CIPHER_PATH" ] && [ ! -L "$CIPHER_PATH" ]; then
    _have=$(offsite_sha256 "$CIPHER_PATH")
    _have_size=$(offsite_size "$CIPHER_PATH")
    if [ "$_have" = "$ATTEMPT_CIPHER_SHA" ] && [ "$_have_size" = "$ATTEMPT_CIPHER_SIZE" ]; then
      CIPHER_SHA=$ATTEMPT_CIPHER_SHA
      CIPHER_SIZE=$ATTEMPT_CIPHER_SIZE
      return 0
    fi
    offsite_die FAILED encryption-failure 17
  fi
  if [ -n "${ATTEMPT_CIPHER_SHA:-}" ] && [ -e "$CIPHER_PATH" ]; then
    offsite_die FAILED encryption-failure 17
  fi
  _tmp=$(mktemp "$_work/cipher.XXXXXX") || offsite_die FAILED encryption-failure 17
  if ! age -r "$OFFSITE_AGE_RECIPIENT" -o "$_tmp" "$LOCAL_ARCHIVE_PATH"; then
    rm -f "$_tmp"
    offsite_die FAILED encryption-failure 17
  fi
  if [ ! -f "$_tmp" ] || [ -L "$_tmp" ] || [ ! -s "$_tmp" ]; then
    rm -f "$_tmp"
    offsite_die FAILED encryption-failure 17
  fi
  CIPHER_SHA=$(offsite_sha256 "$_tmp")
  CIPHER_SIZE=$(offsite_size "$_tmp")
  if [ "$CIPHER_SHA" = "$LOCAL_ARCHIVE_SHA" ]; then
    rm -f "$_tmp"
    offsite_die FAILED encryption-failure 17
  fi
  if [ -e "$CIPHER_PATH" ] && [ -n "${ATTEMPT_CIPHER_SHA:-}" ]; then
    rm -f "$_tmp"
    offsite_die FAILED encryption-failure 17
  fi
  mv "$_tmp" "$CIPHER_PATH" || {
    rm -f "$_tmp"
    offsite_die FAILED encryption-failure 17
  }
  ATTEMPT_CIPHER_SHA=$CIPHER_SHA
  ATTEMPT_CIPHER_SIZE=$CIPHER_SIZE
  ATTEMPT_STAGE=encrypted
  offsite_save_attempt
}

offsite_fail_kind() {
  case "$1" in
    marker) offsite_die FAILED marker-failure 23 ;;
    manifest) offsite_die FAILED manifest-failure 22 ;;
    *) offsite_die FAILED upload-failure 18 ;;
  esac
}

offsite_put_verified() {
  _key=$1
  _body=$2
  _sha=$3
  _size=$4
  _kind=$5
  if offsite_s3_put_new "$_key" "$_body"; then
    _put_rc=0
  else
    _put_rc=$?
  fi
  set -e
  if [ "$_put_rc" -eq 2 ]; then
    if offsite_download_matches "$_key" "$_sha" "$_size"; then
      _match_rc=0
    else
      _match_rc=$?
    fi
    set -e
    if [ "$_match_rc" -ne 0 ]; then
      offsite_die FAILED remote-checksum-mismatch 21
    fi
    return 0
  fi
  if [ "$_put_rc" -ne 0 ]; then
    offsite_fail_kind "$_kind"
  fi
  if offsite_s3_head "$_key"; then
    _head_rc=0
  else
    _head_rc=$?
  fi
  set -e
  if [ "$_head_rc" -ne 0 ]; then
    offsite_die FAILED remote-head-failure 19
  fi
  if [ "$S3_LENGTH" != "$_size" ]; then
    offsite_die FAILED remote-checksum-mismatch 21
  fi
  _dest=$(mktemp "$OFFSITE_STATE_DIR/roundtrip.XXXXXX")
  if offsite_s3_get "$_key" "$_dest"; then
    _get_rc=0
  else
    _get_rc=$?
  fi
  set -e
  if [ "$_get_rc" -ne 0 ]; then
    case "$_kind" in
      marker) offsite_die FAILED marker-failure 23 ;;
      manifest) offsite_die FAILED manifest-failure 22 ;;
      *) offsite_die FAILED remote-get-failure 20 ;;
    esac
  fi
  _got=$(offsite_sha256 "$_dest")
  if [ "$_got" != "$_sha" ]; then
    case "$_kind" in
      marker) offsite_die FAILED marker-failure 23 ;;
      manifest) offsite_die FAILED manifest-failure 22 ;;
      *) offsite_die FAILED remote-checksum-mismatch 21 ;;
    esac
  fi
}

offsite_write_manifest() {
  MANIFEST_PATH="$OFFSITE_STATE_DIR/work/$BACKUP_DATE/manifest.json"
  if [ -f "$MANIFEST_PATH" ]; then
    return 0
  fi
  _tmp=$(mktemp "$OFFSITE_STATE_DIR/manifest.XXXXXX")
  cat > "$_tmp" <<EOF
{
  "version": 1,
  "backupDate": "$BACKUP_DATE",
  "timezone": "Europe/Moscow",
  "archiveName": "$LOCAL_ARCHIVE_NAME",
  "createdAt": "$ATTEMPT_CREATED",
  "archiveSha256": "$LOCAL_ARCHIVE_SHA",
  "ciphertextSha256": "$CIPHER_SHA",
  "ciphertextSize": $CIPHER_SIZE,
  "verificationResult": "remote-ciphertext-matches-local"
}
EOF
  mv "$_tmp" "$MANIFEST_PATH"
}

offsite_write_marker() {
  MARKER_PATH="$OFFSITE_STATE_DIR/work/$BACKUP_DATE/SUCCESS"
  MANIFEST_SHA=$(offsite_sha256 "$MANIFEST_PATH")
  _tmp=$(mktemp "$OFFSITE_STATE_DIR/marker.XXXXXX")
  cat > "$_tmp" <<EOF
version=1
status=OFFSITE_VERIFIED
backupDate=$BACKUP_DATE
timezone=Europe/Moscow
archiveName=$LOCAL_ARCHIVE_NAME
archiveSha256=$LOCAL_ARCHIVE_SHA
ciphertextSha256=$CIPHER_SHA
ciphertextSize=$CIPHER_SIZE
manifestSha256=$MANIFEST_SHA
createdAt=$ATTEMPT_CREATED
createdAtEpoch=$ATTEMPT_EPOCH
verificationResult=remote-ciphertext-matches-local
EOF
  mv "$_tmp" "$MARKER_PATH"
}

offsite_marker_field() {
  _file=$1
  _name=$2
  _val=$(awk -F= -v key="$_name" '$1 == key { print substr($0, length(key) + 2); exit }' "$_file")
  printf '%s' "$_val"
}

offsite_verify_marker_file() {
  _marker=$1
  _date=$2
  _status=$(offsite_marker_field "$_marker" status)
  _bdate=$(offsite_marker_field "$_marker" backupDate)
  _asha=$(offsite_marker_field "$_marker" archiveSha256)
  _csha=$(offsite_marker_field "$_marker" ciphertextSha256)
  _csize=$(offsite_marker_field "$_marker" ciphertextSize)
  _msha=$(offsite_marker_field "$_marker" manifestSha256)
  _epoch=$(offsite_marker_field "$_marker" createdAtEpoch)
  _aname=$(offsite_marker_field "$_marker" archiveName)
  if [ "$_status" != "OFFSITE_VERIFIED" ] || [ "$_bdate" != "$_date" ]; then
    return 1
  fi
  offsite_is_sha256 "$_asha" || return 1
  offsite_is_sha256 "$_csha" || return 1
  offsite_is_sha256 "$_msha" || return 1
  case "$_csize" in
    ""|*[!0-9]*) return 1 ;;
  esac
  case "$_epoch" in
    ""|*[!0-9]*) return 1 ;;
  esac
  case "$_aname" in
    stell22_[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]_[0-9][0-9]-[0-9][0-9]-[0-9][0-9].sql.gz) ;;
    *) return 1 ;;
  esac
  _man=$(mktemp "$OFFSITE_STATE_DIR/manifest-get.XXXXXX")
  if ! offsite_s3_get "$(offsite_manifest_key "$_date")" "$_man"; then
    return 1
  fi
  _got_m=$(offsite_sha256 "$_man")
  if [ "$_got_m" != "$_msha" ]; then
    return 1
  fi
  if ! grep -q "\"archiveSha256\": \"$_asha\"" "$_man"; then
    return 1
  fi
  if ! grep -q "\"ciphertextSha256\": \"$_csha\"" "$_man"; then
    return 1
  fi
  if ! grep -q "\"ciphertextSize\": $_csize" "$_man"; then
    return 1
  fi
  if ! grep -q "\"verificationResult\": \"remote-ciphertext-matches-local\"" "$_man"; then
    return 1
  fi
  if grep -q 'PostgreSQL database dump' "$_man" || grep -q 'AGE-SECRET-KEY' "$_man"; then
    return 1
  fi
  if ! offsite_download_matches "$(offsite_archive_key "$_date")" "$_csha" "$_csize"; then
    return 1
  fi
  VERIFIED_ARCHIVE_SHA=$_asha
  VERIFIED_CIPHER_SHA=$_csha
  VERIFIED_EPOCH=$_epoch
  VERIFIED_ARCHIVE_NAME=$_aname
  return 0
}

offsite_verify_remote_success() {
  _date=$1
  _key=$(offsite_success_key "$_date")
  if offsite_s3_head "$_key"; then
    _head_rc=0
  else
    _head_rc=$?
  fi
  if [ "$_head_rc" -eq 2 ]; then
    return 2
  fi
  if [ "$_head_rc" -ne 0 ]; then
    return 1
  fi
  _marker=$(mktemp "$OFFSITE_STATE_DIR/success-get.XXXXXX")
  if offsite_s3_get "$_key" "$_marker"; then
    _get_rc=0
  else
    _get_rc=$?
  fi
  if [ "$_get_rc" -ne 0 ]; then
    return 1
  fi
  if ! offsite_verify_marker_file "$_marker" "$_date"; then
    return 1
  fi
  return 0
}

offsite_finish_verified() {
  _already=$1
  _tmp=$(mktemp "$OFFSITE_STATE_DIR/last-run.XXXXXX")
  printf '%s\n' "status=OFFSITE_VERIFIED" "reason=verified" "backup_date=$BACKUP_DATE" > "$_tmp"
  mv "$_tmp" "$OFFSITE_STATE_DIR/last-run.env"
  printf '%s\n' \
    "STATUS=OFFSITE_VERIFIED" \
    "BACKUP_DATE=$BACKUP_DATE" \
    "ARCHIVE_SHA256=$VERIFIED_ARCHIVE_SHA" \
    "CIPHERTEXT_SHA256=$VERIFIED_CIPHER_SHA" \
    "ALREADY=${_already}" \
    "RESTORE_VERIFIED=0"
  exit 0
}

offsite_run() {
  if offsite_verify_remote_success "$BACKUP_DATE"; then
    _have=0
  else
    _have=$?
  fi
  set -e
  if [ "$_have" -eq 0 ]; then
    offsite_finish_verified 1
  fi
  if [ "$_have" -ne 2 ]; then
    offsite_die INCOMPLETE incomplete 31
  fi

  offsite_run_producer_if_needed
  offsite_encrypt
  _akey=$(offsite_archive_key "$BACKUP_DATE")
  offsite_put_verified "$_akey" "$CIPHER_PATH" "$CIPHER_SHA" "$CIPHER_SIZE" archive
  ATTEMPT_STAGE=uploaded
  offsite_save_attempt
  offsite_write_manifest
  _mkey=$(offsite_manifest_key "$BACKUP_DATE")
  _msha=$(offsite_sha256 "$MANIFEST_PATH")
  _msize=$(offsite_size "$MANIFEST_PATH")
  offsite_put_verified "$_mkey" "$MANIFEST_PATH" "$_msha" "$_msize" manifest
  ATTEMPT_STAGE=manifest
  offsite_save_attempt
  offsite_write_marker
  _skey=$(offsite_success_key "$BACKUP_DATE")
  _ssha=$(offsite_sha256 "$MARKER_PATH")
  _ssize=$(offsite_size "$MARKER_PATH")
  offsite_put_verified "$_skey" "$MARKER_PATH" "$_ssha" "$_ssize" marker
  if ! offsite_verify_remote_success "$BACKUP_DATE"; then
    offsite_die FAILED marker-failure 23
  fi
  offsite_finish_verified 0
}

offsite_latest_verified_date() {
  _cursor=$BACKUP_DATE
  _left=$OFFSITE_LOOKBACK_DAYS
  while [ "$_left" -gt 0 ]; do
    if offsite_verify_remote_success "$_cursor"; then
      _rc=0
    else
      _rc=$?
    fi
    set -e
    if [ "$_rc" -eq 0 ]; then
      LATEST_DATE=$_cursor
      return 0
    fi
    if [ "$_rc" -ne 2 ]; then
      offsite_die INCOMPLETE incomplete 31
    fi
    _cursor=$(offsite_prev_day "$_cursor")
    _left=$((_left - 1))
  done
  return 2
}

offsite_health_main() {
  _lock="$OFFSITE_STATE_DIR/offsite.lock"
  if [ ! -e "$_lock" ]; then
    : > "$_lock"
  fi
  if flock -n "$_lock" true; then
    _lock_rc=0
  else
    _lock_rc=$?
  fi
  set -e
  if [ "$_lock_rc" -ne 0 ]; then
    offsite_report_running
  fi
  offsite_health_current_failure
  if offsite_latest_verified_date; then
    offsite_require_fresh_copy
    printf '%s\n' \
      "STATUS=OFFSITE_VERIFIED" \
      "BACKUP_DATE=$LATEST_DATE" \
      "ARCHIVE_SHA256=$VERIFIED_ARCHIVE_SHA" \
      "CIPHERTEXT_SHA256=$VERIFIED_CIPHER_SHA" \
      "AGE_HOURS=$_age" \
      "RESTORE_VERIFIED=0"
    exit 0
  fi
  _akey=$(offsite_archive_key "$BACKUP_DATE")
  if offsite_s3_head "$_akey"; then
    printf '%s\n' "STATUS=INCOMPLETE" "BACKUP_DATE=$BACKUP_DATE" "REASON=marker-missing" "RESTORE_VERIFIED=0"
    exit 31
  fi
  if [ -f "$OFFSITE_STATE_DIR/attempts/$BACKUP_DATE.env" ]; then
    offsite_load_attempt
    if [ "$ATTEMPT_PRESENT" -eq 1 ]; then
      printf '%s\n' "STATUS=BACKUP_CREATED" "BACKUP_DATE=$BACKUP_DATE" "REASON=${ATTEMPT_STAGE}" "RESTORE_VERIFIED=0"
      exit 31
    fi
  fi
  if [ -f "$OFFSITE_STATE_DIR/last-run.env" ]; then
    _reason=$(awk -F= '$1 == "reason" { print substr($0, 8); exit }' "$OFFSITE_STATE_DIR/last-run.env")
    _status=$(awk -F= '$1 == "status" { print substr($0, 8); exit }' "$OFFSITE_STATE_DIR/last-run.env")
    case "$_status" in
      FAILED|INCOMPLETE)
        printf '%s\n' "STATUS=FAILED" "BACKUP_DATE=$BACKUP_DATE" "REASON=${_reason:-failed}" "RESTORE_VERIFIED=0"
        exit 32
        ;;
    esac
  fi
  printf '%s\n' "STATUS=MISSING_BACKUP" "BACKUP_DATE=$BACKUP_DATE" "REASON=missing" "RESTORE_VERIFIED=0"
  exit 30
}

offsite_health_current_failure() {
  if [ ! -f "$OFFSITE_STATE_DIR/last-run.env" ]; then
    return 0
  fi
  _reason=$(awk -F= '$1 == "reason" { print substr($0, 8); exit }' "$OFFSITE_STATE_DIR/last-run.env")
  _status=$(awk -F= '$1 == "status" { print substr($0, 8); exit }' "$OFFSITE_STATE_DIR/last-run.env")
  _date=$(awk -F= '$1 == "backup_date" { print substr($0, 13); exit }' "$OFFSITE_STATE_DIR/last-run.env")
  if [ "$_date" != "$BACKUP_DATE" ]; then
    return 0
  fi
  case "$_status" in
    FAILED|INCOMPLETE)
      printf '%s\n' "STATUS=FAILED" "BACKUP_DATE=$BACKUP_DATE" "REASON=${_reason:-failed}" "RESTORE_VERIFIED=0"
      exit 32
      ;;
  esac
  return 0
}

offsite_emit_visibility() {
  if [ -n "${OFFSITE_REPORT_VISIBILITY:-}" ]; then
    printf '%s\n' "VPS_LOSS_VISIBILITY=$OFFSITE_REPORT_VISIBILITY"
  fi
}

offsite_require_fresh_copy() {
  _now_epoch=$(offsite_decimal "$NOW_EPOCH") || offsite_die FAILED timezone 24
  _verified_epoch=$(offsite_decimal "$VERIFIED_EPOCH") || offsite_die FAILED timezone 24
  if [ "$_now_epoch" -lt "$_verified_epoch" ]; then
    offsite_die FAILED timezone 24
  fi
  _age=$(( (_now_epoch - _verified_epoch) / 3600 ))
  if [ "$_age" -gt "$OFFSITE_MAX_AGE_HOURS" ]; then
    printf '%s\n' "STATUS=MISSING_BACKUP" "BACKUP_DATE=$LATEST_DATE" "REASON=stale" "AGE_HOURS=$_age" "RESTORE_VERIFIED=0"
    offsite_emit_visibility
    exit 33
  fi
  _clock=$(offsite_decimal "$CLOCK_HHMM") || offsite_die FAILED timezone 24
  _grace=$(offsite_decimal "$OFFSITE_GRACE_HHMM") || offsite_die FAILED timezone 24
  if [ "$LATEST_DATE" != "$BACKUP_DATE" ] && [ "$_clock" -ge "$_grace" ]; then
    printf '%s\n' "STATUS=MISSING_BACKUP" "BACKUP_DATE=$BACKUP_DATE" "REASON=missed" "RESTORE_VERIFIED=0"
    offsite_emit_visibility
    exit 30
  fi
}

offsite_report_running() {
  _started=$(cat "$OFFSITE_STATE_DIR/offsite-run.started" 2>/dev/null || true)
  _started=$(offsite_decimal "$_started") || {
    printf '%s\n' "STATUS=FAILED" "BACKUP_DATE=$BACKUP_DATE" "REASON=run-unmeasured" "RESTORE_VERIFIED=0"
    exit 35
  }
  _now_epoch=$(offsite_decimal "$NOW_EPOCH") || offsite_die FAILED timezone 24
  if [ "$_now_epoch" -lt "$_started" ]; then
    _held=0
  else
    _held=$((_now_epoch - _started))
  fi
  _limit=$(offsite_decimal "$OFFSITE_RUN_MAX_SECONDS") || offsite_die FAILED configuration 10
  if [ "$_held" -gt "$_limit" ]; then
    printf '%s\n' "STATUS=FAILED" "BACKUP_DATE=$BACKUP_DATE" "REASON=run-exceeded" "AGE_SECONDS=$_held" "RESTORE_VERIFIED=0"
    exit 35
  fi
  printf '%s\n' "STATUS=RUNNING" "BACKUP_DATE=$BACKUP_DATE" "REASON=in-progress" "AGE_SECONDS=$_held" "RESTORE_VERIFIED=0"
  exit 0
}

offsite_external_main() {
  if [ "${OFFSITE_EXTERNAL_LOCATION:-independent}" = "vps" ]; then
    printf '%s\n' "STATUS=REFUSED" "REASON=vps-cannot-detect-own-loss" "VPS_LOSS_VISIBILITY=none" "RESTORE_VERIFIED=0"
    exit 34
  fi
  OFFSITE_REPORT_VISIBILITY=independent
  if ! offsite_latest_verified_date; then
    printf '%s\n' "STATUS=MISSING_BACKUP" "REASON=missing" "VPS_LOSS_VISIBILITY=independent" "RESTORE_VERIFIED=0"
    exit 30
  fi
  offsite_require_fresh_copy
  printf '%s\n' \
    "STATUS=OFFSITE_VERIFIED" \
    "BACKUP_DATE=$LATEST_DATE" \
    "CIPHERTEXT_SHA256=$VERIFIED_CIPHER_SHA" \
    "ARCHIVE_SHA256=$VERIFIED_ARCHIVE_SHA" \
    "VPS_LOSS_VISIBILITY=independent" \
    "AGE_HOURS=$_age" \
    "RESTORE_VERIFIED=0"
  exit 0
}
