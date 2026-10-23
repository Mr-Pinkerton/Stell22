# Same-host backup check

This is a separate one-shot check for archive
`stell22_2026-10-23_03-00-01.sql.gz`. It does not replace
`scripts/restore-db.sh` or `scripts/production-backup-restore.sh`, and it
does not call `restore-db.sh`.

`scripts/restore-db.sh` stays disabled. `scripts/production-backup-restore.sh`
still refuses an engine that already contains `stell22-app`,
`stell22-db-prod`, or `stell22-caddy`.

Production execution is not authorized. Do not copy this script to the
server, do not pull an image there, and do not pass
`STELL22_SAME_HOST_EXECUTE=1` until HEAD authorizes that run.

## What a future authorized run would do

`execute` restores that one archive into a new container
`stell22-samehost-<run>`. The container uses the pinned PostgreSQL 17
image, `--network none`, no published port, no Compose project, and no
production volume. Memory and swap are capped at 768 MiB, CPU at 0.5, and
PIDs at 128. PostgreSQL data is a 256 MiB tmpfs. `shared_buffers` is 32MB.

The archive name and SHA-256 are fixed. A trust file uses the existing
`PRODUCTION_BACKUP_V1` contract. The accepted verifier scans the dump
before the container is created. The check compares table count, constraint
count, migration count, the migration-name digest, both schema fingerprints,
`P1_ROW`, and `P1_STATE`. `RESULT=RESTORE_VERIFIED` is not production
restore, P1 apply, role split, or release.

Before and during startup the script stops unless available memory is at
least the 768 MiB cap plus 1 GiB, `stell22-app` and `stell22-db-prod` are
healthy, and `stell22-caddy` is running. It does not pull a missing image.
On `STOP_RESOURCES`, `STOP_HEALTH`, mismatch, or exit, it removes only the
container id it created, including that container's anonymous volumes.
`SIGINT` and `SIGTERM` use the same cleanup. A control file is required;
without matching controls the result is `INSPECT_MISMATCH`, not
`RESTORE_VERIFIED`.

## Synthetic proof

On a machine that does not have the production containers:

```sh
STELL22_SAME_HOST_DOCKER=1 node scripts/vitest-run.mjs run src/server/production-backup-same-host.test.ts
```

The synthetic command refuses the production archive name and digest.
