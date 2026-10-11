import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RUN = "run12345678";
const NONCE = "0123456789abcdef0123456789abcdef";
const CONTAINER = "a".repeat(64);
const SENTINEL = "STELL22_DRILL_ROW_9f3c";
const SECRET = "drill-secret-not-for-logs";
const DUMP = [
  "-- PostgreSQL database dump",
  `SELECT '${SENTINEL}';`,
  "-- PostgreSQL database dump complete",
  "",
].join("\n");

const temps: string[] = [];

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function runShell(command: string, args: readonly string[] = []): SpawnSyncReturns<string> {
  return spawnSync("sh", ["-c", command, "sh", ...args], { encoding: "utf8" });
}

function makePosixTemp(): string {
  const created = runShell("mktemp -d /tmp/stell22-restore-drill.XXXXXX");
  if (created.status !== 0) throw new Error(created.stderr || "mktemp failed");
  const posix = created.stdout.trim();
  if (!posix.startsWith("/tmp/stell22-restore-drill")) {
    throw new Error(`unexpected temp ${posix}`);
  }
  temps.push(posix);
  return posix;
}

function toWin(posix: string): string {
  if (process.platform !== "win32") return posix;
  const win = spawnSync("cygpath", ["-w", posix], { encoding: "utf8" });
  if (win.status !== 0 || !win.stdout.trim()) throw new Error(win.stderr || "cygpath failed");
  return win.stdout.trim();
}

function writeExec(posixDir: string, name: string, lines: readonly string[]): void {
  writeFileSync(path.join(toWin(posixDir), name), ["#!/bin/sh", ...lines, ""].join("\n"), "utf8");
  const chmod = runShell('chmod 755 "$1"', [`${posixDir}/${name}`]);
  if (chmod.status !== 0) throw new Error(chmod.stderr || "chmod failed");
}

function writeText(posixPath: string, text: string): void {
  writeFileSync(toWin(posixPath), text, "utf8");
}

function readText(posixPath: string): string {
  const read = runShell('cat "$1"', [posixPath]);
  if (read.status !== 0) throw new Error(read.stderr || `cannot read ${posixPath}`);
  return read.stdout;
}

type MockOptions = {
  ids?: string;
  image?: string;
  label?: string;
  compose?: string;
  network?: string;
  name?: string;
  env?: string;
  port?: string;
  databases?: string;
  currentUser?: string;
  marker?: string;
  publicCount?: string;
  forceAdminDb?: string;
  psqlFail?: boolean;
  psqlFailText?: string;
  provenance?: "0" | "1";
};

