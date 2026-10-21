import path from "node:path";
import { describe, expect, it } from "vitest";
import { judgeOfflineAdmission, type OfflineFacts } from "@/server/internal/p1-offline-writer-admission/verdict";
import { evaluateStartupFiles, readStartupFacts, startupBlocker, type StartupSources } from "@/server/internal/p1-offline-writer-admission/startup-facts";

describe("configured startup is not a verified production runtime", () => {
  it("reads a build context that inherits the image entrypoint", () => {
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
    expect(facts.configuredBuildInheritsImageEntrypoint).toBe(true);
    expect(facts.configuredNextBuildSelectsAppOnly).toBe(true);
    expect(facts.deployedRuntimeVerified).toBe(false);
    expect(startupBlocker(facts)).toContain("inherits docker-entrypoint-app-only.sh");
    expect(startupBlocker(facts)).toContain("npx prisma migrate deploy");
    expect(startupBlocker(facts)).toContain("unless-stopped");
    expect(startupBlocker(facts)).toContain("NOT VERIFIED");
    expect(startupBlocker(facts)).toContain("HARD RELEASE BLOCKER");
  });

  it("identifies build: . with no entrypoint override, and an explicit override", () => {
    const inherited = evaluateStartupFiles(sources(compose("    build: .\n    restart: unless-stopped\n"), appOnlyDockerfile()));
    expect(inherited.configuredBuildInheritsImageEntrypoint).toBe(true);
    expect(inherited.configuredNextBuildSelectsAppOnly).toBe(true);
    expect(inherited.composeSelectsAppOnlyEntrypoint).toBe(false);
    expect(inherited.deployedRuntimeVerified).toBe(false);
    expect(inherited.appOnlyIsProductionPath).toBe(false);

    const overridden = evaluateStartupFiles(
      sources(compose('    build: .\n    entrypoint: ["./docker-entrypoint.sh"]\n'), appOnlyDockerfile()),
    );
    expect(overridden.configuredBuildInheritsImageEntrypoint).toBe(false);
    expect(overridden.configuredNextBuildSelectsAppOnly).toBe(false);
    expect(overridden.deployedRuntimeVerified).toBe(false);

    const commanded = evaluateStartupFiles(sources(compose('    build: .\n    command: ["node", "server.js"]\n'), appOnlyDockerfile()));
    expect(commanded.configuredBuildInheritsImageEntrypoint).toBe(true);
    expect(commanded.configuredNextBuildSelectsAppOnly).toBe(true);
    expect(commanded.deployedRuntimeVerified).toBe(false);
    expect(commanded.appOnlyIsProductionPath).toBe(false);

    const commandBlock = evaluateStartupFiles(sources(compose("    build: .\n    command:\n      - node\n      - server.js\n"), appOnlyDockerfile()));
    expect(commandBlock.configuredBuildInheritsImageEntrypoint).toBe(true);
    expect(commandBlock.configuredNextBuildSelectsAppOnly).toBe(true);
  });

  it("inherits the image entrypoint unless an effective entrypoint replaces it", () => {
    const dockerfile = appOnlyDockerfile();
    const factsFor = (body: string) => evaluateStartupFiles(sources(compose(body), dockerfile));

    const absent = factsFor("    build: .\n");
    expect(absent.configuredBuildInheritsImageEntrypoint).toBe(true);
    expect(absent.configuredNextBuildSelectsAppOnly).toBe(true);

    const nulled = factsFor("    build: .\n    command: [\"npm\", \"run\", \"start\"]\n    entrypoint: null\n");
    expect(nulled.configuredBuildInheritsImageEntrypoint).toBe(true);
    expect(nulled.configuredNextBuildSelectsAppOnly).toBe(true);
    expect(nulled.deployedRuntimeVerified).toBe(false);
    expect(nulled.appOnlyIsProductionPath).toBe(false);

    const yamlNull = factsFor("    build: .\n    entrypoint: ~\n");
    expect(yamlNull.configuredBuildInheritsImageEntrypoint).toBe(true);

    for (const disabled of ['    entrypoint: []\n', '    entrypoint: [ ]\n', '    entrypoint: ""\n', "    entrypoint: ''\n"]) {
      const facts = factsFor(`    build: .\n${disabled}`);
      expect(facts.configuredBuildInheritsImageEntrypoint).toBe(false);
      expect(facts.configuredNextBuildSelectsAppOnly).toBe(false);
      expect(facts.deployedRuntimeVerified).toBe(false);
      expect(facts.appOnlyIsProductionPath).toBe(false);
    }

    for (const override of [
      '    entrypoint: ["./docker-entrypoint.sh"]\n',
      "    entrypoint: /code/entrypoint.sh\n",
      '    entrypoint: "null"\n',
      "    entrypoint:\n      - php\n      - -d\n",
    ]) {
      const facts = factsFor(`    build: .\n${override}`);
      expect(facts.configuredBuildInheritsImageEntrypoint).toBe(false);
      expect(facts.configuredNextBuildSelectsAppOnly).toBe(false);
    }

    const restored = factsFor('    build: .\n    entrypoint: ["./docker-entrypoint.sh"]\n    entrypoint: null\n');
    expect(restored.configuredBuildInheritsImageEntrypoint).toBe(true);
    expect(restored.configuredNextBuildSelectsAppOnly).toBe(true);
  });

  it("keeps a legacy image entrypoint distinct from the unverified deployed runtime", () => {
    const legacy = evaluateStartupFiles(
      sources(compose("    build: .\n"), 'FROM scratch\nENTRYPOINT ["./docker-entrypoint.sh"]\n'),
    );
    expect(legacy.configuredBuildInheritsImageEntrypoint).toBe(true);
    expect(legacy.dockerfileSelectsProductionEntrypoint).toBe(true);
    expect(legacy.configuredNextBuildSelectsAppOnly).toBe(false);
    expect(legacy.deployedRuntimeVerified).toBe(false);
    expect(legacy.appOnlyIsProductionPath).toBe(false);
    expect(startupBlocker(legacy)).toContain("npx prisma migrate deploy");
  });

  it("leaves the admission gate forbidden", () => {
    const verdict = judgeOfflineAdmission(admissionFacts());
    expect(verdict.gate).toBe("FREEZE_PASS_FORBIDDEN");
    expect(verdict.freezePassAllowed).toBe(false);
    expect(verdict.productionRelease).toBe("NO-GO");
    expect(verdict.p1Applied).toBe(false);
  });
});

