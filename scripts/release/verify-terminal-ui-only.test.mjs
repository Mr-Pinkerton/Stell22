import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  RELEASE,
  assess,
  collect,
  formatSuccess,
} from "./verify-terminal-ui-only.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function accepted() {
  return {
    candidateObject: "commit",
    candidateSha: RELEASE.candidateSha,
    candidateTree: RELEASE.candidateTree,
    parents: [RELEASE.baselineSha],
    baselineObject: "commit",
    baselineTree: RELEASE.baselineTree,
    branchSha: RELEASE.candidateSha,
    diffEntries: RELEASE.changed.map((item) => ({
      status: "M",
      oldMode: "100644",
      newMode: "100644",
      path: item.path,
      newBlob: item.blob,
    })),
    blobs: Object.fromEntries(RELEASE.changed.map((item) => [item.path, item.blob])),
    migrationTree: RELEASE.migrationTree,
    baselineMigrationTree: RELEASE.migrationTree,
    p1Present: false,
    preserved: Object.fromEntries(RELEASE.preserved.map((item) => [item.path, item.blob])),
  };
}

function reasons(snapshot) {
  return assess(snapshot).reasons.join("\n");
}

test("accepts the hardcoded release snapshot", () => {
  const result = assess(accepted());
  assert.equal(result.ok, true);
  assert.deepEqual(result.reasons, []);
});

test("refuses a wrong candidate SHA even when the tree matches", () => {
  const snapshot = accepted();
  snapshot.candidateSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  snapshot.branchSha = snapshot.candidateSha;
  const result = assess(snapshot);
  assert.equal(result.ok, false);
  assert.match(reasons(snapshot), /candidate SHA does not match the approved release/);
});

test("refuses a wrong candidate tree when every listed blob still matches", () => {
  const snapshot = accepted();
  snapshot.candidateTree = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const result = assess(snapshot);
  assert.equal(result.ok, false);
  assert.match(reasons(snapshot), /candidate tree does not match the approved release/);
});

test("refuses a wrong parent", () => {
  const snapshot = accepted();
  snapshot.parents = ["cccccccccccccccccccccccccccccccccccccccc"];
  assert.match(reasons(snapshot), /candidate does not have exactly one approved parent/);
});

test("refuses two parents", () => {
  const snapshot = accepted();
  snapshot.parents = [RELEASE.baselineSha, "dddddddddddddddddddddddddddddddddddddddd"];
  assert.equal(assess(snapshot).ok, false);
  assert.match(reasons(snapshot), /candidate does not have exactly one approved parent/);
});

test("refuses a missing candidate commit", () => {
  const snapshot = accepted();
  snapshot.candidateObject = "missing";
  assert.match(reasons(snapshot), /candidate commit is absent/);
});

test("refuses a missing baseline commit", () => {
  const snapshot = accepted();
  snapshot.baselineObject = "missing";
  assert.match(reasons(snapshot), /baseline commit is absent/);
});

test("refuses an extra changed path", () => {
  const snapshot = accepted();
  snapshot.diffEntries.push({
    status: "A",
    oldMode: "000000",
    newMode: "100644",
    path: "src/server/terminal.ts",
    newBlob: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  });
  assert.match(reasons(snapshot), /diff contains an unexpected path/);
});

test("refuses an altered source blob", () => {
  const snapshot = accepted();
  const pathName = RELEASE.changed[0].path;
  snapshot.blobs[pathName] = "ffffffffffffffffffffffffffffffffffffffff";
  assert.match(reasons(snapshot), /source blob does not match the approved release/);
});

test("refuses an altered migration subtree", () => {
  const snapshot = accepted();
  snapshot.migrationTree = "1111111111111111111111111111111111111111";
  snapshot.baselineMigrationTree = snapshot.migrationTree;
  assert.match(reasons(snapshot), /migration subtree does not match the approved baseline/);
});

test("refuses a migration subtree that drifted from the baseline object", () => {
  const snapshot = accepted();
  snapshot.migrationTree = "2222222222222222222222222222222222222222";
  assert.match(reasons(snapshot), /migration subtree does not match the approved baseline/);
});

test("refuses when the P1 migration is present", () => {
  const snapshot = accepted();
  snapshot.p1Present = true;
  assert.match(reasons(snapshot), /P1 migration is present/);
});

test("refuses a missing candidate branch", () => {
  const snapshot = accepted();
  snapshot.branchSha = null;
  assert.match(reasons(snapshot), /candidate branch is absent/);
});

test("refuses unexpected candidate branch movement", () => {
  const snapshot = accepted();
  snapshot.branchSha = "3333333333333333333333333333333333333333";
  assert.match(reasons(snapshot), /candidate branch does not point at the approved release/);
});

test("refuses a mode change on an approved path", () => {
  const snapshot = accepted();
  snapshot.diffEntries[0].newMode = "100755";
  assert.match(reasons(snapshot), /mode change/);
});

test("refuses a preserved backend blob that moved off the baseline", () => {
  const snapshot = accepted();
  snapshot.preserved["src/server/terminal.ts"] = "4444444444444444444444444444444444444444";
  assert.match(reasons(snapshot), /baseline identity does not match/);
});

