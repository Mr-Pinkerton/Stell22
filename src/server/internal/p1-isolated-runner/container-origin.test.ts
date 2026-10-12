import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_LOCAL_DOCKER_ENDPOINTS,
  ContainerOriginRefusal,
  IMAGE_REPOSITORY_DIGEST_LIMITATION,
  OWNED_CONTAINER_LABEL,
  POSTGRES_IMAGE_REF,
  SQL_BINDING_PRECONDITIONS,
  createOwnedDisposableContainer,
  proveContainerOwnership,
  reconfirmOwnedContainer,
  removeOwnedDisposableContainer,
  resolveLocalDockerEndpoint,
  type OriginRuntime,
  type OwnedContainerHandle,
} from "@/server/internal/p1-isolated-runner/container-origin";

const RUN = "11111111-1111-4111-8111-111111111111";
const NAME = `stell22-p1-disposable-${RUN}`;
const ID = "a".repeat(64);
const OTHER_ID = "c".repeat(64);
const IMAGE_ID = `sha256:${"b".repeat(64)}`;
const OTHER_IMAGE = `sha256:${"d".repeat(64)}`;
const DAEMON = "daemon-local-1";
const STARTED = "2026-10-12T00:00:00.000000000Z";
const PORT = 54321;
const PASSWORD_MARK = "pw-secret-do-not-leak";
const NONCE_MARK = "nonce-secret-do-not-leak";

