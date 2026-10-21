import { describe, expect, it } from "vitest";
import type { DockerWorld, ExecResult } from "@/server/internal/p1-write-freeze-proof/lifecycle";
import {
  releaseRehearsalResources,
  type RehearsalResources,
} from "@/server/internal/p1-disposable-release/rehearsal";

const RUN = "ab12cd34";
const DB = "a".repeat(64);
const NET = "c".repeat(64);
const DB_IMAGE = `sha256:${"1".repeat(64)}`;
const ENDPOINT = "npipe:////./pipe/docker_engine";
const DAEMON = "daemon-local-1";
const LABEL = "stell22.p1.disposable-release";

class FakeDocker implements DockerWorld {
  readonly calls: string[][] = [];
  private readonly routes = new Map<string, ExecResult>();

  route(args: readonly string[], result: ExecResult): void {
    this.routes.set(args.join("\0"), result);
  }

  endpoint(): string {
    return ENDPOINT;
  }

  daemonId(): string {
    return DAEMON;
  }

  exec(args: readonly string[]): ExecResult {
    const copy = [...args];
    this.calls.push(copy);
    return this.routes.get(copy.join("\0")) ?? { status: 1, stdout: "", stderr: "unhandled" };
  }

  destructive(): string[][] {
    return this.calls.filter((args) => args[0] === "rm" || args[0] === "rmi" || args[1] === "rm");
  }
}

function json(value: unknown): ExecResult {
  return { status: 0, stdout: JSON.stringify([value]), stderr: "" };
}

function resources(overrides: Partial<RehearsalResources> = {}): RehearsalResources {
  return {
    runId: RUN,
    binding: { endpoint: ENDPOINT, daemonId: DAEMON, runId: RUN },
    database: { id: DB, name: `p1as-db-${RUN}`, imageId: DB_IMAGE },
    application: null,
    volume: { name: `p1as-vol-${RUN}`, mountpoint: "/var/lib/docker/volumes/owned" },
    network: { id: NET, name: `p1as-net-${RUN}` },
    image: null,
    extraContainers: [],
    migrationRoot: null,
    preserveDatabase: false,
    sharedImage: false,
    ...overrides,
  };
}

function routeOwned(fake: FakeDocker, wanted: RehearsalResources): void {
  const database = wanted.database;
  if (database) {
    fake.route(
      ["inspect", database.id],
      json({
        Id: database.id,
        Name: `/${database.name}`,
        Image: database.imageId,
        Config: { Labels: { [LABEL]: RUN } },
      }),
    );
    fake.route(["rm", "-f", database.id], { status: 0, stdout: database.id, stderr: "" });
  }
  if (wanted.volume) {
    fake.route(
      ["volume", "inspect", wanted.volume.name],
      json({
        Name: wanted.volume.name,
        Mountpoint: wanted.volume.mountpoint,
        Labels: { [LABEL]: RUN },
      }),
    );
    fake.route(["volume", "rm", wanted.volume.name], {
      status: 0,
      stdout: wanted.volume.name,
      stderr: "",
    });
  }
  if (wanted.network) {
    fake.route(
      ["network", "inspect", wanted.network.id],
      json({
        Id: wanted.network.id,
        Name: wanted.network.name,
        Labels: { [LABEL]: RUN },
        Containers: {},
      }),
    );
    fake.route(["network", "rm", wanted.network.id], {
      status: 0,
      stdout: wanted.network.id,
      stderr: "",
    });
  }
}

describe("rehearsal cleanup report", () => {
  it("reports resources removed by an identity-bound cleanup", () => {
    const wanted = resources();
    const fake = new FakeDocker();
    routeOwned(fake, wanted);
    const report = releaseRehearsalResources(wanted, fake);
    expect(report.status).toBe("COMPLETE");
    expect(report.failures).toEqual([]);
    expect(report.removed).toEqual([`p1as-db-${RUN}`, `p1as-vol-${RUN}`, `p1as-net-${RUN}`]);
  });

  it("reports a removal failure and does not call that cleanup complete", () => {
    const wanted = resources({ volume: null, network: null });
    const fake = new FakeDocker();
    routeOwned(fake, wanted);
    fake.route(["rm", "-f", DB], { status: 1, stdout: "", stderr: "busy" });
    const report = releaseRehearsalResources(wanted, fake);
    expect(report.status).toBe("FAILED");
    expect(report.failures).toContainEqual({
      resource: `p1as-db-${RUN}`,
      reason: "REMOVAL_FAILED",
    });
    expect(report.removed).not.toContain(`p1as-db-${RUN}`);
  });

  it("preserves a foreign container instead of removing it", () => {
    const wanted = resources({
      database: { id: DB, name: "stell22-db", imageId: DB_IMAGE },
      volume: null,
      network: null,
    });
    const fake = new FakeDocker();
    fake.route(
      ["inspect", DB],
      json({
        Id: DB,
        Name: "/stell22-db",
        Image: DB_IMAGE,
        Config: { Labels: { [LABEL]: RUN } },
      }),
    );
    const report = releaseRehearsalResources(wanted, fake);
    expect(report.status).toBe("COMPLETE");
    expect(report.failures).toEqual([]);
    expect(report.removed).toEqual([]);
    expect(report.preserved).toContainEqual({ resource: "stell22-db", reason: "PRODUCTION_NAME" });
    expect(fake.destructive()).toEqual([]);
  });

  it("preserves an uncertain database and its migrate container on purpose", () => {
    const migrate = "e".repeat(64);
    const wanted = resources({
      preserveDatabase: true,
      extraContainers: [{ id: migrate, name: `p1as-p1-${RUN}`, imageId: DB_IMAGE }],
    });
    const fake = new FakeDocker();
    routeOwned(fake, wanted);
    const report = releaseRehearsalResources(wanted, fake);
    expect(report.status).toBe("COMPLETE");
    expect(report.failures).toEqual([]);
    expect(report.removed).toEqual([]);
    expect(report.preserved).toEqual(
      expect.arrayContaining([
        { resource: `p1as-db-${RUN}`, reason: "INTENTIONAL_PRESERVATION" },
        { resource: `p1as-vol-${RUN}`, reason: "INTENTIONAL_PRESERVATION" },
        { resource: `p1as-net-${RUN}`, reason: "INTENTIONAL_PRESERVATION" },
        { resource: `p1as-p1-${RUN}`, reason: "INTENTIONAL_PRESERVATION" },
      ]),
    );
    expect(fake.destructive()).toEqual([]);
  });
});
