import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = path.join(repoRoot, "scripts", "production-backup-same-host.sh");
const productionSha = "37c3bed02a9a89c0ddf88fe99a516f8f347b323dac91c93702fda20bdf6360e4";
const dockerEnabled = process.env.STELL22_SAME_HOST_DOCKER === "1";
const runIds: string[] = [];

function runShell(
  command: string,
  args: readonly string[] = [],
  env?: NodeJS.ProcessEnv,
): SpawnSyncReturns<string> {
  return spawnSync("sh", ["-c", command, "sh", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
    timeout: 180_000,
  });
}

function field(text: string, key: string): string {
  const match = text.match(new RegExp(`^${key}=(.*)$`, "m"));
  return match?.[1] ?? "";
}

function invoke(
  args: readonly string[],
  env?: Record<string, string>,
): SpawnSyncReturns<string> {
  return spawnSync("sh", [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
    timeout: 180_000,
  });
}

function makePosixTemp(): string {
  const created = runShell("mktemp -d /tmp/stell22-samehost-test.XXXXXX");
  if (created.status !== 0) throw new Error(created.stderr || "mktemp failed");
  const posix = created.stdout.trim();
  if (!posix.startsWith("/tmp/stell22-samehost-test.")) {
    throw new Error(`unexpected temp ${posix}`);
  }
  return posix;
}

function toWin(posix: string): string {
  if (process.platform !== "win32") return posix;
  const win = spawnSync("cygpath", ["-w", posix], { encoding: "utf8" });
  if (win.status !== 0 || !win.stdout.trim()) throw new Error(win.stderr || "cygpath failed");
  return win.stdout.trim();
}

function writeText(posixPath: string, text: string): void {
  writeFileSync(toWin(posixPath), text.replace(/\r\n/g, "\n"), "utf8");
}

function packageArchive(name: string): { archive: string; sha: string } {
  const dir = makePosixTemp();
  const sql = [
    "-- PostgreSQL database dump",
    "\\restrict syntheticwitness",
    "CREATE TABLE \"_prisma_migrations\" (",
    "  id text PRIMARY KEY,",
    "  checksum text NOT NULL,",
    "  finished_at timestamptz,",
    "  migration_name text NOT NULL,",
    "  logs text,",
    "  rolled_back_at timestamptz,",
    "  started_at timestamptz NOT NULL DEFAULT now(),",
    "  applied_steps_count integer NOT NULL DEFAULT 0",
    ");",
    "CREATE TABLE synthetic_witness (",
    "  id integer PRIMARY KEY,",
    "  qty integer NOT NULL,",
    "  CONSTRAINT synthetic_witness_qty_check CHECK ((qty * (3 / 2)) >= 0)",
    ");",
    "INSERT INTO \"_prisma_migrations\" (id, checksum, migration_name, started_at, applied_steps_count)",
    "VALUES ('synthetic', 'abc', '20260101000000_synthetic', now(), 0);",
    "INSERT INTO synthetic_witness (id, qty) VALUES (1, 2);",
    "\\unrestrict syntheticwitness",
    "-- PostgreSQL database dump complete",
    "",
  ].join("\n");
  writeText(`${dir}/plain.sql`, sql);
  const packed = runShell(
    'gzip -c "$1/plain.sql" > "$1/$2" && cd "$1" && sha256sum -t "$2" > "$2.sha256" && awk "NR==1 { print \\$1; exit }" "$2.sha256"',
    [dir, name],
  );
  if (packed.status !== 0) throw new Error(packed.stderr || "pack failed");
  return { archive: `${dir}/${name}`, sha: packed.stdout.trim() };
}

function containerGone(run: string): boolean {
  const listed = runShell('docker ps -aq --filter "name=stell22-samehost-$1"', [run]);
  return listed.status === 0 && listed.stdout.trim() === "";
}

