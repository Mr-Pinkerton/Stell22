import { describe, expect, it } from "vitest";
import { proofExecArgs, redactProofText } from "@/server/internal/p1-write-freeze-proof/cluster";
import { namesForRun, PROOF_LABEL } from "@/server/internal/p1-write-freeze-proof/identity";
import {
  isDestructiveDockerArgv,
  releaseInvocation,
  type DockerWorld,
  type ExecResult,
  type Invocation,
} from "@/server/internal/p1-write-freeze-proof/lifecycle";

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

function invocation(overrides: Partial<Invocation> = {}): Invocation {
  return {
    endpoint: ENDPOINT,
    daemonId: DAEMON,
    imageId: IMAGE,
    names: namesForRun(RUN),
    networkCreated: true,
    volumeCreated: true,
    containerId: ID,
    containerPhase: "confirmed",
    ...overrides,
  };
}

function ok(stdout = ""): ExecResult {
  return { status: 0, stdout, stderr: "" };
}

function json(document: unknown): ExecResult {
  return ok(JSON.stringify([document]));
}

function containerDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const names = namesForRun(RUN);
  return {
    Id: ID,
    Name: `/${names.containerName}`,
    State: { Running: true },
    Image: IMAGE,
    Config: {
      Image: "postgres:17-alpine",
      Env: ["POSTGRES_USER=stell22", "POSTGRES_DB=stell22"],
      Labels: { [PROOF_LABEL]: RUN },
    },
    HostConfig: { PortBindings: {} },
    Mounts: [{ Type: "volume", Name: names.volumeName, Destination: "/var/lib/postgresql/data" }],
    NetworkSettings: { Networks: { [names.networkName]: {} } },
    ...overrides,
  };
}

function volumeDoc(labels: Record<string, string> = { [PROOF_LABEL]: RUN }): Record<string, unknown> {
  return { Name: namesForRun(RUN).volumeName, Labels: labels };
}

function networkDoc(containers: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Name: namesForRun(RUN).networkName,
    Labels: { [PROOF_LABEL]: RUN },
    Containers: containers,
  };
}

function ownedWorld(): FakeDocker {
  const names = namesForRun(RUN);
  const fake = new FakeDocker();
  fake.route(["inspect", ID], json(containerDoc()));
  fake.route(["volume", "inspect", names.volumeName], json(volumeDoc()));
  fake.route(["network", "inspect", names.networkName], json(networkDoc()));
  fake.route(["rm", "-f", ID], ok(ID));
  fake.route(["volume", "rm", names.volumeName], ok(names.volumeName));
  fake.route(["network", "rm", names.networkName], ok(names.networkName));
  return fake;
}

