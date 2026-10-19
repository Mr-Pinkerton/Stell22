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

  it("preserves the volume when the endpoint changes after inspect and before deletion", () => {
    const calls: string[][] = [];
    const owned = invocation();
    let endpoint = owned.endpoint;
    const world: DockerWorld = {
      endpoint: () => endpoint,
      daemonId: () => owned.daemonId,
      exec: (args) => {
        calls.push([...args]);
        if (args[0] === "inspect") return { status: 0, stdout: JSON.stringify([containerDocument(owned)]), stderr: "" };
        if (args[0] === "rm") return { status: 0, stdout: "", stderr: "" };
        if (args[0] === "volume" && args[1] === "inspect") {
          endpoint = "tcp://10.9.9.9:2375";
          return { status: 0, stdout: JSON.stringify([volumeDocument()]), stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    const report = releaseInvocation(owned, world);
    expect(report.removed).toEqual(["container"]);
    expect(report.preserved.map((item) => item.resource)).toEqual(["volume", "network"]);
    expect(report.preserved[0]?.reason).toBe("ENDPOINT_CHANGED");
    expect(calls.some((args) => args[0] === "volume" && args[1] === "rm")).toBe(false);
    expect(calls.some((args) => args[0] === "network" && args[1] === "rm")).toBe(false);
    expect(calls.some((args) => args.includes("prune") || args.includes("--filter"))).toBe(false);
  });

  it("preserves the network when the daemon changes after inspect and before deletion", () => {
    const calls: string[][] = [];
    const owned = invocation();
    let daemonId = owned.daemonId;
    const world: DockerWorld = {
      endpoint: () => owned.endpoint,
      daemonId: () => daemonId,
      exec: (args) => {
        calls.push([...args]);
        if (args[0] === "inspect") return { status: 0, stdout: JSON.stringify([containerDocument(owned)]), stderr: "" };
        if (args[0] === "rm") return { status: 0, stdout: "", stderr: "" };
        if (args[0] === "volume" && args[1] === "inspect") return { status: 0, stdout: JSON.stringify([volumeDocument()]), stderr: "" };
        if (args[0] === "volume" && args[1] === "rm") return { status: 0, stdout: "", stderr: "" };
        if (args[0] === "network" && args[1] === "inspect") {
          daemonId = "daemon-b";
          return { status: 0, stdout: JSON.stringify([networkDocument(owned.containerId ?? "")]), stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    const report = releaseInvocation(owned, world);
    expect(report.removed).toEqual(["container", "volume"]);
    expect(report.preserved).toEqual([{ resource: "network", reason: "DAEMON_CHANGED" }]);
    expect(calls.some((args) => args[0] === "network" && args[1] === "rm")).toBe(false);
  });
});

function containerDocument(owned: Invocation) {
  return {
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
  };
}

function volumeDocument() {
  return { Name: names.volumeName, Labels: { "stell22.p1.write-freeze-coordinator": names.runId } };
}

function networkDocument(containerId: string) {
  return {
    Name: names.networkName,
    Labels: { "stell22.p1.write-freeze-coordinator": names.runId },
    Containers: { [containerId]: {} },
  };
}
