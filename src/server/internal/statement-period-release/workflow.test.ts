import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATION_NAME, MIGRATION_SHA256 } from "./decide.mjs";

const WORKFLOW = ".github/workflows/release-statement-period.yml";
const directories: string[] = [];
const approved = "a".repeat(40);

function unindent(block: string) {
  const lines = block.replace(/\r\n/g, "\n").replace(/^\n/, "").replace(/\s+$/, "").split("\n");
  const widths = lines.filter((line) => line.trim().length > 0).map((line) => line.match(/^ */)?.[0].length ?? 0);
  const trim = Math.min(...widths);
  return `${lines.map((line) => line.slice(trim)).join("\n")}\n`;
}

function between(text: string, start: string, end: string) {
  const from = text.indexOf(start);
  if (from < 0) throw new Error(start);
  const body = text.slice(from + start.length);
  const until = end.length === 0 ? body.length : body.indexOf(end);
  if (until < 0) throw new Error(end);
  return body.slice(0, until);
}

function unixPath(file: string) {
  return file.replace(/\\/g, "/");
}

function runShell(body: string, env: Record<string, string>, pathDir: string) {
  const file = path.join(pathDir, "gate.sh");
  fs.writeFileSync(file, body.replace(/\r\n/g, "\n"), { mode: 0o755 });
  const unix = unixPath(pathDir);
  const child = spawnSync("sh", [unixPath(file)], {
    cwd: unix,
    env: { ...process.env, ...env, PATH: `${unix}:${process.env.PATH ?? ""}` },
    encoding: "utf8",
  });
  return { status: child.status, out: `${child.stdout}${child.stderr}` };
}

function writeExecutable(file: string, body: string) {
  fs.writeFileSync(file, body.replace(/\r\n/g, "\n"), { mode: 0o755 });
}

