import { describe, expect, it } from "vitest";
import {
  assertCoordinatorDatabase,
  assertResourceName,
  evaluateInspect,
  namesForRun,
  rejectCallerTarget,
} from "@/server/internal/p1-write-freeze-coordinator/identity";

const runId = "12345678-1234-4234-8234-123456789abc";

describe("coordinator identity", () => {
  it("refuses production names, the production database, and a caller DSN", () => {
    expect(() => assertResourceName("stell22-db-prod")).toThrow(/production/);
    expect(() => assertResourceName("stell22-app")).toThrow(/production/);
    expect(() => assertCoordinatorDatabase("stell22")).toThrow(/database/);
    expect(() => rejectCallerTarget({ databaseUrl: "postgresql://stell22@stell22-db-prod/stell22" })).toThrow(/dsn/);
    expect(() => rejectCallerTarget({ mode: "production" })).toThrow(/production mode/);
    expect(namesForRun(runId).containerName.startsWith("stell22-p1wc-")).toBe(true);
  });

  it("rejects a container whose image or daemon label is not this invocation", () => {
    const names = namesForRun(runId);
    const verdict = evaluateInspect(
      {
        Id: "a".repeat(64),
        Name: names.containerName,
        Image: "sha256:" + "b".repeat(64),
        Config: {
          Image: "postgres:17",
          Labels: { "stell22.p1.write-freeze-coordinator": names.runId },
          Env: ["POSTGRES_USER=stell22", "POSTGRES_DB=stell22"],
        },
        State: { Running: true },
        Mounts: [{ Type: "volume", Name: names.volumeName, Destination: "/var/lib/postgresql/data" }],
        NetworkSettings: { Networks: { [names.networkName]: {} } },
        HostConfig: { PortBindings: null },
      },
      { ...names, containerId: "a".repeat(64), imageId: "sha256:" + "b".repeat(64) },
      "mutate",
    );
    expect(verdict).toEqual({ ok: false, code: "IMAGE_MISMATCH" });
  });
});
