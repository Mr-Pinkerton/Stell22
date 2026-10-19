import { describe, expect, it } from "vitest";
import { isDestructiveDockerArgv } from "@/server/internal/p1-write-freeze-coordinator/cleanup";
import { COORDINATOR_LABEL } from "@/server/internal/p1-write-freeze-coordinator/contract";
import { namesForRun, type OwnedNames } from "@/server/internal/p1-write-freeze-coordinator/identity";
import {
  createOwnedCrashContainer,
  execOwned,
  OwnedCrashRefusal,
  releaseOwned,
  type CrashWorld,
} from "@/server/internal/p1-write-freeze-coordinator/owned-crash-container";

const IMAGE = `sha256:${"d".repeat(64)}`;
const ID = "c".repeat(64);

type Patch = (row: Record<string, unknown>, names: OwnedNames) => void;

function fake(options: { runStatus?: number; runStdout?: string; rmStatus?: number; patch?: Patch } = {}) {
  const calls: string[][] = [];
  const box = { endpoint: "npipe:////./pipe/docker_engine", daemonId: "daemon-a", context: "desktop-linux" };
  let names: OwnedNames | undefined;
  const world: CrashWorld = {
    endpoint: () => box.endpoint,
    daemonId: () => box.daemonId,
    context: () => box.context,
    exec: (args) => {
      calls.push([...args]);
      if (args[0] === "image") return { status: 0, stdout: `${IMAGE}\n`, stderr: "" };
      if (args[0] === "network" && args[1] === "create") {
        const label = args[args.indexOf("--label") + 1] ?? "";
        names = namesForRun(label.slice(COORDINATOR_LABEL.length + 1));
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "volume" && args[1] === "create") return { status: 0, stdout: "", stderr: "" };
      if (args[0] === "run") return { status: options.runStatus ?? 0, stdout: options.runStdout ?? `${ID}\n`, stderr: "" };
      if (args[0] === "inspect") return { status: 0, stdout: JSON.stringify([containerDocument(names!, options.patch)]), stderr: "" };
      if (args[0] === "rm") return { status: options.rmStatus ?? 0, stdout: "", stderr: options.rmStatus ? "busy" : "" };
      if (args[0] === "volume" && args[1] === "inspect") {
        return { status: 0, stdout: JSON.stringify([{ Name: names!.volumeName, Labels: { [COORDINATOR_LABEL]: names!.runId } }]), stderr: "" };
      }
      if (args[0] === "network" && args[1] === "inspect") {
        return { status: 0, stdout: JSON.stringify([{ Name: names!.networkName, Labels: { [COORDINATOR_LABEL]: names!.runId }, Containers: {} }]), stderr: "" };
      }
      if ((args[0] === "volume" || args[0] === "network") && args[1] === "rm") return { status: 0, stdout: "", stderr: "" };
      if (args[0] === "exec") return { status: 0, stdout: "1\n", stderr: "" };
      return { status: 1, stdout: "", stderr: "unexpected" };
    },
  };
  return { world, calls, box, ownedNames: () => names };
}

function containerDocument(names: OwnedNames, patch?: Patch): Record<string, unknown> {
  const row: Record<string, unknown> = {
    Id: ID,
    Name: `/${names.containerName}`,
    Image: IMAGE,
    Config: {
      Image: "postgres:17-alpine",
      Labels: { [COORDINATOR_LABEL]: names.runId },
      Env: ["POSTGRES_USER=stell22", "POSTGRES_DB=stell22"],
    },
    State: { Running: true },
    Mounts: [{ Type: "volume", Name: names.volumeName, Destination: "/var/lib/postgresql/data" }],
    NetworkSettings: { Networks: { [names.networkName]: {} } },
    HostConfig: { PortBindings: null },
  };
  patch?.(row, names);
  return row;
}

function destructive(calls: string[][]): string[][] {
  return calls.filter((args) => isDestructiveDockerArgv(args));
}

function codeOf(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof OwnedCrashRefusal) return error.code;
    throw error;
  }
  return "";
}