describe("disposable container ownership", () => {
  it("refuses a remote DOCKER_HOST before any docker command", () => {
    const runtime = scripted();
    runtime.env = { DOCKER_HOST: "tcp://10.1.2.3:2376" };
    expect(code(() => resolveLocalDockerEndpoint(runtime))).toBe("DOCKER_ENDPOINT_REMOTE");
    expect(code(() => createOwnedDisposableContainer(runtime))).toBe("DOCKER_ENDPOINT_REMOTE");
    expect(runtime.commands).toEqual([]);
  });

  it("refuses an ssh DOCKER_HOST override before any docker command", () => {
    const runtime = scripted();
    runtime.env = { DOCKER_HOST: "ssh://operator@db.internal" };
    expect(code(() => createOwnedDisposableContainer(runtime))).toBe("DOCKER_ENDPOINT_REMOTE");
    expect(runtime.commands).toEqual([]);
  });

  it("refuses a custom context whose endpoint is remote", () => {
    const runtime = scripted();
    runtime.env = { DOCKER_CONTEXT: "remote-prod", DOCKER_CONFIG: runtime.homedir };
    runtime.files.set(
      metaPath(runtime.homedir, "remote-prod"),
      JSON.stringify({
        Name: "remote-prod",
        Endpoints: { docker: { Host: "tcp://10.0.0.8:2376" } },
      }),
    );
    expect(code(() => createOwnedDisposableContainer(runtime))).toBe("DOCKER_ENDPOINT_REMOTE");
    expect(runtime.commands).toEqual([]);
  });

  it("fails closed when a named context has no readable endpoint", () => {
    const runtime = scripted();
    runtime.env = { DOCKER_CONTEXT: "mystery", DOCKER_CONFIG: runtime.homedir };
    expect(code(() => resolveLocalDockerEndpoint(runtime))).toBe("DOCKER_ENDPOINT_UNDETERMINED");
    expect(runtime.commands).toEqual([]);
  });

  it("fails closed when Docker config is malformed", () => {
    const runtime = scripted();
    runtime.env = { DOCKER_CONFIG: runtime.homedir };
    runtime.files.set(path.join(runtime.homedir, "config.json"), "{");
    expect(code(() => resolveLocalDockerEndpoint(runtime))).toBe("DOCKER_ENDPOINT_UNDETERMINED");
  });

  it("accepts only a documented local socket and then requires the daemon", () => {
    const runtime = scripted();
    runtime.env = { DOCKER_HOST: "unix:///var/run/docker.sock" };
    expect(resolveLocalDockerEndpoint(runtime)).toBe("unix:///var/run/docker.sock");
    runtime.execFileSync = () => {
      throw new Error("docker offline");
    };
    expect(code(() => createOwnedDisposableContainer(runtime))).toBe("DOCKER_UNAVAILABLE");
    expect(runtime.commands.some((command) => command.args[0] === "run")).toBe(false);
  });

  it("uses the desktop-linux context endpoint only when that endpoint is the local pipe", () => {
    const runtime = scripted();
    runtime.platform = "win32";
    runtime.env = { DOCKER_CONFIG: runtime.homedir };
    runtime.files.set(
      path.join(runtime.homedir, "config.json"),
      JSON.stringify({ currentContext: "desktop-linux" }),
    );
    runtime.files.set(
      metaPath(runtime.homedir, "desktop-linux"),
      JSON.stringify({
        Name: "desktop-linux",
        Endpoints: { docker: { Host: "npipe:////./pipe/dockerDesktopLinuxEngine" } },
      }),
    );
    expect(resolveLocalDockerEndpoint(runtime)).toBe("npipe:////./pipe/dockerDesktopLinuxEngine");
    expect(createHash("sha256").update("desktop-linux").digest("hex")).toBe(
      "fe9c6bd7a66301f49ca9b6a70b217107cd1284598bfc254700c989b916da791e",
    );
  });

  it("does not establish ownership when the daemon identity changes", () => {
    const runtime = scripted();
    runtime.daemonIds = [DAEMON, "daemon-local-2"];
    expect(code(() => createOwnedDisposableContainer(runtime))).toBe("DAEMON_IDENTITY_CHANGED");
    expect(runtime.commands.some((command) => command.args[0] === "run")).toBe(false);
  });

  it("does not establish ownership when inspect returns a different container id", () => {
    const runtime = scripted();
    runtime.inspectId = OTHER_ID;
    expect(code(() => createOwnedDisposableContainer(runtime))).toBe("INSPECT_ID_MISMATCH");
    expect(runtime.commands.some((command) => command.args[0] === "rm")).toBe(false);
    expect(sqlOrMigration(runtime)).toBe(false);
  });

  it("refuses a forged container id supplied to the prover", () => {
    const proof = proveContainerOwnership(expectation({ creationId: OTHER_ID }));
    expect(proof).toEqual({ ok: false, code: "INSPECT_ID_MISMATCH" });
  });

  it("refuses the wrong name, run label, image, stopped state, and restart", () => {
    expect(proveContainerOwnership(expectation({ expectedName: "stell22-db-prod" })).ok).toBe(
      false,
    );
    expect(proveContainerOwnership(expectation({ expectedName: "stell22-db-prod" }))).toMatchObject(
      {
        code: "NAME_MISMATCH",
      },
    );
    expect(
      proveContainerOwnership(
        expectation({
          inspectDocument: document((row) => {
            row.Config = {
              Image: POSTGRES_IMAGE_REF,
              Labels: { [OWNED_CONTAINER_LABEL]: "22222222-2222-4222-8222-222222222222" },
            };
          }),
        }),
      ),
    ).toMatchObject({ code: "LABEL_MISMATCH" });
    expect(proveContainerOwnership(expectation({ expectedImageId: OTHER_IMAGE }))).toMatchObject({
      code: "IMAGE_ID_UNEXPECTED",
    });
    expect(
      proveContainerOwnership(
        expectation({
          inspectDocument: document((row) => {
            row.State = { Running: false, Status: "exited", StartedAt: STARTED, Pid: 0 };
          }),
        }),
      ),
    ).toMatchObject({ code: "CONTAINER_STOPPED" });
    expect(
      proveContainerOwnership(
        expectation({
          expectedStartedAt: "2026-10-12T00:00:01.000000000Z",
          expectedPid: 4242,
        }),
      ),
    ).toMatchObject({ code: "CONTAINER_RESTARTED" });
  });

  it("refuses wildcard, missing, and conflicting port mappings", () => {
    expect(
      proveContainerOwnership(
        expectation({
          inspectDocument: document((row) => {
            row.HostConfig = {
              NetworkMode: "bridge",
              PortBindings: { "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "" }] },
            };
            row.NetworkSettings = {
              Ports: { "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "54321" }] },
            };
          }),
        }),
      ),
    ).toMatchObject({ code: "PORT_NOT_LOOPBACK" });
    expect(
      proveContainerOwnership(
        expectation({
          inspectDocument: document((row) => {
            row.NetworkSettings = { Ports: {} };
          }),
        }),
      ),
    ).toMatchObject({ code: "PORT_MAPPING_MISMATCH" });
    expect(
      proveContainerOwnership(
        expectation({
          inspectDocument: document((row) => {
            row.HostConfig = {
              NetworkMode: "bridge",
              PortBindings: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "54329" }] },
            };
          }),
        }),
      ),
    ).toMatchObject({ code: "PORT_MAPPING_MISMATCH" });
  });

  it("refuses a disappeared container and a later port change", () => {
    expect(proveContainerOwnership(expectation({ inspectDocument: [] }))).toMatchObject({
      code: "CONTAINER_DISAPPEARED",
    });
    expect(proveContainerOwnership(expectation({ expectedPort: 54329 }))).toMatchObject({
      code: "PORT_CHANGED",
    });
  });

  it("does not treat an injected inspect document as a live Docker success", () => {
    const proof = proveContainerOwnership(expectation());
    expect(proof.ok).toBe(true);
    if (!proof.ok) return;
    expect(proof.host).toBe("127.0.0.1");
    expect(proof.port).toBe(PORT);
    expect(proof.imageId).toBe(IMAGE_ID);
    expect(SQL_BINDING_PRECONDITIONS.join(" ")).toContain("SQL proof");
  });

  it("creates a handle only from the id docker run returned", () => {
    const runtime = scripted();
    const handle = createOwnedDisposableContainer(runtime);
    expect(handle.containerId).toBe(ID);
    expect(handle.endpoint).toBe("npipe:////./pipe/docker_engine");
    expect(handle.repositoryDigestStatus).toBe("UNAVAILABLE");
    expect(handle.repositoryDigestLimitation).toBe(IMAGE_REPOSITORY_DIGEST_LIMITATION);
    expect(handle.repositoryDigests).toEqual([]);
    expect(runtime.commands.some((command) => command.args[0] === "pull")).toBe(false);
    const run = runtime.commands.find((command) => command.args[0] === "run");
    expect(run?.args).toContain("--pull");
    expect(run?.args).toContain("never");
    expect(run?.args.at(-1)).toBe(POSTGRES_IMAGE_REF);
    expect(run?.command).toBe("docker");
    const connection = reconfirmOwnedContainer(handle, runtime);
    expect(connection).toMatchObject({
      host: "127.0.0.1",
      port: PORT,
      user: "p1disp",
      containerId: ID,
      runId: handle.runId,
    });
    expect(connection.password).toBe(handle.password);
    expect(connection.nonce).toBe(handle.nonce);
  });

  it("records repository digests when the image inspect provides them", () => {
    const runtime = scripted();
    runtime.repoDigests = ["postgres@sha256:" + "e".repeat(64)];
    const handle = createOwnedDisposableContainer(runtime);
    expect(handle.repositoryDigestStatus).toBe("RECORDED");
    expect(handle.repositoryDigestLimitation).toBeNull();
    expect(handle.repositoryDigests).toEqual(runtime.repoDigests);
  });

  it("refuses cleanup when ownership cannot be reconfirmed and does not delete", () => {
    const runtime = scripted();
    const handle = createOwnedDisposableContainer(runtime);
    runtime.commands.length = 0;
    runtime.inspectId = OTHER_ID;
    expect(code(() => removeOwnedDisposableContainer(handle, runtime))).toBe("CLEANUP_REFUSED");
    expect(runtime.commands.some((command) => command.args[0] === "rm")).toBe(false);
    expect(runtime.commands.some((command) => command.args.includes("prune"))).toBe(false);
  });

  it("refuses a forged handle and a broad deletion request", () => {
    const runtime = scripted();
    expect(
      code(() =>
        removeOwnedDisposableContainer({ containerId: ID } as OwnedContainerHandle, runtime),
      ),
    ).toBe("OWNERSHIP_UNPROVEN");
    expect(runtime.commands).toEqual([]);
    const handle = createOwnedDisposableContainer(runtime);
    runtime.commands.length = 0;
    removeOwnedDisposableContainer(handle, runtime);
    const removal = runtime.commands.filter((command) => command.args[0] === "rm");
    expect(removal).toEqual([{ command: "docker", args: ["rm", "-f", ID] }]);
    expect(removal[0]?.args).not.toContain(NAME);
  });

  it("does not remove a container after the daemon or endpoint changes", () => {
    const runtime = scripted();
    const handle = createOwnedDisposableContainer(runtime);
    runtime.daemonId = "daemon-local-2";
    runtime.daemonIds = [];
    expect(code(() => reconfirmOwnedContainer(handle, runtime))).toBe("DAEMON_IDENTITY_CHANGED");
    expect(code(() => removeOwnedDisposableContainer(handle, runtime))).toBe("CLEANUP_REFUSED");
    runtime.env = { DOCKER_HOST: "tcp://127.0.0.1:2375" };
    expect(code(() => removeOwnedDisposableContainer(handle, runtime))).toBe("CLEANUP_REFUSED");
    expect(runtime.commands.some((command) => command.args[0] === "rm")).toBe(false);
  });

  it("does not copy docker errors that contain the generated password", () => {
    const runtime = scripted();
    runtime.failInspectWithSecrets = true;
    let refusal: ContainerOriginRefusal | undefined;
    try {
      createOwnedDisposableContainer(runtime);
    } catch (error) {
      expect(error).toBeInstanceOf(ContainerOriginRefusal);
      refusal = error as ContainerOriginRefusal;
    }
    expect(refusal?.code).toBe("OWNERSHIP_UNPROVEN");
    expect(refusal?.message.includes(PASSWORD_MARK)).toBe(false);
    expect(refusal?.message.includes(NONCE_MARK)).toBe(false);
    expect(runtime.commands.some((command) => command.args[0] === "rm")).toBe(false);
  });

  it("reports removal failure instead of hiding it", () => {
    const runtime = scripted();
    const handle = createOwnedDisposableContainer(runtime);
    runtime.failRemoval = true;
    expect(code(() => removeOwnedDisposableContainer(handle, runtime))).toBe("CLEANUP_FAILED");
  });

  it("does not authorize migration or apply from this module", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src/server/internal/p1-isolated-runner/container-origin.ts"),
      "utf8",
    );
    expect(source.includes("executeDisposableApply")).toBe(false);
    expect(source.includes("prisma")).toBe(false);
    expect(source.includes("prune")).toBe(false);
    expect(source.includes("$executeRaw")).toBe(false);
    expect(source.includes("migration.sql")).toBe(false);
    expect(ALLOWED_LOCAL_DOCKER_ENDPOINTS).not.toContain("tcp://127.0.0.1:2375");
  });
});

