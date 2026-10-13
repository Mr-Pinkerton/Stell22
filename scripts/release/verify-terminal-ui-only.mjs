/**
 * Offline, read-only Git-object gate for one exact UI-only release.
 * Passing this gate does not verify CI, production runtime, or deploy authority.
 * The script never fetches, checks out, resets, commits, or updates a ref.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SHA_RE = /^[0-9a-f]{40}$/;

export const RELEASE = {
  candidateSha: "e631faeeb0c30c13c4d6c193947095b06f0e81e9",
  candidateTree: "8114348e1276ad08c928411825381ebd3519fd32",
  baselineSha: "678cbc1d308ddfe568b901ebf53f7e05f9a8c014",
  baselineTree: "502f5f5a3c7f2e4ec70427f935485e8184d7b984",
  migrationTree: "d7484b32682ddd7a83ac21133ce5e73d96940648",
  branchRef: "refs/heads/candidate/terminal-ui-only-01",
  p1Path: "prisma/migrations/20261010210000_psr_p3_s2_b_batch_receipt_provenance",
  changed: [
    {
      path: "src/components/terminal/operation-tile.tsx",
      blob: "c718d088ceaf401ad0b24a6ccc9844a6ae326a38",
    },
    {
      path: "src/components/terminal/torcovka-screen.tsx",
      blob: "2bdafed0dbb660cc793b8096305bcc113323d475",
    },
    {
      path: "src/lib/scroll-classes.ts",
      blob: "653d02d46b29ff2abd04925d40231ebee37108cd",
    },
    {
      path: "src/lib/scroll-classes.test.ts",
      blob: "cf7d422f4d020192faf0576410f887262073590e",
    },
  ],
  preserved: [
    { path: "package.json", blob: "bc5d6136aaf2db8da45692e34890798845afa6b9" },
    { path: "package-lock.json", blob: "216b2f3206abb41cfa234d9625f05387260974e5" },
    { path: "prisma/schema.prisma", blob: "8a76393d798136f714b6b54f46a454972cfbcc8f" },
    { path: "src/server/purchases.ts", blob: "11ec42b4aaca40ad72037d4b085e2ee478a17f0f" },
    { path: "src/server/terminal.ts", blob: "9ddf5ef8e270f737fd8c6ce5b7937377ec22cf7c" },
    { path: "docker-entrypoint.sh", blob: "5e131ba1a2072e34f86172cfc0286976980fba8d" },
    { path: "docker-compose.prod.yml", blob: "f7ff57114e6dcf8a4bdbdb8b386ed9936b3f1bb9" },
    { path: "Dockerfile", blob: "dbffad5d4e6bb680509359d5e667a64d90273e58" },
    { path: "scripts/deploy.sh", blob: "ab18a878ad0afbfd7e9667375ff39ffcadb12a8c" },
    { path: "scripts/ci-prod-remote.sh", blob: "38ed9df2415fc9b9dd01c81b5ee865b843777a72" },
    {
      path: ".github/workflows/deploy-production.yml",
      blob: "503d59cac0f6d0eac86582747b8c94e8cad9ec0b",
    },
    {
      path: ".github/workflows/ci.yml",
      blob: "7e1ae37a6b515999388d2d6c26fbabbe93a9b714",
    },
  ],
};

function normalizeSha(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return SHA_RE.test(text) ? text : null;
}

function parseCommitHeader(stdout) {
  const parents = [];
  let tree = null;
  for (const line of String(stdout).split(/\r?\n/)) {
    if (line === "") break;
    if (line.startsWith("tree ")) {
      tree = normalizeSha(line.slice(5));
      if (!tree) return null;
    } else if (line.startsWith("parent ")) {
      const parent = normalizeSha(line.slice(7));
      if (!parent) return null;
      parents.push(parent);
    } else if (
      line.startsWith(" ") ||
      line.startsWith("author ") ||
      line.startsWith("committer ") ||
      line.startsWith("gpgsig ") ||
      line.startsWith("encoding ") ||
      line.startsWith("mergetag ")
    ) {
      continue;
    } else {
      return null;
    }
  }
  if (!tree) return null;
  return { tree, parents };
}

function parseDiff(stdout) {
  const entries = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    if (line === "") continue;
    const match = line.match(/^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z])\t(.+)$/);
    if (!match) return null;
    entries.push({
      oldMode: match[1],
      newMode: match[2],
      oldBlob: match[3],
      newBlob: match[4],
      status: match[5],
      path: match[6],
    });
  }
  return entries;
}

function callGit(runGit, args) {
  let result;
  try {
    result = runGit(args);
  } catch (error) {
    if (error && error.code === "ENOENT") return { failure: "git command is missing" };
    return { failure: `git command failed (${args[0]})` };
  }
  if (!result || result.missing) return { failure: "git command is missing" };
  if (result.status === 0) return { stdout: String(result.stdout ?? "") };
  if (result.status === 128) return { missing: true, stdout: String(result.stdout ?? "") };
  return { failure: `git command failed (${args.join(" ")} exit ${result.status})` };
}

export function collect(runGit) {
  const inside = callGit(runGit, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.failure) return { failure: inside.failure, snapshot: null };
  if (inside.missing || inside.stdout.trim() !== "true") {
    return { failure: "git command failed (not inside a git work tree)", snapshot: null };
  }

  const branch = callGit(runGit, ["rev-parse", "--verify", "--end-of-options", RELEASE.branchRef]);
  if (branch.failure) return { failure: branch.failure, snapshot: null };
  const branchSha = branch.missing ? null : normalizeSha(branch.stdout);
  if (!branch.missing && !branchSha) {
    return { failure: "malformed Git output: candidate branch", snapshot: null };
  }

  const candidateType = callGit(runGit, ["cat-file", "-t", RELEASE.candidateSha]);
  if (candidateType.failure) return { failure: candidateType.failure, snapshot: null };
  const baselineType = callGit(runGit, ["cat-file", "-t", RELEASE.baselineSha]);
  if (baselineType.failure) return { failure: baselineType.failure, snapshot: null };

  let candidateTree = null;
  let parents = [];
  if (!candidateType.missing && candidateType.stdout.trim() === "commit") {
    const header = callGit(runGit, ["cat-file", "-p", RELEASE.candidateSha]);
    if (header.failure) return { failure: header.failure, snapshot: null };
    if (header.missing) return { failure: "malformed Git output: candidate commit", snapshot: null };
    const parsed = parseCommitHeader(header.stdout);
    if (!parsed) return { failure: "malformed Git output: candidate commit", snapshot: null };
    candidateTree = parsed.tree;
    parents = parsed.parents;
  }

  let baselineTree = null;
  if (!baselineType.missing && baselineType.stdout.trim() === "commit") {
    const header = callGit(runGit, ["cat-file", "-p", RELEASE.baselineSha]);
    if (header.failure) return { failure: header.failure, snapshot: null };
    if (header.missing) return { failure: "malformed Git output: baseline commit", snapshot: null };
    const parsed = parseCommitHeader(header.stdout);
    if (!parsed) return { failure: "malformed Git output: baseline commit", snapshot: null };
    baselineTree = parsed.tree;
  }

  let diffEntries = [];
  if (candidateTree && baselineTree) {
    const diff = callGit(runGit, ["diff-tree", "-r", "--raw", baselineTree, candidateTree]);
    if (diff.failure) return { failure: diff.failure, snapshot: null };
    if (diff.missing) return { failure: "malformed Git output: diff-tree", snapshot: null };
    const parsed = parseDiff(diff.stdout);
    if (!parsed) return { failure: "malformed Git output: diff-tree", snapshot: null };
    diffEntries = parsed;
  }

  const blobs = {};
  for (const item of RELEASE.changed) {
    const read = callGit(runGit, ["rev-parse", `${RELEASE.candidateSha}:${item.path}`]);
    if (read.failure) return { failure: read.failure, snapshot: null };
    blobs[item.path] = read.missing ? null : normalizeSha(read.stdout);
    if (!read.missing && !blobs[item.path]) {
      return { failure: `malformed Git output: ${item.path}`, snapshot: null };
    }
  }

  const candidateMigration = callGit(runGit, [
    "rev-parse",
    `${RELEASE.candidateSha}:prisma/migrations`,
  ]);
  if (candidateMigration.failure) return { failure: candidateMigration.failure, snapshot: null };
  const baselineMigration = callGit(runGit, [
    "rev-parse",
    `${RELEASE.baselineSha}:prisma/migrations`,
  ]);
  if (baselineMigration.failure) return { failure: baselineMigration.failure, snapshot: null };

  const p1 = callGit(runGit, ["cat-file", "-e", `${RELEASE.candidateSha}:${RELEASE.p1Path}`]);
  if (p1.failure) return { failure: p1.failure, snapshot: null };

  const preserved = {};
  for (const item of RELEASE.preserved) {
    const read = callGit(runGit, ["rev-parse", `${RELEASE.candidateSha}:${item.path}`]);
    if (read.failure) return { failure: read.failure, snapshot: null };
    preserved[item.path] = read.missing ? null : normalizeSha(read.stdout);
    if (!read.missing && !preserved[item.path]) {
      return { failure: `malformed Git output: ${item.path}`, snapshot: null };
    }
  }

  return {
    failure: null,
    snapshot: {
      candidateObject: candidateType.missing ? "missing" : candidateType.stdout.trim(),
      candidateSha: RELEASE.candidateSha,
      candidateTree,
      parents,
      baselineObject: baselineType.missing ? "missing" : baselineType.stdout.trim(),
      baselineTree,
      branchSha,
      diffEntries,
      blobs,
      migrationTree: candidateMigration.missing ? null : normalizeSha(candidateMigration.stdout),
      baselineMigrationTree: baselineMigration.missing ? null : normalizeSha(baselineMigration.stdout),
      p1Present: !p1.missing,
      preserved,
    },
  };
}

export function assess(snapshot) {
  const reasons = [];
  if (snapshot.candidateObject !== "commit") {
    reasons.push("candidate commit is absent");
  } else {
    if (snapshot.candidateSha !== RELEASE.candidateSha) {
      reasons.push("unknown release SHA: candidate SHA does not match the approved release");
    }
    if (snapshot.candidateTree !== RELEASE.candidateTree) {
      reasons.push("different application tree: candidate tree does not match the approved release");
    }
    if (snapshot.parents.length !== 1 || snapshot.parents[0] !== RELEASE.baselineSha) {
      reasons.push("candidate does not have exactly one approved parent");
    }
  }

  if (snapshot.baselineObject !== "commit") {
    reasons.push("baseline commit is absent");
  } else if (snapshot.baselineTree !== RELEASE.baselineTree) {
    reasons.push("baseline tree does not match the approved baseline");
  }

  if (snapshot.branchSha == null) {
    reasons.push("candidate branch is absent");
  } else if (snapshot.branchSha !== RELEASE.candidateSha) {
    reasons.push("candidate branch does not point at the approved release");
  }

  const expectedPaths = new Set(RELEASE.changed.map((item) => item.path));
  const seen = new Set();
  for (const entry of snapshot.diffEntries) {
    if (!expectedPaths.has(entry.path)) {
      reasons.push(`diff contains an unexpected path: ${entry.path}`);
      continue;
    }
    seen.add(entry.path);
    if (entry.status !== "M") {
      reasons.push(`diff status for ${entry.path} is ${entry.status}`);
    }
    if (entry.oldMode !== entry.newMode) {
      reasons.push(`mode change at ${entry.path}`);
    }
    const expected = RELEASE.changed.find((item) => item.path === entry.path);
    if (entry.newBlob !== expected.blob) {
      reasons.push(`source blob does not match the approved release: ${entry.path}`);
    }
  }
  for (const item of RELEASE.changed) {
    if (!seen.has(item.path)) reasons.push(`approved path missing from diff: ${item.path}`);
    if (snapshot.blobs[item.path] !== item.blob) {
      reasons.push(`source blob does not match the approved release: ${item.path}`);
    }
  }
  if (snapshot.diffEntries.length !== RELEASE.changed.length) {
    const unexpected = snapshot.diffEntries.some((entry) => !expectedPaths.has(entry.path));
    if (!unexpected) reasons.push("diff is not the approved four modifications");
  }

  if (
    snapshot.migrationTree !== RELEASE.migrationTree ||
    snapshot.baselineMigrationTree !== RELEASE.migrationTree
  ) {
    reasons.push("migration subtree does not match the approved baseline");
  }
  if (snapshot.p1Present) reasons.push("P1 migration is present");

  for (const item of RELEASE.preserved) {
    if (snapshot.preserved[item.path] !== item.blob) {
      reasons.push(`baseline identity does not match: ${item.path}`);
    }
  }

  return { ok: reasons.length === 0, reasons };
}

export function formatSuccess(now) {
  return [
    "RESULT: RELEASE SOURCE VERIFIED",
    `candidate SHA: ${RELEASE.candidateSha}`,
    `candidate tree: ${RELEASE.candidateTree}`,
    `baseline SHA: ${RELEASE.baselineSha}`,
    `baseline tree: ${RELEASE.baselineTree}`,
    `migration tree: ${RELEASE.migrationTree}`,
    "changed paths:",
    ...RELEASE.changed.map((item) => item.path),
    `verification timestamp: ${now.toISOString()}`,
    "CI evidence:",
    "NOT VERIFIED BY THIS OFFLINE GATE.",
    "PRODUCTION RUNTIME:",
    "NOT VERIFIED.",
    "DEPLOY AUTHORIZATION:",
    "NO.",
    "",
  ].join("\n");
}

function defaultRunGit(args) {
  try {
    const stdout = execFileSync("git", ["--no-optional-locks", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { missing: true, status: null, stdout: "", stderr: "" };
    }
    return {
      missing: false,
      status: typeof error.status === "number" ? error.status : 1,
      stdout: error.stdout ? String(error.stdout) : "",
      stderr: error.stderr ? String(error.stderr) : "",
    };
  }
}

function refuse(lines) {
  for (const line of lines) console.error(`REFUSE: ${line}`);
  console.error("DEPLOY AUTHORIZATION:");
  console.error("NO.");
  process.exitCode = 1;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length > 0) {
    refuse(["CLI arguments are not accepted"]);
    return;
  }
  const collected = collect(defaultRunGit);
  if (collected.failure) {
    refuse([collected.failure]);
    return;
  }
  const decision = assess(collected.snapshot);
  if (!decision.ok) {
    refuse(decision.reasons);
    return;
  }
  process.stdout.write(formatSuccess(new Date()));
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
  main();
}