describe("write-freeze proof cleanup", () => {
  it("deletes a confirmed container, volume, and network by the captured id", () => {
    const names = namesForRun(RUN);
    const fake = ownedWorld();
    const report = releaseInvocation(invocation(), fake);
    expect(report.removed).toEqual(["container", "volume", "network"]);
    expect(report.preserved).toEqual([]);
    expect(fake.destructive()).toEqual([
      ["rm", "-f", ID],
      ["volume", "rm", names.volumeName],
      ["network", "rm", names.networkName],
    ]);
    expect(fake.calls.some((args) => args[0] === "ps" || args.includes("--filter") || args.includes("prune"))).toBe(false);
  });

  it("deletes the same confirmed container when the SQL identity marker was not written", () => {
    const fake = ownedWorld();
    const report = releaseInvocation(invocation(), fake);
    expect(report.removed).toContain("container");
    expect(fake.destructive()[0]).toEqual(["rm", "-f", ID]);
    expect(fake.calls.some((args) => args.includes(FOREIGN) || args[0] === "ps")).toBe(false);
  });

  it("does not delete anything when network creation failed", () => {
    const fake = new FakeDocker();
    const report = releaseInvocation(
      invocation({ networkCreated: false, volumeCreated: false, containerId: null, containerPhase: "not-started" }),
      fake,
    );
    expect(report.removed).toEqual([]);
    expect(fake.destructive()).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it("removes only the confirmed network when volume creation failed", () => {
    const names = namesForRun(RUN);
    const fake = new FakeDocker();
    fake.route(["network", "inspect", names.networkName], json(networkDoc()));
    fake.route(["network", "rm", names.networkName], ok(names.networkName));
    const report = releaseInvocation(
      invocation({ volumeCreated: false, containerId: null, containerPhase: "not-started" }),
      fake,
    );
    expect(report.removed).toEqual(["network"]);
    expect(fake.destructive()).toEqual([["network", "rm", names.networkName]]);
  });

  it("preserves every resource when container creation fails", () => {
    const fake = ownedWorld();
    const report = releaseInvocation(invocation({ containerId: null, containerPhase: "ambiguous" }), fake);
    expect(report.preserved.map((item) => item.resource)).toEqual(["container", "volume", "network"]);
    expect(fake.destructive()).toEqual([]);
  });

  it("preserves every resource when docker run returns no id", () => {
    const fake = ownedWorld();
    const report = releaseInvocation(invocation({ containerId: null, containerPhase: "ambiguous" }), fake);
    expect(report.preserved.every((item) => item.reason === "AMBIGUOUS")).toBe(true);
    expect(fake.destructive()).toEqual([]);
  });

  it("preserves every resource when docker run returns a malformed id", () => {
    const fake = ownedWorld();
    const report = releaseInvocation(invocation({ containerId: "abc", containerPhase: "ambiguous" }), fake);
    expect(fake.calls.some((args) => args.includes("abc"))).toBe(false);
    expect(report.preserved.map((item) => item.reason)).toEqual(["AMBIGUOUS", "AMBIGUOUS", "AMBIGUOUS"]);
    expect(fake.destructive()).toEqual([]);
  });

  it("preserves every resource when inspect fails", () => {
    const fake = new FakeDocker();
    fake.route(["inspect", ID], { status: 1, stdout: "", stderr: "missing" });
    const report = releaseInvocation(invocation(), fake);
    expect(report.preserved.map((item) => item.reason)).toEqual(["INSPECT_FAILED", "INSPECT_FAILED", "INSPECT_FAILED"]);
    expect(fake.destructive()).toEqual([]);
  });

  it("preserves a container whose immutable image id does not match", () => {
    const fake = new FakeDocker();
    fake.route(["inspect", ID], json(containerDoc({ Image: `sha256:${"c".repeat(64)}` })));
    const report = releaseInvocation(invocation(), fake);
    expect(report.preserved[0]).toEqual({ resource: "container", reason: "IMAGE_MISMATCH" });
    expect(fake.destructive()).toEqual([]);
  });

  it("preserves a container whose Config.Image does not match", () => {
    const fake = new FakeDocker();
    const doc = containerDoc();
    (doc.Config as { Image: string }).Image = "postgres:16-alpine";
    fake.route(["inspect", ID], json(doc));
    const report = releaseInvocation(invocation(), fake);
    expect(report.preserved.map((item) => item.resource)).toEqual(["container", "volume", "network"]);
    expect(fake.destructive()).toEqual([]);
  });

  it("does not delete a foreign container that carries the same label", () => {
    const fake = new FakeDocker();
    const doc = containerDoc({ Id: FOREIGN });
    fake.route(["inspect", ID], json(doc));
    const report = releaseInvocation(invocation(), fake);
    expect(report.preserved[0]?.reason).toBe("ID_MISMATCH");
    expect(fake.calls.some((args) => args.includes(FOREIGN) || args[0] === "ps" || args.includes("--filter"))).toBe(false);
    expect(fake.destructive()).toEqual([]);
  });

  it("preserves a foreign volume and still checks the network separately", () => {
    const names = namesForRun(RUN);
    const fake = ownedWorld();
    fake.route(["volume", "inspect", names.volumeName], json(volumeDoc({ [PROOF_LABEL]: "someone-else" })));
    const report = releaseInvocation(invocation(), fake);
    expect(report.preserved).toContainEqual({ resource: "volume", reason: "LABEL_MISMATCH" });
    expect(fake.calls.filter((args) => args[0] === "volume" && args[1] === "rm")).toEqual([]);
    expect(fake.destructive()).toContainEqual(["network", "rm", names.networkName]);
  });

  it("preserves a foreign network", () => {
    const names = namesForRun(RUN);
    const fake = ownedWorld();
    fake.route(["network", "inspect", names.networkName], json(networkDoc({ [FOREIGN]: {} })));
    const report = releaseInvocation(invocation(), fake);
    expect(report.preserved).toContainEqual({ resource: "network", reason: "ID_MISMATCH" });
    expect(fake.calls.filter((args) => args[0] === "network" && args[1] === "rm")).toEqual([]);
    expect(fake.calls.some((args) => args.includes(FOREIGN))).toBe(false);
  });

  it("preserves a Compose project container", () => {
    const fake = new FakeDocker();
    const doc = containerDoc();
    (doc.Config as { Labels: Record<string, string> }).Labels["com.docker.compose.project"] = "stell22";
    fake.route(["inspect", ID], json(doc));
    const report = releaseInvocation(invocation(), fake);
    expect(report.preserved[0]).toEqual({ resource: "container", reason: "COMPOSE_PROJECT" });
    expect(fake.destructive()).toEqual([]);
  });

  it("preserves a production container name", () => {
    const fake = new FakeDocker();
    fake.route(["inspect", ID], json(containerDoc({ Name: "/stell22-db-prod" })));
    const report = releaseInvocation(invocation(), fake);
    expect(report.preserved[0]?.reason).toBe("FORBIDDEN_NAME");
    expect(fake.destructive()).toEqual([]);
  });

  it("preserves every resource when the Docker endpoint changes", () => {
    const fake = ownedWorld();
    fake.endpointValue = "tcp://10.1.2.3:2375";
    const report = releaseInvocation(invocation(), fake);
    expect(report.preserved[0]).toEqual({ resource: "container", reason: "ENDPOINT_CHANGED" });
    expect(fake.calls).toEqual([]);
    expect(fake.destructive()).toEqual([]);
  });

  it("preserves every resource when the Docker daemon id changes", () => {
    const fake = ownedWorld();
    fake.daemonValue = "other-daemon";
    const report = releaseInvocation(invocation(), fake);
    expect(report.preserved[0]).toEqual({ resource: "container", reason: "DAEMON_CHANGED" });
    expect(fake.destructive()).toEqual([]);
  });

  it("stops deleting after the daemon id changes between resources", () => {
    const names = namesForRun(RUN);
    const fake = ownedWorld();
    fake.route(["rm", "-f", ID], () => {
      fake.daemonValue = "other-daemon";
      return ok(ID);
    });
    const report = releaseInvocation(invocation(), fake);
    expect(report.removed).toEqual(["container"]);
    expect(report.preserved.map((item) => item.resource)).toEqual(["volume", "network"]);
    expect(fake.destructive()).toEqual([["rm", "-f", ID]]);
    expect(fake.calls.some((args) => args[0] === "volume" && args[1] === "inspect" && args[2] === names.volumeName)).toBe(
      false,
    );
  });

  it("records a failed volume removal once and does not prune", () => {
    const names = namesForRun(RUN);
    const fake = ownedWorld();
    fake.route(["volume", "rm", names.volumeName], { status: 1, stdout: "", stderr: "busy" });
    const report = releaseInvocation(invocation(), fake);
    expect(report.failures).toEqual([{ resource: "volume", reason: "REMOVAL_FAILED" }]);
    expect(fake.calls.filter((args) => args[0] === "volume" && args[1] === "rm")).toEqual([
      ["volume", "rm", names.volumeName],
    ]);
    expect(fake.calls.some((args) => args.includes("prune"))).toBe(false);
    expect(report.removed).toContain("network");
  });

  it("keeps a disposable password out of exec arguments and reported text", () => {
    const password = "disposable-password-value";
    const args = proofExecArgs("C:\\Temp\\p1wf-pg-token", ID, ["psql", "-c", "SELECT pg_sleep(1);"], false);
    expect(args.join(" ")).not.toContain(password);
    expect(args).toContain("--env-file");
    expect(args).not.toContain("-e");
    expect(redactProofText(`failed ${password}`, [password])).toBe("failed [redacted]");
  });
});
