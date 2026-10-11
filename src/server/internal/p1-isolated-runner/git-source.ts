import { execFileSync } from "node:child_process";
import type {
  GitBlobSource,
  GitTreeEntry,
} from "@/server/internal/p1-isolated-runner/migration-set";
import { assertHex40 } from "@/server/internal/p1-isolated-runner/migration-set";

export function createRepoGitSource(repoRoot: string): GitBlobSource {
  return {
    resolveCommit(commit) {
      assertHex40(commit, "commit");
      const resolved = git(repoRoot, ["rev-parse", "--verify", `${commit}^{commit}`]);
      const tree = git(repoRoot, ["rev-parse", "--verify", `${commit}^{tree}`]);
      return { commit: resolved, tree };
    },
    listMigrationTree(commit) {
      assertHex40(commit, "commit");
      const text = git(repoRoot, ["ls-tree", "-r", commit, "prisma/migrations"]);
      if (!text) return [];
      return text.split("\n").map(parseTreeLine);
    },
    resolvePathBlob(commit, filePath) {
      assertHex40(commit, "commit");
      if (filePath !== "prisma/schema.prisma" && !filePath.startsWith("prisma/migrations/")) {
        throw new Error("Refusing to read an unpinned git path");
      }
      return git(repoRoot, ["rev-parse", "--verify", `${commit}:${filePath}`]);
    },
    readBlob(gitBlob) {
      assertHex40(gitBlob, "blob");
      return execFileSync("git", ["cat-file", "blob", gitBlob], {
        cwd: repoRoot,
        shell: false,
        windowsHide: true,
      });
    },
  };
}

function parseTreeLine(line: string): GitTreeEntry {
  const tab = line.indexOf("\t");
  if (tab < 0) {
    throw new Error("Unexpected git ls-tree output");
  }
  const meta = line.slice(0, tab).split(/\s+/);
  const gitBlob = meta[2];
  const filePath = line.slice(tab + 1);
  if (!gitBlob || !filePath) {
    throw new Error("Unexpected git ls-tree output");
  }
  return { path: filePath, gitBlob };
}

function git(repoRoot: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  })
    .replaceAll("\r", "")
    .trim();
}
