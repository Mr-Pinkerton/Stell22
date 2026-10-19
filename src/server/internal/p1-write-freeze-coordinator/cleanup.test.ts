import { describe, expect, it } from "vitest";
import { releaseInvocation, type DockerWorld, type Invocation } from "@/server/internal/p1-write-freeze-coordinator/cleanup";
import { namesForRun } from "@/server/internal/p1-write-freeze-coordinator/identity";

const names = namesForRun("12345678-1234-4234-8234-123456789abc");

function invocation(): Invocation {
  return {
    endpoint: "npipe:////./pipe/docker_engine",
    daemonId: "daemon-a",
    imageId: `sha256:${"b".repeat(64)}`,
    names,
    networkCreated: true,
    volumeCreated: true,
    containerId: "a".repeat(64),
    containerPhase: "confirmed",
  };
}

describe("coordinator cleanup", () => {
  it("preserves the volume and network when the daemon endpoint changes", () => {
    const calls: string[][] = [];
    const world: DockerWorld = {
      endpoint: () => "tcp://10.0.0.8:2375",
      daemonId: () => "daemon-a",
      exec: (args) => {
        calls.push([...args]);
        return { status: 0, stdout: "[]", stderr: "" };
      },
    };
    const report = releaseInvocation(invocation(), world);
    expect(report.removed).toEqual([]);
    expect(report.preserved.map((item) => item.resource)).toEqual(["container", "volume", "network"]);
    expect(calls).toEqual([]);
  });

  it("preserves owned resources when container removal fails", () => {
    const calls: string[][] = [];
    const owned = invocation();
    const inspect = [
      {
        Id: owned.containerId,
        Name: `/${names.containerName}`,
        Image: owned.imageId,
        Config: {
          Image: "postgres:17-alpine",
          Labels: { "stell22.p1.write-freeze-coordinator": names.runId },
          Env: ["POSTGRES_USER=stell22", "POSTGRES_DB=stell22"],
        },
        State: { Running: true },
        Mounts: [{ Type: "volume", Name: names.volumeName, Destination: "/var/lib/postgresql/data" }],
        NetworkSettings: { Networks: { [names.networkName]: {} } },
        HostConfig: { PortBindings: null },
      },
    ];
    const world: DockerWorld = {
      endpoint: () => owned.endpoint,
      daemonId: () => owned.daemonId,
      exec: (args) => {
        calls.push([...args]);
        if (args[0] === "inspect") return { status: 0, stdout: JSON.stringify(inspect), stderr: "" };
        return { status: 1, stdout: "", stderr: "busy" };
      },
    };
    const report = releaseInvocation(owned, world);
    expect(report.removed).toEqual([]);
    expect(report.failures).toEqual([{ resource: "container", reason: "REMOVAL_FAILED" }]);
    expect(report.preserved.map((item) => item.resource)).toEqual(["volume", "network"]);
    expect(calls.some((args) => args[0] === "volume" && args[1] === "rm")).toBe(false);
    expect(calls.some((args) => args[0] === "prune")).toBe(false);
  });
});
