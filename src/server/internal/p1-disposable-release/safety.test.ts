import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const rehearsal = fs.readFileSync(
  path.join(process.cwd(), "src/server/internal/p1-disposable-release/rehearsal.ts"),
  "utf8",
);

describe("disposable release safety boundary", () => {
  it("does not call production deploy, compose, prune, or a production bypass", () => {
    const combined = rehearsal;
    expect(combined).not.toContain("deploy.sh");
    expect(combined).not.toContain("docker-compose.prod.yml");
    expect(combined).not.toContain("deploy-production.yml");
    expect(combined).not.toContain("docker system prune");
    expect(combined).not.toContain("docker prune");
    expect(combined).not.toContain("--production");
    expect(combined).not.toContain("FREEZE_PASS");
  });
});