function setupMock(options: MockOptions = {}): { bin: string; root: string; log: string } {
  const root = makePosixTemp();
  const bin = makePosixTemp();
  const log = `${root}/docker.log`;
  writeText(`${root}/ids`, options.ids ?? `${CONTAINER}\n`);
  writeText(`${root}/image`, `${options.image ?? "postgres:17-alpine"}\n`);
  writeText(`${root}/label`, `${options.label ?? RUN}\n`);
  writeText(`${root}/compose`, `${options.compose ?? "<no value>"}\n`);
  writeText(`${root}/network`, `${options.network ?? "bridge"}\n`);
  writeText(`${root}/name`, `${options.name ?? "/stell22-restore-drill-isolated"}\n`);
  writeText(
    `${root}/env`,
    options.env ??
      `POSTGRES_USER=stell22\nPOSTGRES_PASSWORD=${SECRET}\nPOSTGRES_DB=stell22_restore_drill_admin\n`,
  );
  writeText(`${root}/port`, `${options.port ?? "127.0.0.1:55432"}\n`);
  writeText(
    `${root}/databases`,
    options.databases ??
      "postgres\nstell22_restore_drill_admin\ntemplate0\ntemplate1\n",
  );
  writeText(`${root}/current_user`, `${options.currentUser ?? "stell22"}\n`);
  if (options.marker !== undefined) writeText(`${root}/marker`, options.marker);
  if (options.publicCount !== undefined) {
    writeText(`${root}/public-stell22_restore_drill_dst`, `${options.publicCount}\n`);
  }
  if (options.forceAdminDb !== undefined) writeText(`${root}/force-admin-db`, `${options.forceAdminDb}\n`);
  if (options.psqlFailText !== undefined) writeText(`${root}/psql-fail`, options.psqlFailText);
  else if (options.psqlFail) writeText(`${root}/psql-fail`, "1\n");
  if (options.provenance !== "0") writeText(`${root}/provenance-ok`, "1\n");
  writeExec(bin, "docker", [
    'log=${STELL22_MOCK_LOG:?}',
    'root=${STELL22_MOCK_ROOT:?}',
    'printf "%s\\n" "$*" >> "$log"',
    'cmd=$1',
    "shift",
    'case "$cmd" in',
    "  ps)",
    '    case " $* " in',
    '      *"label=stell22.restore-drill-run=${STELL22_RESTORE_DRILL_RUN}"*) ;;',
    '      *) echo "missing label filter" >&2; exit 98 ;;',
    "    esac",
    '    cat "$root/ids"',
    "    ;;",
    "  inspect)",
    "    fmt=$2",
    "    id=$3",
    '    case "$fmt" in',
    "      '{{.Id}}') printf '%s\\n' \"$id\" ;;",
    '      \'{{.Config.Image}}\') cat "$root/image" ;;',
    '      \'{{index .Config.Labels "stell22.restore-drill-run"}}\') cat "$root/label" ;;',
    '      \'{{index .Config.Labels "com.docker.compose.project"}}\') cat "$root/compose" ;;',
    '      \'{{.HostConfig.NetworkMode}}\') cat "$root/network" ;;',
    '      \'{{.Name}}\') cat "$root/name" ;;',
    '      \'{{range .Config.Env}}{{println .}}{{end}}\') cat "$root/env" ;;',
    '      *) echo "unexpected inspect $fmt" >&2; exit 96 ;;',
    "    esac",
    "    ;;",
    "  port)",
    '    cat "$root/port"',
    "    ;;",
    "  exec)",
    '    db=""',
    '    sql=""',
    "    restore=0",
    '    prev=""',
    '    for arg in "$@"; do',
    '      case "$prev" in',
    "        -d) db=$arg ;;",
    "        -c) sql=$arg ;;",
    "      esac",
    '      if [ "$arg" = "--single-transaction" ]; then restore=1; fi',
    "      prev=$arg",
    "    done",
    '    if [ "$restore" -eq 1 ]; then',
    '      cat > "$root/restore.sql"',
    '      if [ -f "$root/psql-fail" ]; then cat "$root/psql-fail" >&2; exit 1; fi',
    "      exit 0",
    "    fi",
    '    case "$sql" in',
    '      "SELECT current_database()")',
    '        if [ "$db" = "stell22_restore_drill_admin" ] && [ -f "$root/force-admin-db" ]; then',
    '          cat "$root/force-admin-db"',
    "        else",
    "          printf '%s\\n' \"$db\"",
    "        fi",
    "        ;;",
    '      "SELECT current_user") cat "$root/current_user" ;;',
    '      "SELECT datname FROM pg_database ORDER BY 1") cat "$root/databases" ;;',
    `      "SELECT to_regclass('public.stell22_drill_cluster_marker')")`,
    '        if [ -s "$root/marker" ]; then printf "%s\\n" stell22_drill_cluster_marker; fi',
    "        ;;",
    '      "SELECT nonce FROM stell22_drill_cluster_marker") cat "$root/marker" ;;',
    `      "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p')")`,
    '        if [ -f "$root/public-$db" ]; then cat "$root/public-$db"; else printf "%s\\n" 0; fi',
    "        ;;",
    '      "CREATE TABLE stell22_drill_cluster_marker (nonce text PRIMARY KEY)") ;;',
    '      "CREATE TABLE stell22_drill_archive_provenance (nonce text NOT NULL, sha256 text NOT NULL, PRIMARY KEY (nonce, sha256))") ;;',
    `      "SELECT count(*) FROM stell22_drill_archive_provenance WHERE nonce = '"*)`,
    '        if [ -f "$root/provenance-ok" ]; then printf "%s\\n" 1; else printf "%s\\n" 0; fi',
    "        ;;",
      `      "INSERT INTO stell22_drill_cluster_marker (nonce) VALUES ('"*)`,
        "        nonce=${sql#*\\'}",
        "        nonce=${nonce%%\\'*}",
        '        printf "%s\\n" "$nonce" > "$root/marker"',
    "        ;;",
    '      "CREATE DATABASE stell22_restore_drill_src"|"CREATE DATABASE stell22_restore_drill_dst"|"CREATE DATABASE stell22_restore_drill_other"|"CREATE DATABASE stell22_restore_drill_fail"|"CREATE DATABASE stell22_restore_drill_dirty")',
    '        printf "%s\\n" "$sql" >> "$root/created"',
    "        ;;",
    '      *) echo "unexpected sql: $sql" >&2; exit 97 ;;',
    "    esac",
    "    ;;",
    '  *) echo "unexpected docker $cmd" >&2; exit 96 ;;',
    "esac",
  ]);
  return { bin, root, log };
}