describe("same-host scenario locks", () => {
  it("keeps the accepted restore entry points unchanged", () => {
    const diff = runShell("git diff --exit-code -- scripts/restore-db.sh scripts/production-backup-restore.sh");
    expect(diff.status).toBe(0);
    const text = runShell('cat "$1"', [scriptPath]);
    expect(text.stdout).toContain("--network none");
    expect(text.stdout).toContain(productionSha);
    expect(text.stdout).toContain("RESULT=STOP_IMAGE");
    expect(text.stdout).not.toContain("docker pull");
    expect(text.stdout).not.toContain("sh \"$script_dir/restore-db.sh\"");
  });

  it("refuses a locked execute and a synthetic archive with the production digest", () => {
    const locked = invoke(["execute"]);
    expect(locked.status).not.toBe(0);
    expect(locked.stdout).toContain("RESULT=STOP_LOCKED");

    const dir = makePosixTemp();
    writeText(`${dir}/synthetic-lock.sql.gz`, "not-a-real-archive");
    const wrong = invoke(["synthetic", `${dir}/synthetic-lock.sql.gz`], {
      STELL22_SAME_HOST_SHA256: productionSha,
      STELL22_SAME_HOST_RUN: "samehostlock01",
    });
    expect(wrong.status).not.toBe(0);
    expect(wrong.stdout).toContain("RESULT=REFUSED_ARCHIVE_IDENTITY");
    expect(wrong.stdout).not.toContain("RESULT=RESTORE_VERIFIED");
  });
});