function sources(compose: string, dockerfile: string): StartupSources {
  return {
    legacyEntrypoint: "#!/bin/sh\nset -e\nnpx prisma migrate deploy\nexec npm run start\n",
    dockerfile,
    compose,
    appOnlyEntrypoint: "#!/bin/sh\nset -eu\nexec npm run start\n",
    candidateDockerfile: 'ENTRYPOINT ["./docker-entrypoint-app-only.sh"]\n',
  };
}

function compose(appBody: string): string {
  return `services:\n  db:\n    image: postgres:17-alpine\n  app:\n${appBody}    container_name: stell22-app\n  caddy:\n    image: caddy\n`;
}

function appOnlyDockerfile(): string {
  return 'FROM scratch\nENTRYPOINT ["./docker-entrypoint-app-only.sh"]\n';
}

function admissionFacts(): OfflineFacts {
  return {
    httpDirectBefore: "committed",
    httpProxyBefore: "committed",
    httpDirectDuring: "rejected-all",
    httpProxyDuring: "rejected-all",
    directAcceptedWhileProxyClosed: true,
    continuitySamples: 8,
    continuityBreaks: 0,
    blindCommitAfterDeclaration: "committed",
    cooperativeRecheck: "absent",
    terminatedBeforeCommit: "absent",
    pastCheckCommitted: true,
    backgroundTicksAfterClose: 0,
    scheduledRecheckCommitted: false,
    maxAppSessionsDuringLatch: 0,
    newAppSqlAfterHttpFreeze: "committed",
    postHocActivitySawThatSession: false,
    raceCommits: 0,
    raceTrials: 4,
    restartLoopWritesWhileOpen: true,
    restartLoopWritesWhileClosed: false,
    explicitStopStayedDown: true,
    crashRestartedByPolicy: true,
    crashWithOpenFileWroteAgain: true,
    crashWithClosedFileWrote: false,
    engineKillRestarted: false,
    operatorStartAfterStopWrote: true,
    daemonRestart: "not-tested",
    operatorBootstrapInsert: "committed",
    appCannotUpdateAdmission: true,
    prismaMigrationsRelation: "absent",
    appOnlyIsProductionPath: false,
    serverActionsCovered: false,
    physicalDisconnectTested: false,
  };
}
