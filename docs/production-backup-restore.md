# Isolated production-backup restore check

This procedure restores one explicitly selected archive into a new
PostgreSQL 17 container and checks that copy. It does not restore the
application database. `scripts/restore-db.sh` stays disabled and this
procedure never invokes it.

`RESTORE_VERIFIED` means the isolated checks below passed. It is not
permission to restore production, apply P1, split roles, or deploy.

## Two trust contracts

| Contract | What it proves |
| --- | --- |
| `stell22_drill_archive_provenance` in `scripts/restore-drill.sh` | The synthetic drill created that digest in the same disposable cluster. Unchanged. |
| Operator trust file `PRODUCTION_BACKUP_V1` | A person selected this archive and typed its digest again. |

A `.sha256` sidecar proves only that the checksum file and the archive bytes
agree. It does not prove which server produced them. Copying the sidecar into
the trust path is refused.

The trust file is exactly these five lines, with a lowercase SHA-256:

```text
contract=PRODUCTION_BACKUP_V1
origin=OPERATOR_SELECTED_PRODUCTION_BACKUP
name=stell22_YYYY-MM-DD_HH-MM-SS.sql.gz
sha256=<64 hex characters>
selector=<8 to 64 letters, digits, _ or ->
```

The same digest is passed in `STELL22_PBR_SHA256`. The same selector is
passed in `STELL22_PBR_SELECTOR`. The archive path is an argument. The
procedure does not search a backup directory and does not pick the newest
file.

## What the check does

1. Reject symlinks, a mismatched name, a missing sidecar, a digest mismatch,
   a changed file, a failed `gzip -t`, and a dump that is not plain SQL.
2. Reject `CREATE DATABASE`, `DROP DATABASE`, and psql meta-commands other
   than `\restrict` and `\unrestrict`.
3. Create container `stell22-pbr-<run>` from `postgres:17-alpine` with
   `--network none`. `<run>` is 12 to 32 lowercase letters or digits. No
   Docker network is created and no port is published.
4. Refuse Compose, any network other than `none`, a published port, the
   application database name, the integrity database name, and the
   application container names. Data is on tmpfs, not on a named volume.
5. Refuse `stell22_pbr_dst` if it already exists.
6. Restore with one transaction. A SQL error that leaves no tables is
   `FAILED_RESTORE_SQL`. Leftover tables are `FAILED_PARTIAL`. The destination
   is kept for evidence. Nothing is dropped to hide that state.
7. Read the destination again in a separate `psql`. Compare table count,
   constraint count, migration count, the SHA-256 of the ordered migration
   names, and `P1_STATE`. `P1_STATE` is `PRESENT` or `ABSENT` for migration
   `20261010210000_psr_p3_s2_b_batch_receipt_provenance`. It is not a P1 apply
   result.
8. Print `RESULT=RESTORE_VERIFIED` only after that second read matches the
   control file. The control file contains counts and digests, not business
   rows.

Cleanup reads the evidence file and removes that container id only when the
live name, label, and image still match. It then removes only anonymous
volumes recorded on that container, then that network id if it is empty.
It does not prune Docker. `RESULT=FAILED_CLEANUP` leaves the recorded ids in
place.

Stdout is status lines only. SQL, passwords, and row contents stay in the
evidence directory, mode 600, and must not be copied into git, CI logs, or
this report.

## Later sequence

No step below is authorized by the existence of this document.

| Step | Owner authorization |
| --- | --- |
| Let the existing 03:00 UTC cron create an archive, or run the backup entry point by hand | Hand execution needs a separate authorization. This document does not grant it. |
| Read the new archive name, size, and SHA-256. Write the trust file locally. Do not print SQL or business rows. | Read of an archive that cron already wrote. Do not copy the archive into git. |
| Confirm the destination is a new `stell22-pbr-*` container and not an application container | Required before a production-origin archive is used. |
| Run `scripts/production-backup-restore.sh` against that archive | Required. Synthetic archives in disposable tests are the only runs covered by the preparation task. |
| Independent schema, migration, and control-count check | Part of the same authorized run. The script does this before `RESTORE_VERIFIED`. |
| Read-only check that the application is still running | Separate read. This script does not connect to the application. |
| Report `RESTORE VERIFIED` or `RESTORE NOT VERIFIED` | After the isolated run. `P1_STATE` is a separate line. |

`RESTORE NOT VERIFIED` covers refusal, SQL failure, a partial destination,
inspect mismatch, and uncertainty. On `UNCERTAIN` or `FAILED_PARTIAL`, keep
the evidence files and the recorded container. Do not delete them with a
broader Docker command. A further corrective action needs its own decision.

Production restore, P1 apply, role split, and production release stay
unauthorized.
