import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { removeOwnedTemps } from "../../scripts/production-backup-restore-ci.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = path.join(repoRoot, "scripts", "production-backup-restore.sh");
const RUN = "pbrrun00000001";
const CID = "a".repeat(64);
const NET = "b".repeat(64);
const SECRET = "mock-db-password";
const SENTINEL = "SYNTHETIC_NOTE_DO_NOT_PRINT";
const NAME = "stell22_2026-10-22_03-00-01.sql.gz";
const SELECTOR = "operator-select-01";

const temps: string[] = [];

function runShell(
  command: string,
  args: readonly string[] = [],
  env?: NodeJS.ProcessEnv,
): SpawnSyncReturns<string> {
  return spawnSync("sh", ["-c", command, "sh", ...args], {
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
  });
}

function makePosixTemp(): string {
  const created = runShell("mktemp -d /tmp/stell22-pbr-test.XXXXXX");
  if (created.status !== 0) throw new Error(created.stderr || "mktemp failed");
  const posix = created.stdout.trim();
  if (!posix.startsWith("/tmp/stell22-pbr-test.")) throw new Error(`unexpected temp ${posix}`);
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
  writeFileSync(toWin(posixPath), text.replace(/\r\n/g, "\n"), "utf8");
}

function field(text: string, key: string): string {
  const match = text.match(new RegExp(`^${key}=(.*)$`, "m"));
  return match?.[1] ?? "";
}

function dump(sql = "SELECT 1;\n"): string {
  return [
    "-- PostgreSQL database dump",
    "\\restrict stell22pbrtesttoken",
    sql,
    "\\unrestrict stell22pbrtesttoken",
    "-- PostgreSQL database dump complete",
    "",
  ].join("\n");
}

function packageArchive(sql: string, name = NAME): { archive: string; sha: string; dir: string } {
  const dir = makePosixTemp();
  writeText(`${dir}/plain.sql`, sql);
  const packed = runShell(
    'gzip -c "$1/plain.sql" > "$1/$2" && cd "$1" && sha256sum -t "$2" > "$2.sha256" && awk "NR==1 { print \\$1; exit }" "$2.sha256"',
    [dir, name],
  );
  if (packed.status !== 0) throw new Error(packed.stderr || "pack failed");
  return { dir, archive: `${dir}/${name}`, sha: packed.stdout.trim() };
}

function trust(dir: string, sha: string, name = NAME, selector = SELECTOR): string {
  const file = `${dir}/trust.txt`;
  writeText(
    file,
    [
      "contract=PRODUCTION_BACKUP_V1",
      "origin=OPERATOR_SELECTED_PRODUCTION_BACKUP",
      `name=${name}`,
      `sha256=${sha}`,
      `selector=${selector}`,
      "",
    ].join("\n"),
  );
  return file;
}

const scriptSource = readFileSync(scriptPath, "utf8");
const imageDigest = scriptSource.match(/^IMAGE_DIGEST=(sha256:[0-9a-f]{64})$/m)?.[1] ?? "";
const imageRef = `postgres:17-alpine@${imageDigest}`;
const imageId = "c".repeat(64);

function invoke(
  args: string[],
  env: Record<string, string | undefined> = {},
  mockBin?: string,
): SpawnSyncReturns<string> {
  const command = mockBin
    ? (["-c", 'export PATH="$1:$PATH"; shift; exec "$@"', "sh", mockBin, "sh", scriptPath, ...args] as const)
    : ([scriptPath, ...args] as const);
  return spawnSync("sh", [...command], {
    encoding: "utf8",
    env: {
      ...process.env,
      STELL22_PBR_SHA256: env.STELL22_PBR_SHA256 ?? "",
      STELL22_PBR_SELECTOR: env.STELL22_PBR_SELECTOR ?? SELECTOR,
      ...env,
    },
  });
}

function mockText(log: string): string {
  return runShell('if [ -f "$1" ]; then cat "$1"; fi', [log]).stdout ?? "";
}

function requireMockGrew(log: string, before: string): string {
  const after = mockText(log);
  const added = after.slice(before.length);
  if (!added.trim()) throw new Error("fake docker was not invoked");
  return added;
}

