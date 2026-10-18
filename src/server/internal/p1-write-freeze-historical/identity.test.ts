import { describe, expect, it } from "vitest";
import { applicationUser, evaluateAppInspect, type AppExpectation } from "@/server/internal/p1-write-freeze-historical/identity";

const RUN = "11111111-1111-4111-8111-111111111111";
const ID = "a".repeat(64);
const IMAGE = `sha256:${"b".repeat(64)}`;

function expected(): AppExpectation {
  return {
    containerId: ID,
    containerName: `stell22-p1wf-${RUN}-app`,
    imageId: IMAGE,
    imageRef: `stell22-p1wf-hist-${RUN}`,
    networkName: `stell22-p1wf-${RUN}-net`,
    runId: RUN,
    purpose: "application",
  };
}

function inspect(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const wanted = expected();
  return {
    Id: ID,
    Name: `/${wanted.containerName}`,
    Image: IMAGE,
    Config: {
      Image: wanted.imageRef,
      Env: ["DATABASE_URL=postgresql://p1wf_app:secret@db:5432/stell22"],
      Labels: { "stell22.p1.write-freeze-historical": RUN },
    },
    HostConfig: { PortBindings: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "3000" }] } },
    NetworkSettings: { Networks: { [wanted.networkName]: {} } },
    ...overrides,
  };
}

describe("historical application identity", () => {
  it("accepts the container this run built", () => {
    expect(evaluateAppInspect(inspect(), expected())).toEqual({ ok: true });
  });

  it("refuses either image field on its own", () => {
    expect(evaluateAppInspect(inspect({ Image: `sha256:${"c".repeat(64)}` }), expected())).toEqual({
      ok: false,
      code: "IMAGE_MISMATCH",
    });
    const renamed = inspect();
    (renamed.Config as { Image: string }).Image = "stell22-app";
    expect(evaluateAppInspect(renamed, expected()).ok).toBe(false);
  });

  it("refuses bootstrap and migrator connection users", () => {
    expect(applicationUser(["DATABASE_URL=postgresql://stell22:secret@db:5432/stell22"])).toBe("privileged");
    expect(applicationUser(["DATABASE_URL=postgresql://p1wf_migrator:secret@db:5432/stell22"])).toBe("migrator");
    expect(applicationUser(["DATABASE_URL=postgresql://p1wf_breakglass:secret@db:5432/stell22"])).toBe("privileged");
    const forged = inspect();
    (forged.Config as { Env: string[] }).Env = ["DATABASE_URL=postgresql://stell22:secret@db:5432/stell22"];
    expect(evaluateAppInspect(forged, expected())).toEqual({ ok: false, code: "PRIVILEGED_URL" });
  });

  it("refuses a production name, a compose project, and a public port", () => {
    expect(evaluateAppInspect(inspect({ Name: "/stell22-app" }), expected()).ok).toBe(false);
    const labeled = inspect();
    (labeled.Config as { Labels: Record<string, string> }).Labels["com.docker.compose.project"] = "stell22";
    expect(evaluateAppInspect(labeled, expected())).toEqual({ ok: false, code: "COMPOSE_PROJECT" });
    expect(
      evaluateAppInspect(
        inspect({ HostConfig: { PortBindings: { "3000/tcp": [{ HostIp: "0.0.0.0", HostPort: "3000" }] } } }),
        expected(),
      ),
    ).toEqual({ ok: false, code: "PORT_EXPOSED" });
  });
});
