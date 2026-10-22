/**
 * Disposable PostgreSQL 17 checks for production-backup restore verification.
 * Uses synthetic SQL only. Does not call docker compose or prune.
 * Does not read DATABASE_URL.
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const script = path.join(root, "scripts", "production-backup-restore.sh");
const secretMarker = "SYNTHETIC_NOTE_DO_NOT_PRINT";
const p1 = "20261010210000_psr_p3_s2_b_batch_receipt_provenance";
const evidence = [];
const ownedTemps = [];
const ownedTempPattern = /^\/tmp\/stell22-pbr-ci\.[A-Za-z0-9]+$/;

export function removeOwnedTemps(dirs) {
  for (const dir of dirs) {
    if (!ownedTempPattern.test(dir)) {
      throw new Error("refusing to delete an untracked directory");
    }
  }
  for (const dir of dirs) {
    const removed = sh('rm -rf "$1"', [dir]);
    if (removed.status !== 0) throw new Error("temp removal failed");
  }
}

function fail(message) {
  console.error(`[production-backup-restore-ci] ОШИБКА: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: options.env ?? process.env,
    input: options.input,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function sh(command, args = [], env = {}) {
  return run("sh", ["-c", command, "sh", ...args], { env: { ...process.env, ...env } });
}

function ids(args) {
  const listed = run("docker", args);
  if (listed.status !== 0) fail("docker list failed");
  return (listed.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
}

function field(text, key) {
  const match = text.match(new RegExp(`^${key}=(.*)$`, "m"));
  return match?.[1] ?? "";
}

function posixTemp() {
  const made = sh("mktemp -d /tmp/stell22-pbr-ci.XXXXXX");
  if (made.status !== 0) fail("mktemp failed");
  const dir = (made.stdout ?? "").trim();
  if (!ownedTempPattern.test(dir)) fail("unexpected temp");
  ownedTemps.push(dir);
  return dir;
}

function writePosix(file, text) {
  const written = run("sh", ["-c", 'cat > "$1"', "sh", file], { input: text });
  if (written.status !== 0) fail("write failed");
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function pack(dir, name, sql) {
  writePosix(`${dir}/plain.sql`, sql);
  const packed = sh(
    'gzip -c "$1/plain.sql" > "$1/$2" && cd "$1" && sha256sum -t "$2" > "$2.sha256" && awk \'NR==1 { print $1; exit }\' "$2.sha256"',
    [dir, name],
  );
  if (packed.status !== 0) fail("pack failed");
  const digest = (packed.stdout ?? "").trim();
  if (!/^[0-9a-f]{64}$/.test(digest)) fail("digest missing");
  return { archive: `${dir}/${name}`, digest };
}

function trustFile(dir, name, digest, selector) {
  const file = `${dir}/trust.txt`;
  writePosix(
    file,
    [
      "contract=PRODUCTION_BACKUP_V1",
      "origin=OPERATOR_SELECTED_PRODUCTION_BACKUP",
      `name=${name}`,
      `sha256=${digest}`,
      `selector=${selector}`,
      "",
    ].join("\n"),
  );
  return file;
}

function controls(dir, values) {
  const file = `${dir}/controls.txt`;
  writePosix(
    file,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")
      .concat("\n"),
  );
  return file;
}

function procedure(args, env) {
  const result = run("sh", [script, ...args], {
    env: {
      ...process.env,
      STELL22_PBR_DISPOSABLE: "1",
      ...env,
    },
  });
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (text.includes(secretMarker)) fail("procedure printed synthetic payload");
  const evidenceFile = field(result.stdout ?? "", "EVIDENCE_FILE");
  if (evidenceFile) evidence.push(evidenceFile);
  return result;
}

function assertResult(result, expected) {
  const got = field(result.stdout ?? "", "RESULT");
  if (
    result.status === 0 &&
    expected !== "RESTORE_VERIFIED" &&
    expected !== "ARCHIVE_OK" &&
    expected !== "PREPARED" &&
    expected !== "CLEANED"
  ) {
    fail(`${expected} exited 0 (${got})`);
  }
  if (got !== expected) {
    const safe = (result.stdout ?? "")
      .split(/\r?\n/)
      .filter((line) => /^(RESULT|DETAIL|P1_|PUBLIC_|ROLLBACK)=/.test(line))
      .join("\n");
    console.error(safe);
    const err = (result.stderr ?? "")
      .split(/\r?\n/)
      .filter((line) => !/password/i.test(line) && !line.includes(secretMarker) && line.trim())
      .slice(0, 20);
    if (err.length) console.error(err.join("\n"));
    fail(`expected ${expected} got ${got || "no RESULT"}`);
  }
}

function psql(container, database, sql) {
  const result = run(
    "docker",
    [
      "exec",
      "-i",
      container,
      "psql",
      "-X",
      "-U",
      "stell22",
      "-d",
      database,
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
      "-At",
      "-f",
      "-",
    ],
    { input: sql },
  );
  if (result.status !== 0) fail("independent psql failed");
  return (result.stdout ?? "").trim();
}

function cleanupAll() {
  const seen = new Set();
  for (const file of evidence) {
    if (seen.has(file)) continue;
    seen.add(file);
    const cleaned = procedure(["cleanup", file], {});
    if (field(cleaned.stdout ?? "", "RESULT") !== "CLEANED" && cleaned.status !== 0) {
      const retry = run("sh", [script, "cleanup", file], { env: process.env });
      if (field(retry.stdout ?? "", "RESULT") !== "CLEANED") {
        console.error("[production-backup-restore-ci] cleanup did not remove recorded ids");
        process.exitCode = 1;
      }
    }
  }
  removeOwnedTemps(ownedTemps.splice(0, ownedTemps.length));
  for (const file of seen) {
    const dir = path.posix.dirname(file);
    if (!/^\/tmp\/stell22-pbr\.[A-Za-z0-9]+$/.test(dir)) continue;
    sh('rm -rf "$1"', [dir]);
  }
}

const migrationName = "20261001000000_synthetic_init";
const migrationSha = sha256(`${migrationName}\n`);
const successSql = [
  "-- PostgreSQL database dump",
  "\\restrict stell22pbrtesttoken",
  `-- ${secretMarker}`,
  "CREATE TABLE stell22_pbr_control (id integer PRIMARY KEY, n integer NOT NULL);",
  "INSERT INTO stell22_pbr_control (id, n) VALUES (1, 1), (2, 2);",
  'CREATE TABLE "_prisma_migrations" (id text PRIMARY KEY, migration_name text NOT NULL, finished_at timestamptz, rolled_back_at timestamptz, applied_steps_count integer NOT NULL);',
  `INSERT INTO "_prisma_migrations" (id, migration_name, finished_at, rolled_back_at, applied_steps_count) VALUES ('m1', '${migrationName}', '2026-01-01 00:00:00+00', NULL, 1);`,
  "\\unrestrict stell22pbrtesttoken",
  "-- PostgreSQL database dump complete",
  "",
].join("\n");

function main() {
  const foreignMade = sh("mktemp -d /tmp/stell22-pbr-ci.XXXXXX");
  if (foreignMade.status !== 0) fail("foreign temp failed");
  const foreignDir = (foreignMade.stdout ?? "").trim();
  if (!ownedTempPattern.test(foreignDir) || ownedTemps.includes(foreignDir)) fail("foreign temp was tracked");
  writePosix(`${foreignDir}/marker`, "keep\n");
  const digest = readFileSync(script, "utf8").match(/^IMAGE_DIGEST=(sha256:[0-9a-f]{64})$/m)?.[1];
  if (!digest) fail("image digest missing");
  const imageRef = `postgres:17-alpine@${digest}`;
  const foreignName = `pbr-ci-foreign-${crypto.randomBytes(4).toString("hex")}`;
  const foreignCreated = run("docker", [
    "create",
    "--name",
    foreignName,
    "--network",
    "none",
    "--label",
    "stell22.pbr-ci-foreign=1",
    imageRef,
  ]);
  if (foreignCreated.status !== 0) fail("foreign container was not created");
  const foreignId = (foreignCreated.stdout ?? "").trim();
  if (!/^[0-9a-f]{64}$/.test(foreignId)) fail("foreign container id missing");

const containersBefore = ids(["ps", "-aq", "--no-trunc"]);
const networksBefore = ids(["network", "ls", "-q", "--no-trunc"]);
const volumesBefore = ids(["volume", "ls", "-q"]);

try {
  const dir = posixTemp();
  const name = "stell22_2026-10-22_03-00-01.sql.gz";
  const packed = pack(dir, name, successSql);
  const trust = trustFile(dir, name, packed.digest, "synthetic-selector");
  const control = controls(dir, {
    public_tables: "2",
    public_constraints: "2",
    migration_rows: "1",
    migration_names_sha256: migrationSha,
    p1_row: "ABSENT",
    p1_applied: "NOT_APPLIED",
    control_rows: "2",
  });
  const runId = `pbr${crypto.randomBytes(8).toString("hex")}`;
  const env = {
    STELL22_PBR_SHA256: packed.digest,
    STELL22_PBR_SELECTOR: "synthetic-selector",
    STELL22_PBR_RUN: runId,
  };

  const verified = procedure(["verify", packed.archive, trust], env);
  assertResult(verified, "ARCHIVE_OK");

  const restored = procedure(["run", packed.archive, trust, control], env);
  assertResult(restored, "RESTORE_VERIFIED");
  if (field(restored.stdout ?? "", "P1_ROW") !== "ABSENT") fail("P1 row was not reported separately");
  if (field(restored.stdout ?? "", "P1_STATE") !== "NOT_APPLIED") fail("P1 completion was not reported separately");
  if (/P1 apply|P1_APPLY/i.test(restored.stdout ?? "")) fail("restore claimed P1 apply");
  const container = field(restored.stdout ?? "", "CONTAINER");
  if (!/^[0-9a-f]{64}$/.test(container)) fail("container id was not recorded");
  if (containersBefore.includes(container)) fail("procedure reused an existing container");
  const rows = psql(container, "stell22_pbr_dst", "SELECT count(*) FROM stell22_pbr_control;");
  if (rows !== "2") fail("independent control count mismatch");
  const p1Count = psql(
    container,
    "stell22_pbr_dst",
    `SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '${p1}';`,
  );
  if (p1Count !== "0") fail("independent P1 count mismatch");

  const again = procedure(["run", packed.archive, trust, control], env);
  assertResult(again, "REFUSED_POPULATED");
  const rowsAfter = psql(container, "stell22_pbr_dst", "SELECT count(*) FROM stell22_pbr_control;");
  if (rowsAfter !== "2") fail("repeated invocation changed control rows");

  const occupiedRun = `pbr${crypto.randomBytes(8).toString("hex")}`;
  const prepared = procedure(["prepare"], { ...env, STELL22_PBR_RUN: occupiedRun });
  assertResult(prepared, "PREPARED");
  const occupiedContainer = field(prepared.stdout ?? "", "CONTAINER");
  const seeded = run(
    "docker",
    [
      "exec",
      "-i",
      occupiedContainer,
      "psql",
      "-X",
      "-U",
      "stell22",
      "-d",
      "stell22_pbr_admin",
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
      "-f",
      "-",
    ],
    {
      input: "CREATE DATABASE stell22_pbr_dst;\n",
    },
  );
  if (seeded.status !== 0) fail("could not precreate destination");
  const seededTable = run(
    "docker",
    [
      "exec",
      "-i",
      occupiedContainer,
      "psql",
      "-X",
      "-U",
      "stell22",
      "-d",
      "stell22_pbr_dst",
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
      "-f",
      "-",
    ],
    {
      input:
        "CREATE TABLE dirty_keep (id integer PRIMARY KEY); INSERT INTO dirty_keep (id) VALUES (1);\n",
    },
  );
  if (seededTable.status !== 0) fail("could not precreate table");
  const occupiedTrust = trust;
  const refused = procedure(
    [
      "restore",
      packed.archive,
      occupiedTrust,
      control,
      field(prepared.stdout ?? "", "EVIDENCE_FILE"),
    ],
    {
      ...env,
      STELL22_PBR_RUN: occupiedRun,
    },
  );
  assertResult(refused, "REFUSED_POPULATED");
  const kept = psql(occupiedContainer, "stell22_pbr_dst", "SELECT count(*) FROM dirty_keep;");
  if (kept !== "1") fail("populated destination was modified");

  const brokenDir = posixTemp();
  const brokenName = "stell22_2026-10-22_03-00-02.sql.gz";
  const brokenSql = [
    "-- PostgreSQL database dump",
    "SELECT 1/0;",
    "-- PostgreSQL database dump complete",
    "",
  ].join("\n");
  const broken = pack(brokenDir, brokenName, brokenSql);
  const brokenTrust = trustFile(brokenDir, brokenName, broken.digest, "synthetic-selector");
  const brokenRun = `pbr${crypto.randomBytes(8).toString("hex")}`;
  const failed = procedure(["run", broken.archive, brokenTrust, control], {
    ...env,
    STELL22_PBR_SHA256: broken.digest,
    STELL22_PBR_RUN: brokenRun,
  });
  assertResult(failed, "FAILED_RESTORE_SQL");
  if (field(failed.stdout ?? "", "ROLLBACK") !== "YES") fail("SQL failure was not rolled back");
  const failedContainer = field(failed.stdout ?? "", "CONTAINER");
  const left = psql(
    failedContainer,
    "stell22_pbr_dst",
    "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p');",
  );
  if (left !== "0") fail("rolled back destination is not empty");

  const partialDir = posixTemp();
  const partialName = "stell22_2026-10-22_03-00-03.sql.gz";
  const partialSql = [
    "-- PostgreSQL database dump",
    "CREATE TABLE stell22_pbr_control (id integer PRIMARY KEY, n integer NOT NULL);",
    "INSERT INTO stell22_pbr_control (id, n) VALUES (1, 1);",
    "SELECT 1/0;",
    "-- PostgreSQL database dump complete",
    "",
  ].join("\n");
  const partial = pack(partialDir, partialName, partialSql);
  const partialTrust = trustFile(partialDir, partialName, partial.digest, "synthetic-selector");
  const partialRun = `pbr${crypto.randomBytes(8).toString("hex")}`;
  const partialResult = procedure(["run", partial.archive, partialTrust, control], {
    ...env,
    STELL22_PBR_SHA256: partial.digest,
    STELL22_PBR_RUN: partialRun,
    STELL22_PBR_FAILPOINT: "split-transaction",
  });
  assertResult(partialResult, "FAILED_PARTIAL");
  const partialContainer = field(partialResult.stdout ?? "", "CONTAINER");
  const partialRows = psql(
    partialContainer,
    "stell22_pbr_dst",
    "SELECT count(*) FROM stell22_pbr_control;",
  );
  if (partialRows !== "1") fail("partial destination was not preserved");

  const presentDir = posixTemp();
  const presentName = "stell22_2026-10-22_03-00-04.sql.gz";
  const presentSql = [
    "-- PostgreSQL database dump",
    "CREATE TABLE stell22_pbr_control (id integer PRIMARY KEY, n integer NOT NULL);",
    "INSERT INTO stell22_pbr_control (id, n) VALUES (1, 1);",
    'CREATE TABLE "_prisma_migrations" (id text PRIMARY KEY, migration_name text NOT NULL, finished_at timestamptz, rolled_back_at timestamptz, applied_steps_count integer NOT NULL);',
    `INSERT INTO "_prisma_migrations" (id, migration_name, finished_at, rolled_back_at, applied_steps_count) VALUES ('p1', '${p1}', NULL, NULL, 0);`,
    "-- PostgreSQL database dump complete",
    "",
  ].join("\n");
  const present = pack(presentDir, presentName, presentSql);
  const presentTrust = trustFile(presentDir, presentName, present.digest, "synthetic-selector");
  const presentControl = controls(presentDir, {
    public_tables: "2",
    public_constraints: "2",
    migration_rows: "1",
    migration_names_sha256: sha256(`${p1}\n`),
    p1_row: "PRESENT",
    p1_applied: "NOT_APPLIED",
    control_rows: "1",
  });
  const presentRun = `pbr${crypto.randomBytes(8).toString("hex")}`;
  const presentResult = procedure(["run", present.archive, presentTrust, presentControl], {
    ...env,
    STELL22_PBR_SHA256: present.digest,
    STELL22_PBR_RUN: presentRun,
  });
  assertResult(presentResult, "RESTORE_VERIFIED");
  if (field(presentResult.stdout ?? "", "P1_ROW") !== "PRESENT") fail("unfinished P1 row was not reported");
  if (field(presentResult.stdout ?? "", "P1_STATE") !== "NOT_APPLIED")
    fail("unfinished P1 row was treated as applied");
  if (/P1 apply|P1_APPLY/i.test(presentResult.stdout ?? "")) fail("restore claimed P1 apply");

  const appliedDir = posixTemp();
  const appliedName = "stell22_2026-10-22_03-00-05.sql.gz";
  const appliedSql = [
    "-- PostgreSQL database dump",
    "CREATE TABLE stell22_pbr_control (id integer PRIMARY KEY, n integer NOT NULL);",
    "INSERT INTO stell22_pbr_control (id, n) VALUES (1, 1);",
    'CREATE TABLE "_prisma_migrations" (id text PRIMARY KEY, migration_name text NOT NULL, finished_at timestamptz, rolled_back_at timestamptz, applied_steps_count integer NOT NULL);',
    `INSERT INTO "_prisma_migrations" (id, migration_name, finished_at, rolled_back_at, applied_steps_count) VALUES ('rolled', '${p1}', '2026-01-01 00:00:00+00', '2026-01-02 00:00:00+00', 1);`,
    "-- PostgreSQL database dump complete",
    "",
  ].join("\n");
  const rolled = pack(appliedDir, appliedName, appliedSql);
  const rolledTrust = trustFile(appliedDir, appliedName, rolled.digest, "synthetic-selector");
  const rolledControl = controls(appliedDir, {
    public_tables: "2",
    public_constraints: "2",
    migration_rows: "1",
    migration_names_sha256: sha256(`${p1}\n`),
    p1_row: "PRESENT",
    p1_applied: "NOT_APPLIED",
    control_rows: "1",
  });
  const rolledResult = procedure(["run", rolled.archive, rolledTrust, rolledControl], {
    ...env,
    STELL22_PBR_SHA256: rolled.digest,
    STELL22_PBR_RUN: `pbr${crypto.randomBytes(8).toString("hex")}`,
  });
  assertResult(rolledResult, "RESTORE_VERIFIED");
  if (field(rolledResult.stdout ?? "", "P1_STATE") !== "NOT_APPLIED")
    fail("rolled back P1 row was treated as applied");

  const doneDir = posixTemp();
  const doneName = "stell22_2026-10-22_03-00-06.sql.gz";
  const doneSql = appliedSql.replace(
    `'rolled', '${p1}', '2026-01-01 00:00:00+00', '2026-01-02 00:00:00+00', 1`,
    `'done', '${p1}', '2026-01-01 00:00:00+00', NULL, 1`,
  );
  const done = pack(doneDir, doneName, doneSql);
  const doneTrust = trustFile(doneDir, doneName, done.digest, "synthetic-selector");
  const doneControl = controls(doneDir, {
    public_tables: "2",
    public_constraints: "2",
    migration_rows: "1",
    migration_names_sha256: sha256(`${p1}\n`),
    p1_row: "PRESENT",
    p1_applied: "APPLIED",
    control_rows: "1",
  });
  const doneResult = procedure(["run", done.archive, doneTrust, doneControl], {
    ...env,
    STELL22_PBR_SHA256: done.digest,
    STELL22_PBR_RUN: `pbr${crypto.randomBytes(8).toString("hex")}`,
  });
  assertResult(doneResult, "RESTORE_VERIFIED");
  if (field(doneResult.stdout ?? "", "P1_ROW") !== "PRESENT") fail("completed P1 row was not reported");
  if (field(doneResult.stdout ?? "", "P1_STATE") !== "APPLIED") fail("completed P1 row was not reported");
  if (/P1 apply|P1_APPLY/i.test(doneResult.stdout ?? "")) fail("restore claimed P1 apply");

  const early = procedure(["run", packed.archive, trust, control], {
    ...env,
    STELL22_PBR_DATABASE: "stell22",
    STELL22_PBR_RUN: `pbr${crypto.randomBytes(8).toString("hex")}`,
  });
  assertResult(early, "REFUSED_DESTINATION");
  const forbidden = procedure(["prepare"], {
    ...env,
    STELL22_PBR_CONTAINER_NAME: "stell22-db-prod",
    STELL22_PBR_RUN: `pbr${crypto.randomBytes(8).toString("hex")}`,
  });
  assertResult(forbidden, "REFUSED_PRODUCTION_CONTAINER");
  const wrongImage = procedure(["prepare"], {
    ...env,
    STELL22_PBR_IMAGE: "postgres:16-alpine",
    STELL22_PBR_RUN: `pbr${crypto.randomBytes(8).toString("hex")}`,
  });
  assertResult(wrongImage, "REFUSED_POSTGRES_IDENTITY");

  const cleanupProbe = procedure(["prepare"], {
    ...env,
    STELL22_PBR_RUN: `pbr${crypto.randomBytes(8).toString("hex")}`,
  });
  assertResult(cleanupProbe, "PREPARED");
  const probeId = field(cleanupProbe.stdout ?? "", "CONTAINER");
  const probeEvidence = field(cleanupProbe.stdout ?? "", "EVIDENCE_FILE");
  const blocked = procedure(["cleanup", probeEvidence], { STELL22_PBR_FAILPOINT: "cleanup-rm" });
  assertResult(blocked, "FAILED_CLEANUP");
  const still = run("docker", ["inspect", "-f", "{{.Id}}", probeId]);
  if (still.status !== 0 || !(still.stdout ?? "").includes(probeId))
    fail("failed cleanup removed the container");

  console.log("[production-backup-restore-ci] restore=verified");
  console.log("[production-backup-restore-ci] p1=separate");
  console.log("[production-backup-restore-ci] repeated=refused");
  console.log("[production-backup-restore-ci] populated=unchanged");
  console.log("[production-backup-restore-ci] sql-failure=rolled-back");
  console.log("[production-backup-restore-ci] partial=preserved");
  console.log("[production-backup-restore-ci] cleanup-failure=kept");
} catch (error) {
  if (!process.exitCode) process.exitCode = 1;
  if (error instanceof Error && !error.message.startsWith("expected") && process.exitCode) {
    console.error(`[production-backup-restore-ci] ${error.message}`);
  }
} finally {
  cleanupAll();
  const containersAfter = ids(["ps", "-aq", "--no-trunc"]);
  const networksAfter = ids(["network", "ls", "-q", "--no-trunc"]);
  const volumesAfter = ids(["volume", "ls", "-q"]);
  const removed = (before, after) => {
    const have = new Set(after);
    return before.filter((id) => !have.has(id));
  };
  const leftover = run("docker", [
    "ps",
    "-aq",
    "--filter",
    "label=stell22.production-backup-restore",
  ]);
  if (
    removed(containersBefore, containersAfter).length ||
    removed(networksBefore, networksAfter).length ||
    removed(volumesBefore, volumesAfter).length ||
    (leftover.stdout ?? "").trim()
  ) {
    console.error(
      "[production-backup-restore-ci] disposable cleanup changed unrelated docker resources",
    );
    process.exitCode = 1;
  } else if (!process.exitCode) {
    console.log("[production-backup-restore-ci] docker-resources=unchanged");
  }
  const marker = sh('cat "$1/marker"', [foreignDir]);
  if ((marker.stdout ?? "") !== "keep\n") {
    console.error("[production-backup-restore-ci] foreign temp directory changed");
    process.exitCode = 1;
  } else if (!process.exitCode) {
    console.log("[production-backup-restore-ci] foreign-temp=unchanged");
  }
  const foreignStill = run("docker", ["inspect", "-f", "{{.Id}}", foreignId]);
  if (foreignStill.status !== 0 || !(foreignStill.stdout ?? "").includes(foreignId)) {
    console.error("[production-backup-restore-ci] foreign container changed");
    process.exitCode = 1;
  } else if (!process.exitCode) {
    console.log("[production-backup-restore-ci] foreign-container=unchanged");
  }
  run("docker", ["rm", foreignId]);
  sh('rm -rf "$1"', [foreignDir]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
  if (process.exitCode) process.exit(process.exitCode);
}
