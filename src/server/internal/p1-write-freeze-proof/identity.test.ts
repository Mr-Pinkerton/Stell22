import { describe, expect, it } from "vitest";
import {
  evaluateInspect,
  namesForRun,
  networkCleanupAllowed,
  volumeCleanupAllowed,
  type OwnedExpectation,
} from "@/server/internal/p1-write-freeze-proof/identity";

const RUN = "11111111-1111-4111-8111-111111111111";
const ID = "a".repeat(64);

function expected(): OwnedExpectation {
  return { ...namesForRun(RUN), containerId: ID, imageId: "sha256:" + "b".repeat(64) };
}

function inspect(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const names = namesForRun(RUN);
  return {
    Id: ID,
    Name: `/${names.containerName}`,
    State: { Running: true },
    Image: expected().imageId,
    Config: {
      Image: "postgres:17-alpine",
      Env: ["POSTGRES_USER=stell22", "POSTGRES_DB=stell22", "POSTGRES_PASSWORD=secret"],
      Labels: { "stell22.p1.write-freeze-proof": RUN },
    },
    HostConfig: { PortBindings: {} },
    Mounts: [
      {
        Type: "volume",
        Name: names.volumeName,
        Destination: "/var/lib/postgresql/data",
      },
    ],
    NetworkSettings: { Networks: { [names.networkName]: {} } },
    ...overrides,
  };
}

describe("write-freeze proof identity", () => {
  it("accepts the container this run created", () => {
    expect(evaluateInspect(inspect(), expected(), "mutate")).toEqual({ ok: true });
  });

  it("refuses a production container name even with the proof label", () => {
    const forged = inspect({ Name: "/stell22-db-prod" });
    expect(evaluateInspect(forged, expected(), "mutate").ok).toBe(false);
    expect(evaluateInspect(forged, { ...expected(), containerName: "stell22-db-prod" }, "cleanup")).toEqual({
      ok: false,
      code: "FORBIDDEN_NAME",
    });
  });

  it("refuses either image field on its own", () => {
    expect(evaluateInspect(inspect({ Image: "sha256:" + "c".repeat(64) }), expected(), "cleanup")).toEqual({
      ok: false,
      code: "IMAGE_MISMATCH",
    });
    const renamed = inspect();
    (renamed.Config as { Image: string }).Image = "postgres:17";
    expect(evaluateInspect(renamed, expected(), "mutate")).toEqual({ ok: false, code: "IMAGE_MISMATCH" });
  });

  it("refuses a published port and a compose project", () => {
    expect(
      evaluateInspect(
        inspect({ HostConfig: { PortBindings: { "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "5432" }] } } }),
        expected(),
        "mutate",
      ),
    ).toEqual({ ok: false, code: "PORT_EXPOSED" });
    const labeled = inspect();
    const config = labeled.Config as { Labels: Record<string, string> };
    config.Labels["com.docker.compose.project"] = "stell22";
    expect(evaluateInspect(labeled, expected(), "mutate")).toEqual({ ok: false, code: "COMPOSE_PROJECT" });
  });

  it("refuses cleanup of a volume or network that is not this run", () => {
    const names = namesForRun(RUN);
    expect(volumeCleanupAllowed({ Name: "stell22-db-prod", Labels: {} }, expected()).ok).toBe(false);
    expect(
      volumeCleanupAllowed(
        { Name: names.volumeName, Labels: { "stell22.p1.write-freeze-proof": RUN } },
        expected(),
      ),
    ).toEqual({ ok: true });
    expect(
      networkCleanupAllowed(
        {
          Name: names.networkName,
          Labels: { "stell22.p1.write-freeze-proof": RUN },
          Containers: { ["c".repeat(64)]: {} },
        },
        expected(),
      ),
    ).toEqual({ ok: false, code: "ID_MISMATCH" });
    expect(
      volumeCleanupAllowed(
        {
          Name: names.volumeName,
          Labels: { "stell22.p1.write-freeze-proof": RUN, "com.docker.compose.project": "stell22" },
        },
        expected(),
      ),
    ).toEqual({ ok: false, code: "COMPOSE_PROJECT" });
    expect(
      networkCleanupAllowed(
        {
          Name: names.networkName,
          Labels: { "stell22.p1.write-freeze-proof": RUN, "com.docker.compose.project": "stell22" },
          Containers: {},
        },
        expected(),
      ),
    ).toEqual({ ok: false, code: "COMPOSE_PROJECT" });
  });
});