function code(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ContainerOriginRefusal);
    return (error as ContainerOriginRefusal).code;
  }
  throw new Error("expected refusal");
}

function expectation(
  patch: Partial<Parameters<typeof proveContainerOwnership>[0]> = {},
): Parameters<typeof proveContainerOwnership>[0] {
  return {
    creationId: ID,
    expectedName: NAME,
    expectedRunId: RUN,
    expectedImageId: IMAGE_ID,
    expectedDaemonId: DAEMON,
    observedDaemonId: DAEMON,
    expectedStartedAt: null,
    expectedPid: null,
    expectedPort: null,
    inspectDocument: document(),
    ...patch,
  };
}

function document(patch?: (row: Record<string, unknown>) => void): unknown {
  const row: Record<string, unknown> = {
    Id: ID,
    Name: `/${NAME}`,
    Image: IMAGE_ID,
    Config: {
      Image: POSTGRES_IMAGE_REF,
      Labels: { [OWNED_CONTAINER_LABEL]: RUN },
    },
    State: { Running: true, Status: "running", StartedAt: STARTED, Pid: 4242 },
    HostConfig: {
      NetworkMode: "bridge",
      PortBindings: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] },
    },
    NetworkSettings: {
      Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: String(PORT) }] },
    },
  };
  patch?.(row);
  return [row];
}