function okGit(overrides = {}) {
  const commitText = (tree, parent) =>
    `tree ${tree}\nparent ${parent}\nauthor Test <t@example.com> 1 +0000\ncommitter Test <t@example.com> 1 +0000\n\nmessage\n`;
  const diff = RELEASE.changed
    .map(
      (item) =>
        `:100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ${item.blob} M\t${item.path}`,
    )
    .join("\n")
    .concat("\n");
  return (args) => {
    const key = args.join(" ");
    if (Object.prototype.hasOwnProperty.call(overrides, key)) return overrides[key];
    if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
      return { status: 0, stdout: "true\n", stderr: "" };
    }
    if (args.includes("refs/heads/candidate/terminal-ui-only-01")) {
      return { status: 0, stdout: `${RELEASE.candidateSha}\n`, stderr: "" };
    }
    if (args[0] === "cat-file" && args[1] === "-t" && args[2] === RELEASE.candidateSha) {
      return { status: 0, stdout: "commit\n", stderr: "" };
    }
    if (args[0] === "cat-file" && args[1] === "-p" && args[2] === RELEASE.candidateSha) {
      return {
        status: 0,
        stdout: commitText(RELEASE.candidateTree, RELEASE.baselineSha),
        stderr: "",
      };
    }
    if (args[0] === "cat-file" && args[1] === "-t" && args[2] === RELEASE.baselineSha) {
      return { status: 0, stdout: "commit\n", stderr: "" };
    }
    if (args[0] === "cat-file" && args[1] === "-p" && args[2] === RELEASE.baselineSha) {
      return {
        status: 0,
        stdout: commitText(RELEASE.baselineTree, "0000000000000000000000000000000000000000"),
        stderr: "",
      };
    }
    if (args[0] === "diff-tree") {
      return { status: 0, stdout: diff, stderr: "" };
    }
    if (args[0] === "rev-parse" && args[1] === `${RELEASE.candidateSha}:prisma/migrations`) {
      return { status: 0, stdout: `${RELEASE.migrationTree}\n`, stderr: "" };
    }
    if (args[0] === "rev-parse" && args[1] === `${RELEASE.baselineSha}:prisma/migrations`) {
      return { status: 0, stdout: `${RELEASE.migrationTree}\n`, stderr: "" };
    }
    if (args[0] === "cat-file" && args[1] === "-e") {
      return { status: 128, stdout: "", stderr: "missing\n" };
    }
    if (args[0] === "rev-parse" && args[1]?.startsWith(`${RELEASE.candidateSha}:`)) {
      const spec = args[1].slice(RELEASE.candidateSha.length + 1);
      const changed = RELEASE.changed.find((item) => item.path === spec);
      const preserved = RELEASE.preserved.find((item) => item.path === spec);
      const blob = changed?.blob ?? preserved?.blob;
      if (!blob) return { status: 128, stdout: "", stderr: "missing\n" };
      return { status: 0, stdout: `${blob}\n`, stderr: "" };
    }
    return { status: 129, stdout: "", stderr: `unexpected ${key}\n` };
  };
}

test("collect accepts a faithful Git read", () => {
  const result = collect(okGit());
  assert.equal(result.failure, null);
  assert.equal(assess(result.snapshot).ok, true);
});

test("malformed Git output is refused", () => {
  const result = collect(
    okGit({
      [`diff-tree -r --raw ${RELEASE.baselineTree} ${RELEASE.candidateTree}`]: {
        status: 0,
        stdout: "this is not a diff-tree line\n",
        stderr: "",
      },
    }),
  );
  assert.match(result.failure, /malformed Git output/);
});

test("command failure is refused", () => {
  const result = collect(() => ({ status: 2, stdout: "", stderr: "boom\n" }));
  assert.match(result.failure, /git command failed/);
});

test("a missing Git command is refused", () => {
  const result = collect(() => ({ missing: true, status: null, stdout: "", stderr: "" }));
  assert.match(result.failure, /git command is missing/);
});

test("success text records identities and refuses deploy authority", () => {
  const text = formatSuccess(new Date("2026-10-13T17:00:00.000Z"));
  assert.match(text, /RESULT: RELEASE SOURCE VERIFIED/);
  assert.match(text, new RegExp(RELEASE.candidateSha));
  assert.match(text, new RegExp(RELEASE.candidateTree));
  assert.match(text, new RegExp(RELEASE.baselineSha));
  assert.match(text, new RegExp(RELEASE.baselineTree));
  assert.match(text, new RegExp(RELEASE.migrationTree));
  for (const item of RELEASE.changed) assert.match(text, new RegExp(item.path.replaceAll(".", "\\.")));
  assert.match(text, /verification timestamp: 2026-10-13T17:00:00.000Z/);
  assert.match(text, /CI evidence:\nNOT VERIFIED BY THIS OFFLINE GATE\./);
  assert.match(text, /PRODUCTION RUNTIME:\nNOT VERIFIED\./);
  assert.match(text, /DEPLOY AUTHORIZATION:\nNO\./);
  assert.doesNotMatch(text, /DEPLOY AUTHORIZATION:\nYES/);
});

test("the published candidate objects verify without mutating refs", () => {
  const before = spawnSync("git", ["rev-parse", "refs/heads/candidate/terminal-ui-only-01"], {
    cwd: root,
    encoding: "utf8",
  });
  const script = path.join(root, "scripts", "release", "verify-terminal-ui-only.mjs");
  const run = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
  const after = spawnSync("git", ["rev-parse", "refs/heads/candidate/terminal-ui-only-01"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /RESULT: RELEASE SOURCE VERIFIED/);
  assert.match(run.stdout, /CI evidence:\nNOT VERIFIED BY THIS OFFLINE GATE\./);
  assert.match(run.stdout, /PRODUCTION RUNTIME:\nNOT VERIFIED\./);
  assert.match(run.stdout, /DEPLOY AUTHORIZATION:\nNO\./);
  assert.equal(before.stdout, after.stdout);
  assert.equal(after.stdout.trim(), RELEASE.candidateSha);
});