function writeDockerMock(bin: string, logFile: string, root: string, versionSql: string): void {
  writeExec(bin, "docker", [
    `log=${logFile}`,
    `root=${root}`,
    'printf "%s\\n" "$*" >> "$log"',
    "cmd=$1",
    "shift",
    'case "$cmd" in',
    '  ps) if [ -f "$root/engine" ]; then cat "$root/engine"; fi ;;',
    "  image)",
    "    sub=$1; shift",
    '    case "$sub" in',
    `      inspect) printf '%s\\n' 'sha256:${imageId}' ;;`,
    "      *) exit 1 ;;",
    "    esac ;;",
    "  network)",
    "    sub=$1; shift",
    '    case "$sub" in',
    "      create)",
    `        printf '%s\\n' '${NET}' ;;`,
    "      inspect)",
    "        fmt=",
    "        while [ $# -gt 0 ]; do",
    '          case "$1" in',
    "            -f) fmt=$2; shift 2 ;;",
    "            *) shift ;;",
    "          esac",
    "        done",
    '        case "$fmt" in',
    `          '{{.Id}}') printf '%s\\n' '${NET}' ;;`,
    "          '{{index .Labels \"stell22.production-backup-restore\"}}') printf '%s\\n' \"$STELL22_PBR_RUN\" ;;",
    "          '{{len .Containers}}') printf '0\\n' ;;",
    "          *) exit 1 ;;",
    "        esac ;;",
    "      rm) exit 0 ;;",
    "      *) exit 1 ;;",
    "    esac ;;",
    "  run)",
    `    printf '%s\\n' '${CID}' ;;`,
    "  inspect)",
    "    fmt=",
    "    target=",
    "    while [ $# -gt 0 ]; do",
    '      case "$1" in',
    "        -f) fmt=$2; shift 2 ;;",
    "        *) target=$1; shift ;;",
    "      esac",
    "    done",
    '    case "$fmt" in',
    `      '{{.Id}}') printf '%s\\n' '${CID}' ;;`,
    "      '{{.Name}}') tr -d '\\r' < \"$root/name\" ;;",
    `      '{{.Config.Image}}') printf '%s\\n' '${imageRef}' ;;`,
    `      '{{.Image}}') printf '%s\\n' 'sha256:${imageId}' ;;`,
    "      '{{index .Config.Labels \"stell22.production-backup-restore\"}}') printf '%s\\n' \"$STELL22_PBR_RUN\" ;;",
    "      '{{index .Config.Labels \"com.docker.compose.project\"}}') printf '%s\\n' '<no value>' ;;",
    "      '{{.HostConfig.NetworkMode}}') tr -d '\\r' < \"$root/network\" ;;",
    "      '{{.HostConfig.Memory}}') printf '%s\\n' 1073741824 ;;",
    "      '{{.HostConfig.NanoCpus}}') printf '%s\\n' 1000000000 ;;",
    "      '{{.HostConfig.PidsLimit}}') printf '%s\\n' 128 ;;",
    "      '{{range .Mounts}}{{.Type}}|{{.Name}}|{{.Destination}}{{println}}{{end}}') cat \"$root/mounts\" ;;",
    "      '{{json .NetworkSettings.Ports}}') printf '%s\\n' '{}' ;;",
    "      '{{json .HostConfig.PortBindings}}') printf '%s\\n' '{}' ;;",
    "      '{{json .HostConfig.Tmpfs}}') printf '%s\\n' '{\"/var/lib/postgresql/data\":\"rw,size=1073741824\"}' ;;",
    "      '{{range .Config.Env}}{{println .}}{{end}}')",
    `        printf '%s\\n' "POSTGRES_USER=stell22" "POSTGRES_PASSWORD=${SECRET}" "POSTGRES_DB=stell22_pbr_admin" ;;`,
    "      *) exit 1 ;;",
    "    esac ;;",
    "  exec)",
    '    if [ "$1" = "-i" ]; then exit 0; fi',
    "    shift",
    '    text="$*"',
    '    case "$text" in',
    "      *pg_isready*) exit 0 ;;",
    '      *"SELECT 1"*) exit 0 ;;',
    "      *current_database*) printf '%s\\n' stell22_pbr_admin ;;",
    "      *current_user*) printf '%s\\n' stell22 ;;",
    `      *server_version*) ${versionSql} ;;`,
    "      *datname*) printf '%s\\n' postgres; printf '%s\\n' stell22_pbr_admin; printf '%s\\n' template0; printf '%s\\n' template1 ;;",
    "      *) exit 1 ;;",
    "    esac ;;",
    "  rm)",
    '    code=$(tr -d "[:space:]" < "$root/rm")',
    '    exit "$code" ;;',
    "  volume) exit 1 ;;",
    "  *) exit 1 ;;",
    "esac",
  ]);
}

function resultOf(result: SpawnSyncReturns<string>): string {
  return field(`${result.stdout ?? ""}\n${result.stderr ?? ""}`, "RESULT");
}