function metaPath(configDir: string, contextName: string): string {
  const digest = createHash("sha256").update(contextName).digest("hex");
  return path.join(configDir, "contexts", "meta", digest, "meta.json");
}

function sqlOrMigration(runtime: ScriptedRuntime): boolean {
  return runtime.commands.some((command) =>
    command.args.some((arg) => /psql|prisma|migrate|INSERT|CREATE/i.test(arg)),
  );
}

type ScriptedRuntime = OriginRuntime & {
  commands: { command: string; args: readonly string[] }[];
  files: Map<string, string>;
  daemonIds: string[];
  daemonId: string;
  inspectId: string;
  repoDigests: string[] | null;
  failInspectWithSecrets: boolean;
  failRemoval: boolean;
};

function scripted(): ScriptedRuntime {
  const runtime = {
    platform: "win32" as NodeJS.Platform,
    env: {} as Record<string, string | undefined>,
    homedir: path.join("K:", "docker-config"),
    files: new Map<string, string>(),
    commands: [] as { command: string; args: readonly string[] }[],
    daemonIds: [DAEMON],
    daemonId: DAEMON,
    inspectId: ID,
    repoDigests: null as string[] | null,
    failInspectWithSecrets: false,
    failRemoval: false,
    randomUUID: () => RUN,
    randomBytes: (size: number) => {
      const mark = runtime.commands.some((command) => command.args[0] === "run")
        ? NONCE_MARK
        : PASSWORD_MARK;
      return Buffer.from(mark.padEnd(size, "x").slice(0, size));
    },
    readFile: (filePath: string) => {
      const contents = runtime.files.get(filePath);
      if (contents === undefined) {
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return contents;
    },
    execFileSync: (command: string, args: readonly string[]) => {
      runtime.commands.push({ command, args });
      if (command !== "docker") throw new Error("unexpected command");
      if (args[0] === "info") {
        const next = runtime.daemonIds.shift();
        if (next !== undefined) runtime.daemonId = next;
        return `${runtime.daemonId}\n`;
      }
      if (args[0] === "image" && args[1] === "inspect") {
        return JSON.stringify([
          {
            Id: IMAGE_ID,
            RepoDigests: runtime.repoDigests,
          },
        ]);
      }
      if (args[0] === "run") return `${ID}\n`;
      if (args[0] === "inspect") {
        if (runtime.failInspectWithSecrets) {
          const password = args.join(" ");
          throw new Error(`backend ${PASSWORD_MARK} ${password} ${NONCE_MARK}`);
        }
        return JSON.stringify(
          document((row) => {
            row.Id = runtime.inspectId;
          }),
        );
      }
      if (args[0] === "rm") {
        if (runtime.failRemoval) throw new Error(`rm failed ${PASSWORD_MARK}`);
        return ID;
      }
      throw new Error(`unexpected docker args ${args[0] ?? ""}`);
    },
  };
  return runtime;
}
