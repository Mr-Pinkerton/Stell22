import { describe, expect, it } from "vitest";
import { releaseOwnedImage, beginImageBuild, copyOwned, createOwnedContainer, execOwned, restartOwnedContainer } from "@/server/internal/p1-write-freeze-historical/lifecycle";
import type { InvocationBinding } from "@/server/internal/p1-write-freeze-historical/lifecycle";
import type { AppExpectation } from "@/server/internal/p1-write-freeze-historical/identity";
import { isDestructiveDockerArgv, type DockerWorld, type ExecResult } from "@/server/internal/p1-write-freeze-proof/lifecycle";

const RUN = "11111111-1111-4111-8111-111111111111";
const ID = "a".repeat(64);
const FOREIGN = "d".repeat(64);
const IMAGE = `sha256:${"b".repeat(64)}`;
const OTHER = `sha256:${"c".repeat(64)}`;
const TAG = `stell22-p1wf-hist-${RUN}`;
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

  deleting(): string[][] {
    return this.calls.filter((args) => isDestructiveDockerArgv(args) || args[0] === "rmi" || args.includes("prune") || args[0] === "restart");
  }
}

function binding(): InvocationBinding {
  return { endpoint: ENDPOINT, daemonId: DAEMON, runId: RUN };
}

function expected(): AppExpectation {
  return {
    containerId: ID,
    containerName: `stell22-p1wf-${RUN}-app`,
    imageId: IMAGE,
    imageRef: TAG,
    networkName: `stell22-p1wf-${RUN}-net`,
    runId: RUN,
    purpose: "application",
  };
}