function spawnScript(
  script: string,
  args: readonly string[],
  options: { bin?: string; root?: string; log?: string; nonce?: string; databaseUrl?: string; input?: string } = {},
): { status: number; stdout: string; stderr: string; combined: string } {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    PATH: process.env.PATH,
    Path: process.env.Path,
    HOME: process.env.HOME,
    SystemRoot: process.env.SystemRoot,
    SYSTEMROOT: process.env.SYSTEMROOT,
    COMSPEC: process.env.COMSPEC,
    PATHEXT: process.env.PATHEXT,
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
    STELL22_RESTORE_DRILL_RUN: RUN,
    DOCKER_HOST: "unix:///tmp/stell22-restore-drill-no-such.sock",
  };
  if (options.root && options.log) {
    env.STELL22_MOCK_ROOT = options.root;
    env.STELL22_MOCK_LOG = options.log;
  }
  if (options.nonce) env.STELL22_RESTORE_DRILL_NONCE = options.nonce;
  if (options.databaseUrl) env.DATABASE_URL = options.databaseUrl;
  const pathPrefix = options.bin ? `${options.bin}:` : "";
  const result = spawnSync(
    "sh",
    ["-c", 'export PATH="$1:$PATH"; shift; exec "$@"', "sh", pathPrefix, "sh", script, ...args],
    { cwd: repoRoot, encoding: "utf8", env, input: options.input },
  );
  if (result.error) throw result.error;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return { status: result.status ?? 1, stdout, stderr, combined: `${stdout}\n${stderr}` };
}

function writeArchive(sql: string): string {
  const dir = makePosixTemp();
  writeText(`${dir}/plain.sql`, sql);
  const packed = runShell(
    'gzip -c "$1/plain.sql" > "$1/stell22_restore_drill.sql.gz" && cd "$1" && sha256sum -t stell22_restore_drill.sql.gz > stell22_restore_drill.sql.gz.sha256',
    [dir],
  );
  if (packed.status !== 0) throw new Error(packed.stderr || "gzip failed");
  return `${dir}/stell22_restore_drill.sql.gz`;
}

function restore(archive: string, target: string, mock: MockOptions = {}, nonce = NONCE) {
  const state = setupMock({ marker: `${nonce}\n`, ...mock });
  const result = spawnScript("scripts/restore-drill.sh", ["restore", archive, target], {
    ...state,
    nonce,
  });
  return { ...result, ...state };
}

function noRestoreSql(root: string): void {
  expect(runShell('test -e "$1/restore.sql"', [root]).status).not.toBe(0);
}

function noForbiddenTarget(log: string): void {
  expect(log).not.toMatch(/-d stell22(\s|$)/);
  expect(log).not.toMatch(/-d stell22_integrity(\s|$)/);
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir?.startsWith("/tmp/stell22-restore-drill")) runShell('rm -rf "$1"', [dir]);
  }
});

afterAll(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir?.startsWith("/tmp/stell22-restore-drill")) runShell('rm -rf "$1"', [dir]);
  }
});

describe("restore-db.sh disabled entry point", { timeout: 30_000 }, () => {
  it("always exits 1 and does not call docker, psql, or gunzip", () => {
    const bin = makePosixTemp();
    const log = `${makePosixTemp()}/called.log`;
    for (const name of ["docker", "psql", "gunzip", "gzip"]) {
      writeExec(bin, name, ['printf "%s\\n" "$0 $*" >> "$STELL22_CALL_LOG"', "exit 99"]);
    }
    const envBase: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      PATH: process.env.PATH,
      Path: process.env.Path,
      HOME: process.env.HOME,
      SystemRoot: process.env.SystemRoot,
      SYSTEMROOT: process.env.SYSTEMROOT,
      COMSPEC: process.env.COMSPEC,
      PATHEXT: process.env.PATHEXT,
      STELL22_CALL_LOG: log,
      DATABASE_URL: "postgresql://stell22:stell22@127.0.0.1:5434/stell22",
    };
    for (const args of [[], ["backups/stell22_2026-01-02_03-04-05.sql.gz"]] as const) {
      const result = spawnSync(
        "sh",
        ["-c", 'export PATH="$1:$PATH"; shift; exec "$@"', "sh", `${bin}:`, "sh", "scripts/restore-db.sh", ...args],
        { cwd: repoRoot, encoding: "utf8", env: envBase, input: "y\n" },
      );
      expect(result.status).toBe(1);
      expect(`${result.stdout ?? ""}\n${result.stderr ?? ""}`).toContain("ОТКЛЮЧЕНО");
      expect(`${result.stdout ?? ""}\n${result.stderr ?? ""}`).toContain("не разрешён");
    }
    expect(runShell('test -e "$1"', [log]).status).not.toBe(0);
  });
});

