/**
 * Genuine disposable restore drill.
 * Talks only to the container selected by STELL22_RESTORE_DRILL_RUN.
 * Ignores DATABASE_URL and INTEGRITY_TEST_DATABASE_URL.
 * Does not drop databases and does not call docker compose.
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runId = process.env.STELL22_RESTORE_DRILL_RUN ?? "";
const witnessNotes = ["drill-witness-1", "drill-witness-2"];
const neighborNote = "neighbor-keep";

function fail(message) {
  console.error(`[restore-drill-ci] ОШИБКА: ${message}`);
  process.exit(1);
}

if (!/^[0-9A-Za-z-]{8,}$/.test(runId)) {
  fail("STELL22_RESTORE_DRILL_RUN is missing or invalid");
}

function baseEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.DATABASE_URL;
  delete env.INTEGRITY_TEST_DATABASE_URL;
  env.STELL22_RESTORE_DRILL_RUN = runId;
  return env;
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: options.env ?? baseEnv(),
    input: options.input,
    maxBuffer: 64 * 1024 * 1024,
    stdio: options.stdio,
  });
}

function md5(value) {
  return crypto.createHash("md5").update(value).digest("hex");
}

function parseIdentity(stdout) {
  const info = {};
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    const match = /^(NONCE|CONTAINER|PORT)=([0-9A-Za-z.:]+)$/.exec(line);
    if (!match) fail("unexpected drill output");
    info[match[1]] = match[2];
  }
  if (!info.NONCE || !info.CONTAINER || !info.PORT) fail("incomplete drill identity");
  if (!/^[0-9a-f]{32}$/.test(info.NONCE)) fail("nonce is not a 32-hex marker");
  if (!/^[0-9a-f]{64}$/.test(info.CONTAINER)) fail("container id is not full");
  const port = /^(?:127\.0\.0\.1|0\.0\.0\.0):([0-9]+)$/.exec(info.PORT);
  if (!port) fail("published port is not local");
  return { nonce: info.NONCE, container: info.CONTAINER, hostPort: port[1] };
}

function drill(args, nonce) {
  const result = run("sh", ["scripts/restore-drill.sh", ...args], {
    env: baseEnv(nonce ? { STELL22_RESTORE_DRILL_NONCE: nonce } : {}),
  });
  return result;
}

function requireOk(result, label) {
  if (result.status !== 0) {
    fail(`${label} failed`);
  }
}

function psql(container, database, sql) {
  if (
    database === "stell22" ||
    database === "stell22_integrity" ||
    database === "postgres" ||
    !database.startsWith("stell22_restore_drill_")
  ) {
    fail("refusing database outside the drill allowlist");
  }
  const result = run(
    "docker",
    [
      "exec",
      "-i",
      container,
      "psql",
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
  if (result.status !== 0) fail(`psql failed on ${database}`);
  return (result.stdout ?? "").trim();
}

function assertSameContainer(container, nonce) {
  const again = drill(["identity"], nonce);
  requireOk(again, "identity recheck");
  const parsed = parseIdentity(again.stdout ?? "");
  if (parsed.container !== container || parsed.nonce !== nonce) {
    fail("container identity changed before the next write");
  }
}

const init = drill(["init"]);
requireOk(init, "init");
const identity = parseIdentity(init.stdout ?? "");
if ((init.stdout ?? "").includes("postgresql://") || (init.stderr ?? "").includes("postgresql://")) {
  fail("drill printed a connection URL");
}

assertSameContainer(identity.container, identity.nonce);

const migrateEnv = baseEnv();
migrateEnv.DATABASE_URL = `postgresql://stell22:stell22@127.0.0.1:${identity.hostPort}/stell22_restore_drill_src?schema=public`;
const prismaCli = path.join(root, "node_modules", "prisma", "build", "index.js");
const migrate = run(process.execPath, [prismaCli, "migrate", "deploy"], {
  env: migrateEnv,
  stdio: "inherit",
});
if (migrate.status !== 0) fail("prisma migrate deploy failed on the drill source");

assertSameContainer(identity.container, identity.nonce);
const witnessSql = [
  "CREATE TABLE stell22_drill_witness (id integer PRIMARY KEY, note text NOT NULL);",
  `INSERT INTO stell22_drill_witness (id, note) VALUES (1, '${witnessNotes[0]}'), (2, '${witnessNotes[1]}');`,
].join("\n");
psql(identity.container, "stell22_restore_drill_src", witnessSql);
psql(
  identity.container,
  "stell22_restore_drill_other",
  [
    "CREATE TABLE stell22_drill_neighbor (id integer PRIMARY KEY, marker text NOT NULL);",
    `INSERT INTO stell22_drill_neighbor (id, marker) VALUES (1, '${neighborNote}');`,
  ].join("\n"),
);
psql(
  identity.container,
  "stell22_restore_drill_dirty",
  "CREATE TABLE dirty_keep (id integer PRIMARY KEY); INSERT INTO dirty_keep (id) VALUES (1);",
);

const neighborBefore = psql(
  identity.container,
  "stell22_restore_drill_other",
  "SELECT md5(marker) FROM stell22_drill_neighbor ORDER BY id;",
);
if (neighborBefore !== md5(neighborNote)) fail("neighbor sentinel was not stored");

const made = run("sh", ["-c", "mktemp -d /tmp/stell22-restore-drill.XXXXXX"]);
if (made.status !== 0) fail("mktemp failed");
const work = (made.stdout ?? "").trim();
try {
  const dumped = run("sh", [
    "-c",
    'docker exec "$1" pg_dump -U stell22 -d stell22_restore_drill_src --no-owner --no-privileges --format=p > "$2/dump.sql"',
    "sh",
    identity.container,
    work,
  ]);
  if (dumped.status !== 0) fail("pg_dump failed");
  const packed = run("sh", [
    "-c",
    'gzip -c "$1/dump.sql" > "$1/stell22_restore_drill.sql.gz" && cd "$1" && sha256sum -t stell22_restore_drill.sql.gz > stell22_restore_drill.sql.gz.sha256',
    "sh",
    work,
  ]);
  if (packed.status !== 0) fail("archive packaging failed");
  const archive = `${work}/stell22_restore_drill.sql.gz`;

  assertSameContainer(identity.container, identity.nonce);
  const restored = drill(["restore", archive, "stell22_restore_drill_dst"], identity.nonce);
  requireOk(restored, "restore");
  if ((restored.stdout ?? "").includes(witnessNotes[0]) || (restored.stderr ?? "").includes(witnessNotes[0])) {
    fail("restore printed source data");
  }

  const sourceMigrations = psql(
    identity.container,
    "stell22_restore_drill_src",
    'SELECT count(*) FROM "_prisma_migrations";',
  );
  const destMigrations = psql(
    identity.container,
    "stell22_restore_drill_dst",
    'SELECT count(*) FROM "_prisma_migrations";',
  );
  if (sourceMigrations !== destMigrations || Number(sourceMigrations) < 1) {
    fail("restored migration count does not match the source");
  }
  const sourceTables = psql(
    identity.container,
    "stell22_restore_drill_src",
    "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';",
  );
  const destTables = psql(
    identity.container,
    "stell22_restore_drill_dst",
    "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';",
  );
  if (sourceTables !== destTables) fail("restored table count does not match the source");
  const witness = psql(
    identity.container,
    "stell22_restore_drill_dst",
    "SELECT id::text || ':' || md5(note) FROM stell22_drill_witness ORDER BY id;",
  );
  const expectedWitness = witnessNotes.map((note, index) => `${index + 1}:${md5(note)}`).join("\n");
  if (witness !== expectedWitness) fail("restored witness rows do not match");

  const brokenPacked = run("sh", [
    "-c",
    "cp \"$1/dump.sql\" \"$1/broken.sql\" && printf '\\nSELECT 1/0;\\n' >> \"$1/broken.sql\" && gzip -c \"$1/broken.sql\" > \"$1/broken.sql.gz\" && cd \"$1\" && sha256sum -t broken.sql.gz > broken.sql.gz.sha256",
    "sh",
    work,
  ]);
  if (brokenPacked.status !== 0) fail("rollback fixture packaging failed");
  const brokenArchive = `${work}/broken.sql.gz`;
  const rolled = drill(["restore", brokenArchive, "stell22_restore_drill_fail"], identity.nonce);
  if (rolled.status === 0) fail("injected SQL error was reported as success");
  const witnessAfterRollback = psql(
    identity.container,
    "stell22_restore_drill_fail",
    "SELECT COALESCE(to_regclass('public.stell22_drill_witness')::text, '');",
  );
  const migrationsAfterRollback = psql(
    identity.container,
    "stell22_restore_drill_fail",
    "SELECT COALESCE(to_regclass('public.\"_prisma_migrations\"')::text, '');",
  );
  if (witnessAfterRollback !== "" || migrationsAfterRollback !== "") {
    fail("single-transaction rollback failed");
  }

  const dirty = drill(["restore", archive, "stell22_restore_drill_dirty"], identity.nonce);
  if (dirty.status === 0) fail("prepopulated target was restored");
  const dirtyKept = psql(
    identity.container,
    "stell22_restore_drill_dirty",
    "SELECT count(*) FROM dirty_keep;",
  );
  if (dirtyKept !== "1") fail("prepopulated target was modified");

  const neighborAfter = psql(
    identity.container,
    "stell22_restore_drill_other",
    "SELECT md5(marker) FROM stell22_drill_neighbor ORDER BY id;",
  );
  if (neighborAfter !== neighborBefore) fail("neighbor database changed");

  console.log(`[restore-drill-ci] migrations=${sourceMigrations}`);
  console.log("[restore-drill-ci] witness=match count=2");
  console.log("[restore-drill-ci] neighbor=unchanged");
  console.log("[restore-drill-ci] rollback=empty");
  console.log("[restore-drill-ci] dirty-target=rejected");
  console.log("[restore-drill-ci] single-transaction=enforced");
} finally {
  run("sh", ["-c", 'case "$1" in /tmp/stell22-restore-drill.*) rm -rf "$1" ;; esac', "sh", work]);
}
