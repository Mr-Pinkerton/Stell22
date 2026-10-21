import path from "node:path";
import { describe, expect, it } from "vitest";
import { readStartupFacts, startupBlocker } from "@/server/internal/p1-offline-writer-admission/startup-facts";

describe("app-only startup is not the production path", () => {
  it("reads the production entrypoint and compose files", () => {
    const facts = readStartupFacts(path.resolve(process.cwd()));
    expect(facts.productionEntrypointRunsMigrate).toBe(true);
    expect(facts.dockerfileSelectsProductionEntrypoint).toBe(false);
    expect(facts.composeRestartUnlessStopped).toBe(true);
    expect(facts.composeNamesProductionApp).toBe(true);
    expect(facts.composeSelectsAppOnlyEntrypoint).toBe(false);
    expect(facts.appOnlyScriptRunsMigrate).toBe(false);
    expect(facts.candidateDockerfileSelectsAppOnly).toBe(true);
    expect(facts.productionDockerfileSelectsCandidate).toBe(false);
    expect(facts.appOnlyIsProductionPath).toBe(false);
    expect(startupBlocker(facts)).toContain("npx prisma migrate deploy");
    expect(startupBlocker(facts)).toContain("unless-stopped");
    expect(startupBlocker(facts)).toContain("HARD RELEASE BLOCKER");
  });
});