describe("restore-drill.sh offline safety", { timeout: 60_000 }, () => {
  it("initializes only drill databases and does not drop anything", () => {
    const state = setupMock();
    const result = spawnScript("scripts/restore-drill.sh", ["init"], state);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`CONTAINER=${CONTAINER}`);
    expect(result.stdout).toMatch(/NONCE=[0-9a-f]{32}/);
    expect(result.stdout).toContain("PORT=127.0.0.1:55432");
    const created = readText(`${state.root}/created`);
    for (const name of ["src", "dst", "other", "fail", "dirty"]) {
      expect(created).toContain(`CREATE DATABASE stell22_restore_drill_${name}`);
    }
    expect(readText(state.log)).not.toContain("DROP");
    expect(result.combined).not.toContain(SECRET);
    noForbiddenTarget(readText(state.log));
  });

  it("restores through one transaction without printing the dump", () => {
    const archive = writeArchive(DUMP);
    const result = restore(archive, "stell22_restore_drill_dst");
    expect(result.status).toBe(0);
    expect(result.combined).toContain("RESTORE OK");
    expect(result.combined).not.toContain(SENTINEL);
    expect(result.combined).not.toContain(SECRET);
    expect(readText(result.log)).toContain("--single-transaction");
    expect(readText(result.log)).toContain("ON_ERROR_STOP=1");
    expect(readText(`${result.root}/restore.sql`)).toContain(SENTINEL);
    noForbiddenTarget(readText(result.log));
    expect(readText(result.log).split("\n").some((line) => line.startsWith("compose "))).toBe(false);
  });

  it("rejects a missing archive, a missing checksum, and a malformed sidecar", () => {
    const missing = restore("/tmp/stell22-restore-drill-absent.sql.gz", "stell22_restore_drill_dst");
    expect(missing.status).not.toBe(0);
    noRestoreSql(missing.root);

    const archive = writeArchive(DUMP);
    runShell('rm -f "$1.sha256"', [archive]);
    const noSum = restore(archive, "stell22_restore_drill_dst");
    expect(noSum.status).not.toBe(0);
    noRestoreSql(noSum.root);

    const bad = writeArchive(DUMP);
    writeText(`${bad}.sha256`, `zzzz ${"not-hex"}\n`);
    const malformed = restore(bad, "stell22_restore_drill_dst");
    expect(malformed.status).not.toBe(0);
    noRestoreSql(malformed.root);

    const foreign = writeArchive(DUMP);
    writeText(`${foreign}.sha256`, `${"ab".repeat(32)}  other.sql.gz\n`);
    const foreignResult = restore(foreign, "stell22_restore_drill_dst");
    expect(foreignResult.status).not.toBe(0);
    noRestoreSql(foreignResult.root);

    const extra = writeArchive(DUMP);
    const current = readText(`${extra}.sha256`);
    writeText(`${extra}.sha256`, `${current}extra\n`);
    const extraResult = restore(extra, "stell22_restore_drill_dst");
    expect(extraResult.status).not.toBe(0);
    noRestoreSql(extraResult.root);
  });

  it("rejects a checksum mismatch and a symlink", () => {
    const archive = writeArchive(DUMP);
    const line = readText(`${archive}.sha256`);
    writeText(`${archive}.sha256`, `${"0".repeat(64)}${line.slice(64)}`);
    const mismatch = restore(archive, "stell22_restore_drill_dst");
    expect(mismatch.status).not.toBe(0);
    expect(mismatch.combined).not.toContain(SENTINEL);
    noRestoreSql(mismatch.root);

    const real = writeArchive(DUMP);
    const linkDir = makePosixTemp();
    const link = `${linkDir}/link.sql.gz`;
    const linked = runShell('ln -s "$1" "$2"', [real, link]);
    const isLink = runShell('test -L "$1"', [link]);
    if (linked.status !== 0 || isLink.status !== 0) {
      expect(process.platform).toBe("win32");
    } else {
      const viaLink = restore(link, "stell22_restore_drill_dst");
      expect(viaLink.status).not.toBe(0);
      noRestoreSql(viaLink.root);
    }
  });

  it("rejects gzip and gunzip failures before psql", () => {
    const archive = writeArchive(DUMP);
    const gzipBin = makePosixTemp();
    const realGzip = runShell("command -v gzip");
    expect(realGzip.status).toBe(0);
    writeExec(gzipBin, "gzip", [
      'for arg in "$@"; do',
      '  if [ "$arg" = "-t" ]; then echo "gzip -t forced failure" >&2; exit 1; fi',
      "done",
      `exec ${shellQuote(realGzip.stdout.trim())} "$@"`,
    ]);
    const gzipState = setupMock({ marker: `${NONCE}\n` });
    const gzipFailed = spawnScript("scripts/restore-drill.sh", ["restore", archive, "stell22_restore_drill_dst"], {
      bin: `${gzipBin}:${gzipState.bin}`,
      root: gzipState.root,
      log: gzipState.log,
      nonce: NONCE,
    });
    expect(gzipFailed.status).not.toBe(0);
    noRestoreSql(gzipState.root);

    const gunzipBin = makePosixTemp();
    writeExec(gunzipBin, "gunzip", ['echo "partial" >&1', "exit 1"]);
    const gunzipState = setupMock({ marker: `${NONCE}\n` });
    const gunzipFailed = spawnScript("scripts/restore-drill.sh", ["restore", archive, "stell22_restore_drill_dst"], {
      bin: `${gunzipBin}:${gunzipState.bin}`,
      root: gunzipState.root,
      log: gunzipState.log,
      nonce: NONCE,
    });
    expect(gunzipFailed.status).not.toBe(0);
    noRestoreSql(gunzipState.root);
  });

  it("rejects truncated SQL, database switching, and CREATE DATABASE", () => {
    const truncated = restore(
      writeArchive("-- PostgreSQL database dump\nSELECT 1;\n"),
      "stell22_restore_drill_dst",
    );
    expect(truncated.status).not.toBe(0);
    noRestoreSql(truncated.root);

    const switched = restore(
      writeArchive(`-- PostgreSQL database dump\n\\connect stell22\n-- PostgreSQL database dump complete\n`),
      "stell22_restore_drill_dst",
    );
    expect(switched.status).not.toBe(0);
    noRestoreSql(switched.root);

    const created = restore(
      writeArchive("-- PostgreSQL database dump\nCREATE DATABASE stell22\n-- PostgreSQL database dump complete\n"),
      "stell22_restore_drill_dst",
    );
    expect(created.status).not.toBe(0);
    noRestoreSql(created.root);
  });

  it("rejects indented, inline, and mid-statement database switching", () => {
    const bodies = [
      "   \\connect stell22\n",
      "SELECT 1; \\connect stell22\n",
      "SELECT\n\\connect stell22\n",
      "   \\c stell22\n",
    ];
    for (const body of bodies) {
      const result = restore(writeArchive(`${DUMP}${body}`), "stell22_restore_drill_dst");
      expect(result.status).not.toBe(0);
      expect(result.combined).not.toContain("RESTORE OK");
      noRestoreSql(result.root);
    }
  });

  it("rejects include, shell, gexec, and copy meta-commands", () => {
    for (const body of ["   \\! echo hi\n", "   \\include /tmp/x\n", "   \\ir /tmp/x\n", "   \\i /tmp/x\n", "\\gexec\n", "\\copy t TO STDOUT\n"]) {
      const result = restore(writeArchive(`${DUMP}${body}`), "stell22_restore_drill_dst");
      expect(result.status).not.toBe(0);
      noRestoreSql(result.root);
    }
  });

  it("preserves COPY data, quoted text, and restrict commands", () => {
    const result = restore(
      writeArchive(
        [
          "-- PostgreSQL database dump",
          "COPY public.sample (note) FROM stdin;",
          "\\connect stell22",
          "\\.",
          "SELECT '\\connect stell22';",
          "\\restrict abcdef0123456789",
          "SELECT 1;",
          "\\unrestrict abcdef0123456789",
          "-- PostgreSQL database dump complete",
          "",
        ].join("\n"),
      ),
      "stell22_restore_drill_dst",
    );
    expect(result.status).toBe(0);
    expect(readText(`${result.root}/restore.sql`)).toContain("\\connect stell22");
  });

  it("rejects a 0.0.0.0 binding and an ambiguous port list", () => {
    const archive = writeArchive(DUMP);
    for (const port of ["0.0.0.0:55432", "127.0.0.1:55432\n127.0.0.1:55433"]) {
      const result = restore(archive, "stell22_restore_drill_dst", { port: `${port}\n` });
      expect(result.status).not.toBe(0);
      noRestoreSql(result.root);
    }
    const accepted = restore(archive, "stell22_restore_drill_dst", { port: "127.0.0.1:55432\n" });
    expect(accepted.status).toBe(0);
  });

  it("does not leak psql stderr when restore fails", () => {
    const archive = writeArchive(DUMP);
    const failed = restore(archive, "stell22_restore_drill_dst", {
      psqlFailText: `ERROR: ${SENTINEL} password=${SECRET}\n`,
    });
    expect(failed.status).not.toBe(0);
    expect(failed.combined).not.toContain("RESTORE OK");
    expect(failed.combined).not.toContain(SENTINEL);
    expect(failed.combined).not.toContain(SECRET);
  });

  it("rejects an archive this run did not register", () => {
    const result = restore(writeArchive(DUMP), "stell22_restore_drill_dst", { provenance: "0" });
    expect(result.status).not.toBe(0);
    expect(result.combined).not.toContain("RESTORE OK");
    noRestoreSql(result.root);
  });

  it("rejects stell22, stell22_integrity, and any other target name", () => {
    const archive = writeArchive(DUMP);
    for (const target of ["stell22", "stell22_integrity", "postgres", "stell22_restore_drill_src"]) {
      const result = restore(archive, target);
      expect(result.status).not.toBe(0);
      noRestoreSql(result.root);
      noForbiddenTarget(readText(result.log));
    }
  });

  it("rejects the wrong container, image, network, compose project, and name", () => {
    const archive = writeArchive(DUMP);
    const cases: MockOptions[] = [
      { ids: "" },
      { ids: `${CONTAINER}\n${"b".repeat(64)}\n` },
      { image: "postgres:16" },
      { label: "otherrun999" },
      { network: "host" },
      { compose: "stell22" },
      { name: "/stell22-db-prod" },
      { env: `POSTGRES_USER=stell22\nPOSTGRES_PASSWORD=${SECRET}\nPOSTGRES_DB=stell22\n` },
      { databases: "postgres\nstell22\nstell22_restore_drill_admin\n" },
      { databases: "postgres\nstell22_integrity\nstell22_restore_drill_admin\n" },
      { currentUser: "postgres" },
      { forceAdminDb: "stell22" },
      { port: "10.1.2.3:5432" },
    ];
    for (const mock of cases) {
      const result = restore(archive, "stell22_restore_drill_dst", mock);
      expect(result.status).not.toBe(0);
      noRestoreSql(result.root);
      expect(result.combined).not.toContain(SECRET);
    }
  });

  it("rejects a mismatched cluster marker and a prepopulated target", () => {
    const archive = writeArchive(DUMP);
    const marker = restore(archive, "stell22_restore_drill_dst", {
      marker: `${"f".repeat(32)}\n`,
    });
    expect(marker.status).not.toBe(0);
    noRestoreSql(marker.root);

    const dirty = restore(archive, "stell22_restore_drill_dst", { publicCount: "1" });
    expect(dirty.status).not.toBe(0);
    expect(dirty.combined).not.toContain("RESTORE OK");
    noRestoreSql(dirty.root);
  });

  it("does not report success when psql fails and ignores an inherited production URL", () => {
    const archive = writeArchive(DUMP);
    const failed = restore(archive, "stell22_restore_drill_dst", { psqlFail: true });
    expect(failed.status).not.toBe(0);
    expect(failed.combined).not.toContain("RESTORE OK");

    const state = setupMock({ marker: `${NONCE}\n` });
    const inherited = spawnScript("scripts/restore-drill.sh", ["restore", archive, "stell22_restore_drill_dst"], {
      ...state,
      nonce: NONCE,
      databaseUrl: "postgresql://stell22:secret@203.0.113.10:5432/stell22",
    });
    expect(inherited.status).toBe(0);
    noForbiddenTarget(readText(state.log));
    expect(inherited.combined).not.toContain("203.0.113.10");
    expect(inherited.combined).not.toContain("postgresql://");
  });
});