function ownedArgs(): string[] {
  const wanted = expected();
  return [
    "--name", wanted.containerName,
    "--network", wanted.networkName,
    "--label", `stell22.p1.write-freeze-historical=${RUN}`,
    "--restart", "no",
    "-p", "127.0.0.1::3000",
    TAG,
  ];
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

function imageDocument(id = IMAGE, tags = [`${TAG}:latest`]): Record<string, unknown> {
  return { Id: id, RepoTags: tags };
}

function json(value: unknown): ExecResult {
  return { status: 0, stdout: JSON.stringify([value]), stderr: "" };
}

describe("historical application lifecycle", () => {
  it("does not delete an image when the build produced no confirmed id", () => {
    const fake = new FakeDocker();
    expect(beginImageBuild(binding(), TAG, fake)).toEqual({ ok: true });
    expect(releaseOwnedImage(binding(), TAG, "", fake)).toEqual({ removed: false, reason: "IDENTITY_MISSING" });
    expect(fake.calls).toEqual([]);
    expect(fake.deleting()).toEqual([]);
  });

  it("refuses build, create, and run when the endpoint or the name is not this invocation", () => {
    const drifted = new FakeDocker();
    drifted.endpointValue = "tcp://10.1.2.3:2375";
    expect(beginImageBuild(binding(), TAG, drifted)).toEqual({ ok: false, reason: "ENDPOINT_CHANGED" });
    expect(createOwnedContainer("run", ownedArgs(), binding(), drifted)).toEqual({ ok: false, reason: "ENDPOINT_CHANGED" });
    expect(drifted.calls).toEqual([]);
    const named = new FakeDocker();
    const args = ownedArgs();
    args[1] = "stell22-app";
    expect(createOwnedContainer("create", args, binding(), named)).toEqual({ ok: false, reason: "NAME_MISMATCH" });
    const published = new FakeDocker();
    const ports = ownedArgs();
    ports[ports.indexOf("-p") + 1] = "0.0.0.0::3000";
    expect(createOwnedContainer("run", ports, binding(), published)).toEqual({ ok: false, reason: "PORT_EXPOSED" });
    expect(named.deleting()).toEqual([]);
    expect(published.calls).toEqual([]);
  });

  it("keeps an unconfirmed create or run and does not remove anything", () => {
    for (const command of ["create", "run"] as const) {
      const fake = new FakeDocker();
      const argv = command === "run" ? ["run", "-d", ...ownedArgs()] : ["create", ...ownedArgs()];
      fake.route(argv, { status: 0, stdout: "not-an-id\n", stderr: "" });
      expect(createOwnedContainer(command, ownedArgs(), binding(), fake)).toEqual({ ok: false, reason: "AMBIGUOUS" });
      expect(fake.deleting()).toEqual([]);
      expect(fake.calls).toEqual([argv]);
    }
  });

  it("does not restart or copy when inspect fails or the daemon changes", () => {
    const missing = new FakeDocker();
    missing.route(["inspect", ID], { status: 1, stdout: "", stderr: "missing" });
    expect(restartOwnedContainer(expected(), binding(), missing)).toEqual({ ok: false, reason: "INSPECT_FAILED" });
    expect(missing.deleting()).toEqual([]);
    const daemon = new FakeDocker();
    daemon.daemonValue = "other-daemon";
    expect(restartOwnedContainer(expected(), binding(), daemon)).toEqual({ ok: false, reason: "DAEMON_CHANGED" });
    expect(copyOwned(expected(), binding(), [`${ID}:/app/docker-entrypoint.sh`, "copy"], daemon)).toEqual({
      ok: false,
      reason: "DAEMON_CHANGED",
    });
    expect(execOwned(expected(), binding(), [ID, "node", "probe"], daemon)).toEqual({ ok: false, reason: "DAEMON_CHANGED" });
    expect(daemon.calls).toEqual([]);
  });

  it("does not restart when the endpoint changes or the image id does not match", () => {
    const endpoint = new FakeDocker();
    endpoint.endpointValue = "unix:///tmp/other.sock";
    expect(restartOwnedContainer(expected(), binding(), endpoint)).toEqual({ ok: false, reason: "ENDPOINT_CHANGED" });
    expect(endpoint.calls).toEqual([]);
    const image = new FakeDocker();
    image.route(["inspect", ID], json(document({ Image: OTHER })));
    expect(restartOwnedContainer(expected(), binding(), image)).toEqual({ ok: false, reason: "IMAGE_MISMATCH" });
    expect(image.deleting()).toEqual([]);
    expect(image.calls).toEqual([["inspect", ID]]);
  });

  it("removes only the owned tag when that tag still resolves to the captured image", () => {
    const fake = new FakeDocker();
    fake.route(["image", "inspect", TAG], json(imageDocument()));
    fake.route(["rmi", TAG], { status: 0, stdout: "", stderr: "" });
    expect(releaseOwnedImage(binding(), TAG, IMAGE, fake)).toEqual({ removed: true, reason: "REMOVED" });
    expect(fake.deleting()).toEqual([["rmi", TAG]]);
    expect(fake.calls.some((args) => args.includes("-f") || args.includes(IMAGE) || args.includes("prune"))).toBe(false);
  });

  it("retains the image when the tag was replaced, the id differs, or another tag remains", () => {
    const replaced = new FakeDocker();
    replaced.route(["image", "inspect", TAG], json(imageDocument(OTHER)));
    expect(releaseOwnedImage(binding(), TAG, IMAGE, replaced)).toEqual({ removed: false, reason: "TAG_REPLACED" });
    const shared = new FakeDocker();
    shared.route(["image", "inspect", TAG], json(imageDocument(IMAGE, [`${TAG}:latest`, "foreign-owner:latest"])));
    expect(releaseOwnedImage(binding(), TAG, IMAGE, shared)).toEqual({ removed: false, reason: "IMAGE_SHARED" });
    expect(replaced.deleting()).toEqual([]);
    expect(shared.deleting()).toEqual([]);
  });

  it("does not touch a foreign container that only shares the run label", () => {
    const fake = new FakeDocker();
    const labeled = document({ Id: FOREIGN });
    fake.route(["inspect", ID], json(labeled));
    fake.route(["rm", "-f", FOREIGN], { status: 0, stdout: FOREIGN, stderr: "" });
    expect(restartOwnedContainer(expected(), binding(), fake)).toEqual({ ok: false, reason: "ID_MISMATCH" });
    expect(fake.calls).toEqual([["inspect", ID]]);
    expect(fake.calls.some((args) => args.includes("--filter") || args[0] === "ps" || args.includes(FOREIGN))).toBe(false);
  });

  it("stops after one failed image removal and leaves uncertain ownership untouched", () => {
    const failed = new FakeDocker();
    failed.route(["image", "inspect", TAG], json(imageDocument()));
    failed.route(["rmi", TAG], { status: 1, stdout: "", stderr: "busy" });
    expect(releaseOwnedImage(binding(), TAG, IMAGE, failed)).toEqual({ removed: false, reason: "REMOVAL_FAILED" });
    expect(failed.calls.filter((args) => args[0] === "rmi")).toHaveLength(1);
    const uncertain = new FakeDocker();
    expect(releaseOwnedImage(binding(), "stell22-app", IMAGE, uncertain)).toEqual({
      removed: false,
      reason: "IDENTITY_MISSING",
    });
    expect(uncertain.calls).toEqual([]);
    expect(uncertain.deleting()).toEqual([]);
  });

  it("does not exec or copy a container id other than the confirmed one", () => {
    const fake = new FakeDocker();
    fake.route(["inspect", ID], json(document()));
    expect(execOwned(expected(), binding(), [FOREIGN, "node", "probe"], fake)).toEqual({ ok: false, reason: "ID_MISMATCH" });
    expect(copyOwned(expected(), binding(), [`${FOREIGN}:/app/docker-entrypoint.sh`, "copy"], fake)).toEqual({
      ok: false,
      reason: "ID_MISMATCH",
    });
    expect(fake.calls).toEqual([]);
  });
});