describe.skipIf(!dockerEnabled)("same-host synthetic docker proof", () => {
  afterAll(() => {
    for (const run of runIds) {
      runShell('ids=$(docker ps -aq --filter "name=stell22-samehost-$1"); if [ -n "$ids" ]; then docker rm -f $ids >/dev/null; fi', [
        run,
      ]);
    }
  });

  it("restores a synthetic archive under the same-host limits and removes only that container", () => {
    const daemon = runShell("docker info --format '{{.ID}}'");
    expect(daemon.stdout.trim()).not.toBe("95c85a4b-309b-442d-bd15-2bae0a99f4cd");
    const packed = packageArchive("synthetic-same-host.sql.gz");
    const run = "samehostsyn0001";
    runIds.push(run);
    const measured = invoke(["measure", packed.archive], {
      STELL22_SAME_HOST_SHA256: packed.sha,
      STELL22_SAME_HOST_RUN: run,
    });
    expect(measured.status, `${measured.stdout}\n${measured.stderr}`).toBe(0);
    expect(measured.stdout).toContain("NETWORK=none");
    expect(measured.stdout).toContain("PORTS=none");
    expect(measured.stdout).toContain("MEMORY=805306368");
    expect(measured.stdout).toContain("NANO_CPUS=500000000");
    expect(measured.stdout).toContain("PIDS=128");
    expect(measured.stdout).toContain("TMPFS=268435456");
    expect(measured.stdout).toContain("RESULT=MEASURED");
    expect(measured.stdout).toContain("RESULT=CLEANED");
    expect(containerGone(run)).toBe(true);

    const controls = makePosixTemp();
    const keys = [
      "public_tables",
      "public_constraints",
      "migration_rows",
      "migration_names_sha256",
      "p1_row",
      "p1_applied",
      "column_fingerprint",
      "constraint_fingerprint",
    ];
    const lines = keys.map((key) => {
      const value = field(measured.stdout, key);
      expect(value, key).not.toBe("");
      return `${key}=${value}`;
    });
    expect(field(measured.stdout, "p1_row")).toBe("ABSENT");
    expect(field(measured.stdout, "p1_applied")).toBe("NOT_APPLIED");
    writeText(`${controls}/controls`, `${lines.join("\n")}\n`);

    const verified = invoke(["synthetic", packed.archive, `${controls}/controls`], {
      STELL22_SAME_HOST_SHA256: packed.sha,
      STELL22_SAME_HOST_RUN: run,
    });
    expect(verified.status, `${verified.stdout}\n${verified.stderr}`).toBe(0);
    expect(verified.stdout).toContain("RESULT=RESTORE_VERIFIED");
    expect(verified.stdout).toContain("P1_APPLY=NOT_AUTHORIZED");
    expect(verified.stdout).toContain("RESULT=CLEANED");
    expect(containerGone(run)).toBe(true);

    const mismatch = lines.map((line) =>
      line.startsWith("public_tables=") ? "public_tables=0" : line,
    );
    writeText(`${controls}/mismatch`, `${mismatch.join("\n")}\n`);
    const rejected = invoke(["synthetic", packed.archive, `${controls}/mismatch`], {
      STELL22_SAME_HOST_SHA256: packed.sha,
      STELL22_SAME_HOST_RUN: run,
    });
    expect(rejected.status).not.toBe(0);
    expect(rejected.stdout).toContain("RESULT=INSPECT_MISMATCH");
    expect(rejected.stdout).not.toContain("RESULT=RESTORE_VERIFIED");
    expect(rejected.stdout).toContain("RESULT=CLEANED");
    expect(containerGone(run)).toBe(true);
  }, 180_000);

  it("stops when the health probe fails and does not leave the container", () => {
    const packed = packageArchive("synthetic-health.sql.gz");
    const run = "samehostsyn0002";
    runIds.push(run);
    const counter = makePosixTemp();
    writeText(`${counter}/hits`, "0\n");
    const stopped = invoke(["synthetic", packed.archive, "/tmp/unused-controls"], {
      STELL22_SAME_HOST_SHA256: packed.sha,
      STELL22_SAME_HOST_RUN: run,
      STELL22_SAME_HOST_HEALTH_CMD: `hits=$(cat "${counter}/hits"); hits=$((hits + 1)); printf '%s\n' "$hits" > "${counter}/hits"; [ "$hits" -lt 2 ]`,
    });
    const hits = Number(runShell('cat "$1/hits"', [counter]).stdout.trim());
    expect(stopped.status, `${stopped.stdout}\n${stopped.stderr}`).not.toBe(0);
    expect(stopped.stdout).toContain("RESULT=STOP_HEALTH");
    expect(stopped.stdout).toContain("RESULT=CLEANED");
    expect(stopped.stdout).not.toContain("RESULT=RESTORE_VERIFIED");
    expect(containerGone(run)).toBe(true);
    expect(hits).toBeGreaterThan(1);
  }, 180_000);

  it("stops before create when available memory is below the reserve", () => {
    const packed = packageArchive("synthetic-memory.sql.gz");
    const run = "samehostsyn0003";
    runIds.push(run);
    const stopped = invoke(["measure", packed.archive], {
      STELL22_SAME_HOST_SHA256: packed.sha,
      STELL22_SAME_HOST_RUN: run,
      STELL22_SAME_HOST_MEM_AVAILABLE_KB: "100000",
    });
    expect(stopped.status).not.toBe(0);
    expect(stopped.stdout).toContain("RESULT=STOP_RESOURCES");
    expect(stopped.stdout).not.toContain("CONTAINER=");
    expect(containerGone(run)).toBe(true);
  }, 60_000);

  it("refuses execute on a workstation that is not the production engine", () => {
    const run = "samehostsyn0004";
    runIds.push(run);
    const stopped = invoke(["execute", "/tmp/stell22_2026-10-23_03-00-01.sql.gz"], {
      STELL22_SAME_HOST_EXECUTE: "1",
      STELL22_SAME_HOST_SHA256: productionSha,
      STELL22_SAME_HOST_RUN: run,
    });
    expect(stopped.status).not.toBe(0);
    expect(stopped.stdout).toContain("RESULT=STOP_CONTEXT");
    expect(containerGone(run)).toBe(true);
  }, 60_000);
});
