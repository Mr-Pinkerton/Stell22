import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("terminal UI release gate CI discovery", () => {
  it(
    "executes the native node:test suite and fails when that suite fails",
    { timeout: 60_000 },
    () => {
      const script = path.join(root, "scripts", "release", "verify-terminal-ui-only.test.mjs");
      const result = spawnSync(process.execPath, ["--test", script], {
        cwd: root,
        encoding: "utf8",
      });
      const stdout = result.stdout ?? "";
      const stderr = result.stderr ?? "";
      if (result.error || result.status !== 0) {
        throw new Error(
          `node --test exited ${result.status ?? "null"}: ${result.error?.message ?? ""}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
        );
      }
      expect(stdout).toContain("refuses a wrong candidate SHA even when the tree matches");
      expect(stdout).toContain("# tests 22");
      expect(stdout).toContain("# fail 0");
    },
  );
});
