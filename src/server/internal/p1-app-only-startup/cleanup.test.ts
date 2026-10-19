import { describe, expect, it } from "vitest";
import { releaseAppOnly, type AppOnlyRelease } from "@/server/internal/p1-app-only-startup/cleanup";
import type { DockerWorld, ExecResult } from "@/server/internal/p1-write-freeze-proof/lifecycle";

const RUN = "ab12cd34";
const DB = "a".repeat(64);
const APP = "b".repeat(64);
const NET = "c".repeat(64);
const FOREIGN = "d".repeat(64);
const DB_IMAGE = `sha256:${"1".repeat(64)}`;
const APP_IMAGE = `sha256:${"2".repeat(64)}`;
const ENDPOINT = "npipe:////./pipe/docker_engine";
const DAEMON = "daemon-local-1";
const LABEL = "stell22.p1.app-only-startup";

class FakeDocker implements DockerWorld {
  readonly calls: string[][] = [];
  endpointValue = ENDPOINT;
  daemonValue = DAEMON;
  private readonly routes = new Map<string, () => ExecResult>();

  route(args: readonly string[], result: ExecResult): void {
    this.routes.set(args.join("\0"), () => result);
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
    return this.routes.get(copy.join("\0"))?.() ?? { status: 1, stdout: "", stderr: "unhandled" };
  }

  destructive(): string[][] {
    return this.calls.filter((args) => args[0] === "rm" || args[0] === "rmi" || args[1] === "rm");
  }
}

function json(value: unknown): ExecResult {
  return { status: 0, stdout: JSON.stringify([value]), stderr: "" };
}

function input(overrides: Partial<AppOnlyRelease> = {}): AppOnlyRelease {
  return {
    binding: { endpoint: ENDPOINT, daemonId: DAEMON, runId: RUN },
    labelKey: LABEL,
    database: { id: DB, name: `p1as-db-${RUN}`, imageId: DB_IMAGE },
    application: { id: APP, name: `p1as-app-${RUN}`, imageId: APP_IMAGE },
    volume: { name: `p1as-vol-${RUN}`, mountpoint: "/var/lib/docker/volumes/owned" },
    network: { id: NET, name: `p1as-net-${RUN}` },
    image: { tag: `p1as-app:${RUN}`, id: APP_IMAGE },
    ...overrides,
  };
}

function container(id: string, name: string, imageId: string, labels: Record<string, string> = { [LABEL]: RUN }) {
  return { Id: id, Name: `/${name}`, Image: imageId, Config: { Labels: labels } };
}