describe("owned P1 crash container", () => {
  it("preserves resources when creation fails before an id is returned", () => {
    const harness = fake({ runStatus: 1, runStdout: "" });
    expect(codeOf(() => createOwnedCrashContainer(harness.world))).toBe("CREATE_FAILED");
    expect(destructive(harness.calls)).toEqual([]);
    expect(harness.calls.some((args) => args[0] === "exec" || args[0] === "inspect")).toBe(false);
  });

  it("preserves resources when docker returns a malformed id", () => {
    const harness = fake({ runStdout: "not-a-container-id\n" });
    expect(codeOf(() => createOwnedCrashContainer(harness.world))).toBe("MALFORMED_ID");
    expect(destructive(harness.calls)).toEqual([]);
  });

  it("preserves a container whose immutable image id does not match", () => {
    const harness = fake({ patch: (row) => { row.Image = `sha256:${"e".repeat(64)}`; } });
    expect(codeOf(() => createOwnedCrashContainer(harness.world))).toBe("IMAGE_MISMATCH");
    expect(destructive(harness.calls)).toEqual([]);
  });

  it("preserves a foreign container that reuses the owned name", () => {
    const harness = fake({ patch: (row) => { row.Id = "e".repeat(64); } });
    expect(codeOf(() => createOwnedCrashContainer(harness.world))).toBe("ID_MISMATCH");
    expect(destructive(harness.calls)).toEqual([]);
  });

  it("preserves a foreign container that copies the run label", () => {
    const harness = fake({
      patch: (row) => {
        row.Name = "/stell22-p1wc-ffffffff-ffff-4fff-8fff-ffffffffffff";
        const config = row.Config as { Labels: Record<string, string> };
        config.Labels["com.docker.compose.project"] = "foreign";
      },
    });
    expect(codeOf(() => createOwnedCrashContainer(harness.world))).toBe("NAME_MISMATCH");
    expect(destructive(harness.calls)).toEqual([]);
  });

  it("does not exec when the endpoint, daemon, or context changes", () => {
    const endpoint = fake();
    const ownedEndpoint = createOwnedCrashContainer(endpoint.world);
    endpoint.box.endpoint = "tcp://10.9.9.9:2375";
    expect(codeOf(() => execOwned(endpoint.world, ownedEndpoint, ["psql"]))).toBe("ENDPOINT_CHANGED");
    expect(endpoint.calls.some((args) => args[0] === "exec")).toBe(false);

    const daemon = fake();
    const ownedDaemon = createOwnedCrashContainer(daemon.world);
    daemon.box.daemonId = "daemon-b";
    expect(codeOf(() => execOwned(daemon.world, ownedDaemon, ["psql"]))).toBe("DAEMON_CHANGED");
    expect(daemon.calls.filter((args) => args[0] === "exec")).toEqual([]);

    const context = fake();
    const ownedContext = createOwnedCrashContainer(context.world);
    context.box.context = "remote";
    expect(codeOf(() => execOwned(context.world, ownedContext, ["psql"]))).toBe("CONTEXT_CHANGED");
    expect(destructive(context.calls)).toEqual([]);
    expect(context.calls.some((args) => args[0] === "exec")).toBe(false);
  });

  it("preserves every resource when identity changes before cleanup", () => {
    const harness = fake();
    const owned = createOwnedCrashContainer(harness.world);
    const before = harness.calls.length;
    harness.box.daemonId = "daemon-b";
    const report = releaseOwned(harness.world, owned);
    expect(report.removed).toEqual([]);
    expect(report.preserved.map((item) => item.reason)).toEqual(["DAEMON_CHANGED", "DAEMON_CHANGED", "DAEMON_CHANGED"]);
    expect(destructive(harness.calls.slice(before))).toEqual([]);
  });

  it("preserves the volume and network when container removal fails", () => {
    const harness = fake({ rmStatus: 1 });
    const owned = createOwnedCrashContainer(harness.world);
    const report = releaseOwned(harness.world, owned);
    expect(report.removed).toEqual([]);
    expect(report.failures).toEqual([{ resource: "container", reason: "REMOVAL_FAILED" }]);
    expect(report.preserved.map((item) => item.resource)).toEqual(["volume", "network"]);
    expect(harness.calls.some((args) => args[0] === "volume" && args[1] === "rm")).toBe(false);
    expect(harness.calls.some((args) => args[0] === "network" && args[1] === "rm")).toBe(false);
  });

  it("executes and removes only the captured container id", () => {
    const harness = fake();
    const owned = createOwnedCrashContainer(harness.world);
    const names = harness.ownedNames();
    expect(names).toBeDefined();
    const run = harness.calls.find((args) => args[0] === "run");
    expect(run).toContain("--pull");
    expect(run).toContain("never");
    expect(run).not.toContain("-p");
    expect(run).not.toContain("--publish");
    expect(run?.some((arg) => arg.includes("POSTGRES_PASSWORD"))).toBe(false);
    const executed = execOwned(harness.world, owned, ["psql", "-U", "stell22", "-d", "stell22", "-At", "-c", "SELECT 1"]);
    expect(executed.stdout).toBe("1\n");
    expect(harness.calls.some((args) => args[0] === "exec" && args[1] === ID)).toBe(true);
    expect(harness.calls.some((args) => args[0] === "exec" && args[1] === names?.containerName)).toBe(false);
    const report = releaseOwned(harness.world, owned);
    expect(report.removed).toEqual(["container", "volume", "network"]);
    expect(harness.calls.some((args) => args[0] === "rm" && args[1] === "-f" && args[2] === ID)).toBe(true);
    expect(harness.calls.some((args) => args[0] === "rm" && args.includes(names?.containerName ?? ""))).toBe(false);
    expect(harness.calls.some((args) => args.includes("prune") || args.includes("--filter"))).toBe(false);
  });
});