describe("statement release owner dispatch", () => {
  afterEach(() => {
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  it("is a manual production dispatch and keeps release checks in the operator", () => {
    const workflow = fs.readFileSync(WORKFLOW, "utf8");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toMatch(/\n\s*push:/);
    expect(workflow).not.toMatch(/\n\s*schedule:/);
    expect(workflow).not.toContain("workflow_run:");
    expect(workflow).toContain("OWNER_AUTHORIZES_STATEMENT_PERIOD_47_48");
    expect(workflow).toContain("group: production-deploy");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain(`prisma/migrations/${MIGRATION_NAME}/migration.sql`);
    expect(workflow).toContain(MIGRATION_SHA256);
    expect(workflow).toContain('name == "CI"');
    expect(workflow).not.toContain("prisma migrate");
    expect(workflow).not.toContain("_prisma_migrations");
    expect(workflow).not.toContain("retry:");
    const releaseAt = workflow.indexOf("  release:");
    const sshAt = workflow.indexOf("appleboy/ssh-action@v1.2.4");
    expect(workflow.slice(releaseAt, sshAt)).toContain("needs: [owner-gate, approve-sha]");
    expect(workflow.slice(0, releaseAt)).not.toContain("appleboy/ssh-action");
    expect(sshAt).toBeGreaterThan(releaseAt);
    const remote = between(workflow, "script: |", "");
    expect(remote.indexOf("release-checkout.sh")).toBeLessThan(remote.indexOf("sh scripts/statement-period-release.sh"));
    expect(remote).toContain('STELL22_STATEMENT_RELEASE_SHA="$EXPECTED_SHA"');
    expect(workflow).toContain("EXPECTED_SHA: ${{ inputs.sha }}");
  });

  it("stops before SSH when the owner phrase or SHA is missing", () => {
    const workflow = fs.readFileSync(WORKFLOW, "utf8");
    const owner = unindent(between(workflow, "run: |", "  approve-sha:"));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "statement-dispatch-"));
    directories.push(root);
    const sshLog = path.join(root, "ssh.log");
    writeExecutable(path.join(root, "ssh"), "#!/bin/sh\nprintf '%s\\n' ssh >> \"$STELL22_DISPATCH_SSH\"\n");

    const empty = runShell(owner, { AUTHORIZATION: "", SHA: approved, STELL22_DISPATCH_SSH: unixPath(sshLog) }, root);
    expect(empty.status).not.toBe(0);
    expect(empty.out).toContain("RESULT=STOP_OWNER_GATE");
    expect(fs.existsSync(sshLog)).toBe(false);

    const other = runShell(owner, {
      AUTHORIZATION: "OWNER_AUTHORIZES_ROLE_SPLIT_RELEASE",
      SHA: approved,
      STELL22_DISPATCH_SSH: unixPath(sshLog),
    }, root);
    expect(other.status).not.toBe(0);
    expect(other.out).toContain("RESULT=STOP_OWNER_GATE");

    const badSha = runShell(owner, {
      AUTHORIZATION: "OWNER_AUTHORIZES_STATEMENT_PERIOD_47_48",
      SHA: "abc",
      STELL22_DISPATCH_SSH: unixPath(sshLog),
    }, root);
    expect(badSha.status).not.toBe(0);
    expect(badSha.out).toContain("RESULT=STOP_CHECKOUT");
    expect(fs.existsSync(sshLog)).toBe(false);
  });

  it("rejects a different main SHA, a bad checksum, and CI that is not success", () => {
    const workflow = fs.readFileSync(WORKFLOW, "utf8");
    const approve = unindent(between(workflow, "Require origin/main, migration bytes, and successful CI", "  release:"));
    const script = unindent(between(approve, "run: |", ""));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "statement-dispatch-"));
    directories.push(root);
    const sshLog = path.join(root, "ssh.log");
    const calls = path.join(root, "calls.log");
    writeExecutable(path.join(root, "ssh"), "#!/bin/sh\nprintf '%s\\n' ssh >> \"$STELL22_DISPATCH_SSH\"\n");
    writeExecutable(path.join(root, "git"), `#!/bin/sh
printf '%s\\n' "$*" >> "$STELL22_DISPATCH_CALLS"
case "$*" in
  *fetch*) exit 0 ;;
  *rev-parse*) printf '%s\\n' "$STELL22_DISPATCH_MAIN" ;;
  *show*) cat "$STELL22_DISPATCH_SQL" ;;
esac
exit 0
`);
    writeExecutable(path.join(root, "gh"), `#!/bin/sh
printf '%s\\n' "$*" >> "$STELL22_DISPATCH_CALLS"
printf '%s\\n' "$STELL22_DISPATCH_CI_COUNT"
`);
    const base = {
      SHA: approved,
      GITHUB_REPOSITORY: "Mr-Pinkerton/Stell22",
      STELL22_DISPATCH_SSH: unixPath(sshLog),
      STELL22_DISPATCH_CALLS: unixPath(calls),
      STELL22_DISPATCH_SQL: unixPath(path.join(process.cwd(), "prisma", "migrations", MIGRATION_NAME, "migration.sql")),
      STELL22_DISPATCH_CI_COUNT: "1",
    };

    fs.writeFileSync(calls, "");
    const wrong = runShell(script, { ...base, STELL22_DISPATCH_MAIN: "b".repeat(40) }, root);
    expect(wrong.status).not.toBe(0);
    expect(wrong.out).toContain("RESULT=STOP_CHECKOUT");
    expect(fs.readFileSync(calls, "utf8")).not.toContain("api");
    expect(fs.existsSync(sshLog)).toBe(false);

    const badSql = path.join(root, "bad.sql");
    fs.writeFileSync(badSql, "not-the-migration\n");
    fs.writeFileSync(calls, "");
    const checksum = runShell(script, { ...base, STELL22_DISPATCH_MAIN: approved, STELL22_DISPATCH_SQL: unixPath(badSql) }, root);
    expect(checksum.status).not.toBe(0);
    expect(checksum.out).toContain("RESULT=STOP_CHECKSUM");
    expect(fs.existsSync(sshLog)).toBe(false);

    fs.writeFileSync(calls, "");
    const ci = runShell(script, { ...base, STELL22_DISPATCH_MAIN: approved, STELL22_DISPATCH_CI_COUNT: "0" }, root);
    expect(ci.status).not.toBe(0);
    expect(ci.out).toContain("RESULT=STOP_CHECKOUT");
    expect(fs.readFileSync(calls, "utf8")).toContain('name == "CI"');
    expect(fs.existsSync(sshLog)).toBe(false);

    fs.writeFileSync(calls, "");
    const ready = runShell(script, { ...base, STELL22_DISPATCH_MAIN: approved }, root);
    expect(ready.status).toBe(0);
    expect(ready.out).toContain("RESULT=SHA_APPROVED");
    expect(fs.existsSync(sshLog)).toBe(false);
  });

  it("passes the approved SHA to checkout and then to the release operator", () => {
    const workflow = fs.readFileSync(WORKFLOW, "utf8");
    const remote = unindent(between(workflow, "script: |", ""));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "statement-dispatch-"));
    directories.push(root);
    const app = path.join(root, "app");
    fs.mkdirSync(path.join(app, "scripts"), { recursive: true });
    const trace = path.join(root, "trace.log");
    writeExecutable(path.join(root, "git"), `#!/bin/sh
case "$*" in
  *fetch*) exit 0 ;;
  *rev-parse*) printf '%s\\n' "$STELL22_DISPATCH_MAIN" ;;
  *cat-file*) exit 0 ;;
  *release-checkout.sh*)
    printf '%s\\n' '#!/bin/sh' 'printf "checkout %s\\n" "$1" >> "$STELL22_DISPATCH_TRACE"'
    ;;
esac
exit 0
`);
    writeExecutable(path.join(app, "scripts", "statement-period-release.sh"), `#!/bin/sh
if [ "$#" -ne 0 ]; then exit 2; fi
printf 'release %s %s %s\\n' "$STELL22_STATEMENT_RELEASE_SHA" "$STELL22_STATEMENT_RELEASE_AUTHORIZATION" "$STELL22_STATEMENT_RELEASE_EXECUTE" >> "$STELL22_DISPATCH_TRACE"
`);
    const denied = runShell(remote, {
      APP_DIR: unixPath(app),
      EXPECTED_SHA: approved,
      STELL22_STATEMENT_RELEASE_EXECUTE: "1",
      STELL22_STATEMENT_RELEASE_AUTHORIZATION: "OWNER_AUTHORIZES_STATEMENT_PERIOD_47_48",
      STELL22_DISPATCH_MAIN: "b".repeat(40),
      STELL22_DISPATCH_TRACE: unixPath(trace),
    }, root);
    expect(denied.status).not.toBe(0);
    expect(denied.out).toContain("RESULT=STOP_CHECKOUT");
    expect(fs.existsSync(trace)).toBe(false);

    const admitted = runShell(remote, {
      APP_DIR: unixPath(app),
      EXPECTED_SHA: approved,
      STELL22_STATEMENT_RELEASE_EXECUTE: "1",
      STELL22_STATEMENT_RELEASE_AUTHORIZATION: "OWNER_AUTHORIZES_STATEMENT_PERIOD_47_48",
      STELL22_DISPATCH_MAIN: approved,
      STELL22_DISPATCH_TRACE: unixPath(trace),
    }, root);
    expect(admitted.status, admitted.out).toBe(0);
    const lines = fs.readFileSync(trace, "utf8").trim().split(/\r?\n/);
    expect(lines).toEqual([
      `checkout ${approved}`,
      `release ${approved} OWNER_AUTHORIZES_STATEMENT_PERIOD_47_48 1`,
    ]);
  });
});