afterAll(() => {
  for (const dir of temps)
    runShell('case "$1" in /tmp/stell22-pbr-test.*) rm -rf "$1" ;; esac', [dir]);
});

describe("production backup restore verification", () => {
  it("parses as POSIX sh and does not call the production restore entry point", () => {
    const syntax = runShell('sh -n "$1"', [scriptPath]);
    expect(syntax.status).toBe(0);
    const body = runShell(
      'awk \'BEGIN { c = 0 } /^[[:space:]]*#/ { next } { if (index($0, "restore-db.sh") || index($0, "docker compose") || index($0, "system prune") || index($0, "volume prune") || index($0, "network prune")) c++ } END { print c }\' "$1"',
      [scriptPath],
    );
    expect(body.stdout.trim()).toBe("0");
  });

  it("accepts an explicitly selected archive and rejects a sidecar used as trust", () => {
    const packed = packageArchive(dump(`-- ${SENTINEL}\nSELECT 1;\n`));
    const selected = trust(packed.dir, packed.sha);
    const ok = invoke(["verify", packed.archive, selected], { STELL22_PBR_SHA256: packed.sha });
    expect(ok.status).toBe(0);
    expect(resultOf(ok)).toBe("ARCHIVE_OK");
    expect(field(ok.stdout, "SHA256")).toBe(packed.sha);
    expect(`${ok.stdout}${ok.stderr}`).not.toContain(SENTINEL);

    const sidecarTrust = invoke(["verify", packed.archive, `${packed.archive}.sha256`], {
      STELL22_PBR_SHA256: packed.sha,
    });
    expect(sidecarTrust.status).not.toBe(0);
    expect(resultOf(sidecarTrust)).toBe("REFUSED_PROVENANCE");
  });

  it("rejects a missing checksum, a mismatch, corrupt gzip, and an unexpected name", () => {
    const packed = packageArchive(dump());
    const selected = trust(packed.dir, packed.sha);
    runShell('rm -f "$1.sha256"', [packed.archive]);
    const missing = invoke(["verify", packed.archive, selected], {
      STELL22_PBR_SHA256: packed.sha,
    });
    expect(resultOf(missing)).toBe("REFUSED_MISSING_CHECKSUM");

    const mismatch = packageArchive(dump());
    const mismatchTrust = trust(mismatch.dir, mismatch.sha);
    writeText(`${mismatch.archive}.sha256`, `${"ab".repeat(32)}  ${NAME}\n`);
    const badSum = invoke(["verify", mismatch.archive, mismatchTrust], {
      STELL22_PBR_SHA256: mismatch.sha,
    });
    expect(resultOf(badSum)).toBe("REFUSED_CHECKSUM_MISMATCH");

    const corrupt = packageArchive(dump());
    const corruptTrust = trust(corrupt.dir, corrupt.sha);
    const corruptBytes = readFileSync(toWin(corrupt.archive));
    corruptBytes[Math.max(12, corruptBytes.length - 8)] ^= 0xff;
    writeFileSync(toWin(corrupt.archive), corruptBytes);
    const flipped = runShell('cd "$1" && sha256sum -t "$2"', [corrupt.dir, NAME]);
    const flippedSha = flipped.stdout.trim().split(/\s+/)[0] ?? "";
    writeText(`${corrupt.archive}.sha256`, `${flippedSha}  ${NAME}\n`);
    writeText(
      corruptTrust,
      [
        "contract=PRODUCTION_BACKUP_V1",
        "origin=OPERATOR_SELECTED_PRODUCTION_BACKUP",
        `name=${NAME}`,
        `sha256=${flippedSha}`,
        `selector=${SELECTOR}`,
        "",
      ].join("\n"),
    );
    const gzip = invoke(["verify", corrupt.archive, corruptTrust], {
      STELL22_PBR_SHA256: flippedSha,
    });
    expect(resultOf(gzip)).toBe("REFUSED_GZIP");

    const renamed = packageArchive(dump(), "stell22_2026-10-22_03-00-02.sql.gz");
    const wrongTrust = trust(renamed.dir, renamed.sha, NAME);
    const identity = invoke(["verify", renamed.archive, wrongTrust], {
      STELL22_PBR_SHA256: renamed.sha,
    });
    expect(resultOf(identity)).toBe("REFUSED_ARCHIVE_IDENTITY");
  }, 20000);

  it("rejects a meta-command and does not print its payload", () => {
    const packed = packageArchive(dump("\\echo SYNTHETIC_META_VISIBLE\n"));
    const selected = trust(packed.dir, packed.sha);
    const rejected = invoke(["verify", packed.archive, selected], {
      STELL22_PBR_SHA256: packed.sha,
    });
    expect(resultOf(rejected)).toBe("REFUSED_FORMAT");
    expect(`${rejected.stdout}${rejected.stderr}`).not.toContain("SYNTHETIC_META_VISIBLE");
  });

  it("refuses overrides before Docker starts", () => {
    const bin = makePosixTemp();
    const log = `${bin}/docker.log`;
    writeExec(bin, "docker", ['printf "%s\\n" "$*" >> "$STELL22_MOCK_LOG"', "exit 99"]);
    const packed = packageArchive(dump());
    const selected = trust(packed.dir, packed.sha);
    const base = {
      STELL22_MOCK_LOG: log,
      STELL22_PBR_SHA256: packed.sha,
      STELL22_PBR_RUN: RUN,
    };
    const database = invoke(
      ["run", packed.archive, selected, `${packed.dir}/controls`],
      { ...base, STELL22_PBR_DATABASE: "stell22" },
      bin,
    );
    const named = invoke(
      ["run", packed.archive, selected, `${packed.dir}/controls`],
      { ...base, STELL22_PBR_CONTAINER_NAME: "stell22-db-prod" },
      bin,
    );
    const image = invoke(
      ["run", packed.archive, selected, `${packed.dir}/controls`],
      { ...base, STELL22_PBR_IMAGE: "postgres:16-alpine" },
      bin,
    );
    expect(resultOf(database)).toBe("REFUSED_DESTINATION");
    expect(resultOf(named)).toBe("REFUSED_PRODUCTION_CONTAINER");
    expect(resultOf(image)).toBe("REFUSED_POSTGRES_IDENTITY");
    expect(runShell('if [ -f "$1" ]; then cat "$1"; fi', [log]).stdout).toBe("");
  });

  it("classifies a wrong server version, a forbidden container, a named volume, and a failed cleanup", () => {
    const bin = makePosixTemp();
    const root = makePosixTemp();
    const log = `${root}/docker.log`;
    writeText(`${root}/version`, "17.6\n");
    writeText(`${root}/name`, `/stell22-pbr-${RUN}\n`);
    writeText(`${root}/network`, "none\n");
    writeText(`${root}/mounts`, "tmpfs||/var/lib/postgresql/data\n");
    writeText(`${root}/rm`, "0\n");
    writeDockerMock(bin, log, root, "tr -d '\\r' < \"$root/version\"");
    const env = {
      STELL22_PBR_SHA256: "ab".repeat(32),
      STELL22_PBR_RUN: RUN,
      STELL22_PBR_SELECTOR: SELECTOR,
    };
    writeText(`${root}/version`, "16.9\n");
    const versionBefore = mockText(log);
    const version = invoke(["prepare"], env, bin);
    const versionLog = requireMockGrew(log, versionBefore);
    expect(versionLog).toContain(imageDigest);
    expect(resultOf(version)).toBe("REFUSED_POSTGRES_IDENTITY");
    expect(`${version.stdout}${version.stderr}`).not.toContain(SECRET);

    writeText(`${root}/engine`, "stell22-app\n");
    const engineBefore = mockText(log);
    const engine = invoke(["prepare"], env, bin);
    const engineLog = requireMockGrew(log, engineBefore);
    expect(engineLog).toContain("ps -a");
    expect(engineLog).not.toContain(" run ");
    expect(resultOf(engine)).toBe("REFUSED_PRODUCTION_CONTAINER");
    runShell('rm -f "$1/engine"', [root]);

    writeText(`${root}/version`, "17.6\n");
    writeText(`${root}/name`, "/stell22-db-prod\n");
    const forbiddenBefore = mockText(log);
    const forbidden = invoke(["prepare"], env, bin);
    requireMockGrew(log, forbiddenBefore);
    expect(resultOf(forbidden)).toBe("REFUSED_PRODUCTION_CONTAINER");

    writeText(`${root}/name`, `/stell22-pbr-${RUN}\n`);
    writeText(`${root}/mounts`, "volume|db-data|/var/lib/postgresql/data\n");
    const volumeBefore = mockText(log);
    const volume = invoke(["prepare"], env, bin);
    requireMockGrew(log, volumeBefore);
    expect(resultOf(volume)).toBe("REFUSED_PRODUCTION_CONTAINER");

    writeText(`${root}/mounts`, "tmpfs||/var/lib/postgresql/data\n");
    writeText(`${root}/network`, "host\n");
    const hostBefore = mockText(log);
    const host = invoke(["prepare"], env, bin);
    requireMockGrew(log, hostBefore);
    expect(resultOf(host)).toBe("REFUSED_PRODUCTION_CONTAINER");

    writeText(`${root}/network`, "none\n");
    const preparedBefore = mockText(log);
    const prepared = invoke(["prepare"], env, bin);
    requireMockGrew(log, preparedBefore);
    expect(resultOf(prepared)).toBe("PREPARED");
    const evidence = field(prepared.stdout, "EVIDENCE_FILE");
    expect(evidence).toContain("/tmp/stell22-pbr.");
    writeText(`${root}/rm`, "1\n");
    const cleanedBefore = mockText(log);
    const cleaned = invoke(["cleanup", evidence], env, bin);
    requireMockGrew(log, cleanedBefore);
    expect(resultOf(cleaned)).toBe("FAILED_CLEANUP");
    const rmLines = runShell('grep -c "^rm " "$1" || true', [log]);
    expect(rmLines.stdout.trim()).toBe("1");
    const prune = runShell('grep -c "prune" "$1" || true', [log]);
    expect(prune.stdout.trim()).toBe("0");
  }, 60000);

  it("reproduces the Linux mock miss and then rejects PostgreSQL 16.9", () => {
    const mockBin = makePosixTemp();
    const decoyBin = makePosixTemp();
    const root = makePosixTemp();
    const mockLogPath = `${root}/mock.log`;
    const decoyLogPath = `${root}/decoy.log`;
    writeText(`${root}/version`, "16.9\n");
    writeText(`${root}/name`, `/stell22-pbr-${RUN}\n`);
    writeText(`${root}/network`, "none\n");
    writeText(`${root}/mounts`, "tmpfs||/var/lib/postgresql/data\n");
    writeText(`${root}/rm`, "0\n");
    writeDockerMock(mockBin, mockLogPath, root, "tr -d '\\r' < \"$root/version\"");
    writeDockerMock(decoyBin, decoyLogPath, root, "printf '%s\\n' 17.9");
    const env = {
      ...process.env,
      STELL22_PBR_SHA256: "ab".repeat(32),
      STELL22_PBR_SELECTOR: SELECTOR,
      STELL22_PBR_RUN: RUN,
    };
    const found = spawnSync(
      "sh",
      ["-c", 'PATH="$1;/nowhere:$2:$PATH"; export PATH; command -v docker', "sh", mockBin, decoyBin],
      { encoding: "utf8", env },
    );
    expect(found.stdout.trim()).toBe(`${decoyBin}/docker`);
    const broken = spawnSync(
      "sh",
      [
        "-c",
        'PATH="$1;/nowhere:$2:$PATH"; export PATH; shift 2; exec "$@"',
        "sh",
        mockBin,
        decoyBin,
        "sh",
        scriptPath,
        "prepare",
      ],
      { encoding: "utf8", env },
    );
    expect(resultOf(broken)).toBe("PREPARED");
    expect(mockText(mockLogPath)).toBe("");
    expect(mockText(decoyLogPath)).toContain("run -d");
    const fixedBefore = mockText(mockLogPath);
    const decoyBefore = mockText(decoyLogPath);
    const fixed = invoke(["prepare"], env, mockBin);
    expect(requireMockGrew(mockLogPath, fixedBefore)).toContain("exec");
    expect(mockText(decoyLogPath)).toBe(decoyBefore);
    expect(resultOf(fixed)).toBe("REFUSED_POSTGRES_IDENTITY");
    for (const result of [broken, fixed]) {
      const evidence = field(result.stdout ?? "", "EVIDENCE_FILE");
      if (!evidence) continue;
      runShell('dir=$(dirname "$1"); case "$dir" in /tmp/stell22-pbr.*) rm -rf "$dir" ;; esac', [evidence]);
    }
  }, 60000);

  it("leaves a foreign directory with the same temp prefix", () => {
    const owned = runShell("mktemp -d /tmp/stell22-pbr-ci.XXXXXX");
    const foreign = runShell("mktemp -d /tmp/stell22-pbr-ci.XXXXXX");
    expect(owned.status).toBe(0);
    expect(foreign.status).toBe(0);
    const ownedDir = owned.stdout.trim();
    const foreignDir = foreign.stdout.trim();
    temps.push(ownedDir, foreignDir);
    writeText(`${foreignDir}/marker`, "keep\n");
    removeOwnedTemps([ownedDir]);
    expect(mockText(`${foreignDir}/marker`)).toBe("keep\n");
    expect(runShell('if [ -d "$1" ]; then echo present; fi', [ownedDir]).stdout.trim()).toBe("");
    expect(() => removeOwnedTemps(["/tmp/other-prefix"])).toThrow(/untracked/);
  });
});