describe("app-only disposable cleanup", () => {
  it("removes only the confirmed container ids, volume, network id, and image tag", () => {
    const wanted = input();
    const fake = new FakeDocker();
    fake.route(["inspect", APP], json(container(APP, wanted.application?.name ?? "", APP_IMAGE)));
    fake.route(["inspect", DB], json(container(DB, wanted.database?.name ?? "", DB_IMAGE)));
    fake.route(
      ["volume", "inspect", wanted.volume?.name ?? ""],
      json({ Name: wanted.volume?.name, Mountpoint: wanted.volume?.mountpoint, Labels: { [LABEL]: RUN } }),
    );
    fake.route(["network", "inspect", NET], json({ Id: NET, Name: wanted.network?.name, Labels: { [LABEL]: RUN }, Containers: {} }));
    fake.route(["image", "inspect", wanted.image?.tag ?? ""], json({ Id: APP_IMAGE, RepoTags: [wanted.image?.tag] }));
    fake.route(["rm", "-f", APP], { status: 0, stdout: APP, stderr: "" });
    fake.route(["rm", "-f", DB], { status: 0, stdout: DB, stderr: "" });
    fake.route(["volume", "rm", wanted.volume?.name ?? ""], { status: 0, stdout: wanted.volume?.name ?? "", stderr: "" });
    fake.route(["network", "rm", NET], { status: 0, stdout: NET, stderr: "" });
    fake.route(["rmi", wanted.image?.tag ?? ""], { status: 0, stdout: "untagged", stderr: "" });
    const report = releaseAppOnly(wanted, fake);
    expect(report.preserved).toEqual([]);
    expect(report.failures).toEqual([]);
    expect(fake.destructive().map((args) => args.join(" "))).toEqual([
      `rm -f ${APP}`,
      `rm -f ${DB}`,
      `volume rm ${wanted.volume?.name}`,
      `network rm ${NET}`,
      `rmi ${wanted.image?.tag}`,
    ]);
  });

  it("preserves an uncertain container and does not delete by name", () => {
    const fake = new FakeDocker();
    const report = releaseAppOnly(input({ application: { id: "not-an-id", name: `p1as-app-${RUN}`, imageId: APP_IMAGE } }), fake);
    expect(report.removed).toEqual([]);
    expect(fake.destructive()).toEqual([]);
  });

  it("does not remove an image tag when the build never returned an id", () => {
    const fake = new FakeDocker();
    releaseAppOnly(input({ application: null, database: null, volume: null, network: null, image: null }), fake);
    expect(fake.calls).toEqual([]);
  });

  it("does not remove a tag that points at a different image", () => {
    const wanted = input({ application: null, database: null, volume: null, network: null });
    const fake = new FakeDocker();
    fake.route(["image", "inspect", wanted.image?.tag ?? ""], json({ Id: `sha256:${"9".repeat(64)}`, RepoTags: [wanted.image?.tag] }));
    releaseAppOnly(wanted, fake);
    expect(fake.destructive()).toEqual([]);
  });

  it("does not remove a foreign volume, a foreign network attachment, or a drifted daemon", () => {
    const foreignVolume = new FakeDocker();
    const volume = input({ application: null, database: null, network: null, image: null });
    foreignVolume.route(
      ["volume", "inspect", volume.volume?.name ?? ""],
      json({ Name: volume.volume?.name, Mountpoint: volume.volume?.mountpoint, Labels: { [LABEL]: "other-run" } }),
    );
    releaseAppOnly(volume, foreignVolume);
    expect(foreignVolume.destructive()).toEqual([]);

    const foreignNetwork = new FakeDocker();
    const network = input({ application: null, database: null, volume: null, image: null });
    foreignNetwork.route(
      ["network", "inspect", NET],
      json({ Id: NET, Name: network.network?.name, Labels: { [LABEL]: RUN }, Containers: { [FOREIGN]: { Name: "other" } } }),
    );
    releaseAppOnly(network, foreignNetwork);
    expect(foreignNetwork.destructive()).toEqual([]);

    const drifted = new FakeDocker();
    drifted.daemonValue = "other-daemon";
    releaseAppOnly(input(), drifted);
    expect(drifted.destructive()).toEqual([]);
    drifted.endpointValue = "tcp://203.0.113.10:2375";
    drifted.daemonValue = DAEMON;
    releaseAppOnly(input(), drifted);
    expect(drifted.destructive()).toEqual([]);
  });

  it("does not remove a compose project or a production name", () => {
    const compose = new FakeDocker();
    const wanted = input({ database: null, volume: null, network: null, image: null });
    compose.route(
      ["inspect", APP],
      json(container(APP, wanted.application?.name ?? "", APP_IMAGE, { [LABEL]: RUN, "com.docker.compose.project": "stell22" })),
    );
    releaseAppOnly(wanted, compose);
    expect(compose.destructive()).toEqual([]);

    const production = new FakeDocker();
    const named = input({
      application: { id: APP, name: "stell22-app", imageId: APP_IMAGE },
      database: null,
      volume: null,
      network: null,
      image: null,
    });
    production.route(["inspect", APP], json(container(APP, "stell22-app", APP_IMAGE)));
    releaseAppOnly(named, production);
    expect(production.destructive()).toEqual([]);
  });
});
