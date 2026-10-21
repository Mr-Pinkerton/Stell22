import { describe, expect, it } from "vitest";
import { runCli } from "@/server/internal/p1-disposable-release/cli";

describe("disposable release command", () => {
  it("refuses every flag, including a production bypass, without starting a rehearsal", () => {
    let calls = 0;
    for (const argv of [
      ["--production"],
      ["--bypass"],
      ["--force"],
      ["--retry"],
      ["--database-url"],
      ["plan"],
    ]) {
      const lines: string[] = [];
      const code = runCli(argv, {
        log: (line) => lines.push(line),
        run: () => {
          calls += 1;
          throw new Error("rehearsal must not start");
        },
      });
      expect(code).toBe(2);
      expect(lines.join("\n")).toContain("MALFORMED_CLI");
    }
    expect(calls).toBe(0);
  });
});
