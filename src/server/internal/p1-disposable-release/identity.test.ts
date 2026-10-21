import { describe, expect, it } from "vitest";
import { PRODUCTION_MIGRATOR_CREDENTIAL_PATH } from "@/server/internal/p1-production-adapter/contract";
import {
  assertRehearsalTarget,
  rehearsalIdentity,
} from "@/server/internal/p1-disposable-release/identity";

const containers = [
  "p1as-db-abcdef01",
  "p1as-app-abcdef01",
  "p1as-net-abcdef01",
  "p1as-vol-abcdef01",
];

function target(overrides: Partial<Parameters<typeof assertRehearsalTarget>[0]> = {}) {
  return {
    databaseName: "p1as_abcdef01",
    restoreDatabaseName: "p1as_abcdef02",
    containerNames: containers,
    credentialPath: null,
    dockerEndpoint: "npipe:////./pipe/docker_engine",
    releaseEnvironment: "TEST_OWNED",
    sshTarget: null,
    ...overrides,
  };
}

describe("disposable release identity", () => {
  it("accepts a generated test-owned identity", () => {
    const identity = rehearsalIdentity("abcdef01");
    expect(identity.databaseName).toBe("p1as_abcdef01");
    expect(identity.restoreDatabaseName).toBe("p1as_abcdef02");
    expect(assertRehearsalTarget(target())).toEqual({ ok: true });
  });

  it("refuses the production database name before any migration", () => {
    expect(assertRehearsalTarget(target({ databaseName: "stell22" }))).toEqual({
      ok: false,
      code: "PRODUCTION_DATABASE_REFUSED",
    });
  });

  it("refuses production container names", () => {
    for (const name of ["stell22-db-prod", "stell22-app", "stell22-caddy", "stell22-db"]) {
      expect(assertRehearsalTarget(target({ containerNames: [name] }))).toEqual({
        ok: false,
        code: "PRODUCTION_CONTAINER_REFUSED",
      });
    }
  });

  it("refuses a production credential path", () => {
    expect(
      assertRehearsalTarget(target({ credentialPath: PRODUCTION_MIGRATOR_CREDENTIAL_PATH })),
    ).toEqual({ ok: false, code: "PRODUCTION_CREDENTIAL_REFUSED" });
  });

  it("refuses an SSH or remote Docker endpoint", () => {
    expect(assertRehearsalTarget(target({ sshTarget: "ssh://deploy@prod.example" }))).toEqual({
      ok: false,
      code: "PRODUCTION_SSH_REFUSED",
    });
    expect(assertRehearsalTarget(target({ dockerEndpoint: "ssh://deploy@prod.example" }))).toEqual({
      ok: false,
      code: "PRODUCTION_SSH_REFUSED",
    });
    expect(assertRehearsalTarget(target({ dockerEndpoint: "tcp://10.1.2.3:2376" }))).toEqual({
      ok: false,
      code: "PRODUCTION_SSH_REFUSED",
    });
  });

  it("refuses a production release environment", () => {
    expect(assertRehearsalTarget(target({ releaseEnvironment: "production" }))).toEqual({
      ok: false,
      code: "PRODUCTION_RELEASE_ENVIRONMENT_REFUSED",
    });
  });

  it("refuses an unsupported or ambiguous identity", () => {
    expect(assertRehearsalTarget(target({ databaseName: "p1disp_abcdef01" }))).toEqual({
      ok: false,
      code: "UNSUPPORTED_IDENTITY",
    });
    expect(assertRehearsalTarget(target({ databaseName: "" }))).toEqual({
      ok: false,
      code: "AMBIGUOUS_IDENTITY",
    });
    expect(assertRehearsalTarget(target({ restoreDatabaseName: "p1as_abcdef01" }))).toEqual({
      ok: false,
      code: "AMBIGUOUS_IDENTITY",
    });
    expect(assertRehearsalTarget(target({ dockerEndpoint: null }))).toEqual({
      ok: false,
      code: "AMBIGUOUS_IDENTITY",
    });
  });
});
