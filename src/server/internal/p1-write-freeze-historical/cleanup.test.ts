import { describe, expect, it } from "vitest";
import { releaseAppContainer } from "@/server/internal/p1-write-freeze-historical/cleanup";
import type { AppExpectation } from "@/server/internal/p1-write-freeze-historical/identity";
import { isDestructiveDockerArgv, type DockerWorld, type ExecResult } from "@/server/internal/p1-write-freeze-proof/lifecycle";

const RUN = "11111111-1111-4111-8111-111111111111";
const ID = "a".repeat(64);
const FOREIGN = "d".repeat(64);
const IMAGE = `sha256:${"b".repeat(64)}`;
const ENDPOINT = "npipe:////./pipe/docker_engine";
const DAEMON = "daemon-local-1";

class FakeDocker implements DockerWorld {
  readonly calls: string[][] = [];
  endpointValue = ENDPOINT;
  daemonValue = DAEMON;
  private readonly routes = new Map<string, () => ExecResult>();

  route(args: readonly string[], result: ExecResult | (() => ExecResult)): void {
    const produce = typeof result === "function" ? result : () => result;
    this.routes.set(args.join("\0"), produce);
  }

  endpoint(): string {
    return this.endpointValue;
  }

  daemonId(): string {
    return this.daemonValue;
  }

  exec(args: readonly string[]): ExecResult {
    const copy = [...args];
    this.calls.push(copy);
    const route = this.routes.get(copy.join("\0"));
    if (route === undefined) return { status: 1, stdout: "", stderr: "unhandled" };
    return route();
  }

  destructive(): string[][] {
    return this.calls.filter(isDestructiveDockerArgv);
  }
}

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

function document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

function json(value: unknown): ExecResult {
  return { status: 0, stdout: JSON.stringify([value]), stderr: "" };
}

describe("historical application cleanup", () => {
  it("deletes the confirmed container by the captured id", () => {
    const fake = new FakeDocker();
    fake.route(["inspect", ID], json(document()));
    fake.route(["rm", "-f", ID], { status: 0, stdout: ID, stderr: "" });
    expect(releaseAppContainer(expected(), ENDPOINT, DAEMON, fake)).toEqual({ removed: true, reason: "REMOVED" });
    expect(fake.destructive()).toEqual([["rm", "-f", ID]]);
  });

  it("preserves a foreign container, a wrong image, and a privileged url", () => {
    for (const doc of [
      document({ Id: FOREIGN }),
      document({ Image: `sha256:${"c".repeat(64)}` }),
      {
        ...document(),
        Config: {
          ...(document().Config as object),
          Env: ["DATABASE_URL=postgresql://stell22:secret@db:5432/stell22"],
        },
      },
    ]) {
      const fake = new FakeDocker();
      fake.route(["inspect", ID], json(doc));
      expect(releaseAppContainer(expected(), ENDPOINT, DAEMON, fake).removed).toBe(false);
      expect(fake.destructive()).toEqual([]);
      expect(fake.calls.some((args) => args.includes(FOREIGN) || args[0] === "ps" || args.includes("prune"))).toBe(false);
    }
  });

  it("preserves the container when the endpoint or daemon changes", () => {
    const endpoint = new FakeDocker();
    endpoint.endpointValue = "tcp://10.1.2.3:2375";
    expect(releaseAppContainer(expected(), ENDPOINT, DAEMON, endpoint)).toEqual({
      removed: false,
      reason: "ENDPOINT_CHANGED",
    });
    expect(endpoint.calls).toEqual([]);
    const daemon = new FakeDocker();
    daemon.daemonValue = "other-daemon";
    expect(releaseAppContainer(expected(), ENDPOINT, DAEMON, daemon).reason).toBe("DAEMON_CHANGED");
    expect(daemon.destructive()).toEqual([]);
  });

  it("preserves the container when inspect fails or removal fails once", () => {
    const missing = new FakeDocker();
    missing.route(["inspect", ID], { status: 1, stdout: "", stderr: "missing" });
    expect(releaseAppContainer(expected(), ENDPOINT, DAEMON, missing).reason).toBe("INSPECT_FAILED");
    expect(missing.destructive()).toEqual([]);
    const failed = new FakeDocker();
    failed.route(["inspect", ID], json(document()));
    failed.route(["rm", "-f", ID], { status: 1, stdout: "", stderr: "busy" });
    expect(releaseAppContainer(expected(), ENDPOINT, DAEMON, failed).reason).toBe("REMOVAL_FAILED");
    expect(failed.calls.filter((args) => args[0] === "rm")).toHaveLength(1);
  });
});
