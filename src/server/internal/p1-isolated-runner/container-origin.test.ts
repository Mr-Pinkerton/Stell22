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
    runtime.execFileSync = (
      command: string,
      args: readonly string[],
      env: Readonly<Record<string, string | undefined>>,
    ) => {
      runtime.commands.push({ command, args, env });
      throw new Error("docker offline");
    };
    expect(code(() => createOwnedDisposableContainer(runtime))).toBe("DOCKER_UNAVAILABLE");
    expect(runtime.commands.some((command) => verb(command.args) === "run")).toBe(false);
    assertPinned(runtime, UNIX_SOCKET);
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
    expect(runtime.commands.some((command) => verb(command.args) === "run")).toBe(false);
  });

  it("does not establish ownership when inspect returns a different container id", () => {
    const runtime = scripted();
    runtime.inspectId = OTHER_ID;
    expect(code(() => createOwnedDisposableContainer(runtime))).toBe("INSPECT_ID_MISMATCH");
    expect(runtime.commands.some((command) => verb(command.args) === "rm")).toBe(false);
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
    expect(runtime.commands.some((command) => verb(command.args) === "pull")).toBe(false);
    const run = runtime.commands.find((command) => verb(command.args) === "run");
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
    const refused = caught(() => removeOwnedDisposableContainer(handle, runtime));
    expect(refused.code).toBe("INSPECT_ID_MISMATCH");
    expect(refused.disposition).toEqual({
      kind: "orphaned",
      containerId: ID,
      cleanup: "refused",
    });
    expect(runtime.commands.some((command) => verb(command.args) === "rm")).toBe(false);
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
    const removal = runtime.commands.filter((command) => verb(command.args) === "rm");
    expect(removal).toHaveLength(1);
    expect(removal[0]?.args).toEqual(["-H", "npipe:////./pipe/docker_engine", "rm", "-f", ID]);
    expect(removal[0]?.env.DOCKER_HOST).toBe("npipe:////./pipe/docker_engine");
    expect(removal[0]?.env.DOCKER_CONTEXT).toBeUndefined();
    expect(removal[0]?.args).not.toContain("--context");
    expect(removal[0]?.args).not.toContain(NAME);
  });

  it("does not remove a container after the daemon or endpoint changes", () => {
    const runtime = scripted();
    const handle = createOwnedDisposableContainer(runtime);
    runtime.daemonId = "daemon-local-2";
    runtime.daemonIds = [];
    expect(code(() => reconfirmOwnedContainer(handle, runtime))).toBe("DAEMON_IDENTITY_CHANGED");
    expect(caught(() => removeOwnedDisposableContainer(handle, runtime)).disposition).toEqual({
      kind: "orphaned",
      containerId: ID,
      cleanup: "refused",
    });
    runtime.env = { DOCKER_HOST: "tcp://127.0.0.1:2375" };
    expect(code(() => removeOwnedDisposableContainer(handle, runtime))).toBe(
      "DOCKER_ENDPOINT_REMOTE",
    );
    expect(runtime.commands.some((command) => verb(command.args) === "rm")).toBe(false);
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
    expect(runtime.commands.some((command) => verb(command.args) === "rm")).toBe(false);
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

  it("fails closed before Docker when DOCKER_HOST is local and DOCKER_CONTEXT is remote", () => {
    const runtime = ambiguous("unix:///var/run/docker.sock", "remote-prod");
    expect(code(() => createOwnedDisposableContainer(runtime))).toBe("DOCKER_ENDPOINT_AMBIGUOUS");
    expect(runtime.commands).toEqual([]);
  });

  it("fails closed before Docker when DOCKER_HOST is remote and DOCKER_CONTEXT is local", () => {
    const runtime = ambiguous("tcp://10.1.2.3:2376", "desktop-linux");
    expect(code(() => createOwnedDisposableContainer(runtime))).toBe("DOCKER_ENDPOINT_AMBIGUOUS");
    expect(runtime.commands).toEqual([]);
  });

  it("fails closed before Docker when both endpoint variables are local", () => {
    const runtime = ambiguous(UNIX_SOCKET, "desktop-linux");
    expect(code(() => createOwnedDisposableContainer(runtime))).toBe("DOCKER_ENDPOINT_AMBIGUOUS");
    expect(runtime.commands).toEqual([]);
  });

  it("refuses a remote context without a local host override", () => {
    const runtime = scripted();
    runtime.env = { DOCKER_CONTEXT: "remote-prod", DOCKER_CONFIG: runtime.homedir };
    runtime.files.set(
      metaPath(runtime.homedir, "remote-prod"),
      JSON.stringify({
        Name: "remote-prod",
        Endpoints: { docker: { Host: "tcp://10.9.8.7:2376" } },
      }),
    );
    expect(code(() => createOwnedDisposableContainer(runtime))).toBe("DOCKER_ENDPOINT_REMOTE");
    expect(runtime.commands).toEqual([]);
  });

  it("refuses a remote host without a context", () => {
    const runtime = scripted();
    runtime.env = { DOCKER_HOST: "tcp://192.0.2.10:2375" };
    expect(code(() => createOwnedDisposableContainer(runtime))).toBe("DOCKER_ENDPOINT_REMOTE");
    expect(runtime.commands).toEqual([]);
  });

  it("pins every command to the desktop-linux local pipe", () => {
    const runtime = scripted();
    runtime.platform = "win32";
    runtime.env = { DOCKER_CONTEXT: "desktop-linux", DOCKER_CONFIG: runtime.homedir };
    runtime.files.set(
      metaPath(runtime.homedir, "desktop-linux"),
      JSON.stringify({
        Name: "desktop-linux",
        Endpoints: { docker: { Host: DESKTOP_PIPE } },
      }),
    );
    const handle = createOwnedDisposableContainer(runtime);
    expect(handle.endpoint).toBe(DESKTOP_PIPE);
    assertPinned(runtime, DESKTOP_PIPE);
    const verbs = runtime.commands.map((command) => verb(command.args));
    expect(verbs).toEqual(["info", "image", "info", "run", "info", "inspect", "info"]);
  });

  it("pins every command to the unix socket", () => {
    const runtime = scripted();
    runtime.platform = "linux";
    runtime.env = {
      DOCKER_HOST: UNIX_SOCKET,
      DOCKER_TLS_VERIFY: "1",
      DOCKER_CERT_PATH: "/tmp/certs",
    };
    const handle = createOwnedDisposableContainer(runtime);
    expect(handle.endpoint).toBe(UNIX_SOCKET);
    assertPinned(runtime, UNIX_SOCKET);
  });

  it("detects an endpoint change after creation and does not continue on the new endpoint", () => {
    const runtime = scripted();
    const handle = createOwnedDisposableContainer(runtime);
    runtime.commands.length = 0;
    runtime.env = { DOCKER_HOST: UNIX_SOCKET };
    const error = caught(() => reconfirmOwnedContainer(handle, runtime));
    expect(error.code).toBe("DOCKER_ENDPOINT_CHANGED");
    expect(error.disposition.kind).toBe("not-created");
    expect(runtime.commands).toEqual([]);
  });

  it("refuses cleanup when the endpoint changes and does not call docker", () => {
    const runtime = scripted();
    const handle = createOwnedDisposableContainer(runtime);
    runtime.commands.length = 0;
    runtime.env = { DOCKER_HOST: DESKTOP_PIPE };
    const error = caught(() => removeOwnedDisposableContainer(handle, runtime));
    expect(error.code).toBe("DOCKER_ENDPOINT_CHANGED");
    expect(error.disposition).toEqual({ kind: "orphaned", containerId: ID, cleanup: "refused" });
    expect(runtime.commands).toEqual([]);
  });

  it("detects a daemon identity change on the pinned endpoint", () => {
    const runtime = scripted();
    runtime.daemonIds = [DAEMON, DAEMON, "daemon-local-2"];
    const error = caught(() => createOwnedDisposableContainer(runtime));
    expect(error.code).toBe("DAEMON_IDENTITY_CHANGED");
    expect(error.disposition).toEqual({ kind: "orphaned", containerId: ID, cleanup: "refused" });
    expect(runtime.commands.some((command) => verb(command.args) === "rm")).toBe(false);
    assertPinned(runtime, WIN_PIPE);
  });

  it("treats a failed run without an id as ambiguous and does not search for it", () => {
    const runtime = scripted();
    runtime.failRun = true;
    const error = caught(() => createOwnedDisposableContainer(runtime));
    expect(error.code).toBe("CONTAINER_CREATE_FAILED");
    expect(error.disposition).toEqual({ kind: "ambiguous" });
    expect(error.message.includes(PASSWORD_MARK)).toBe(false);
    expect(runtime.commands.some((command) => verb(command.args) === "inspect")).toBe(false);
    expect(runtime.commands.some((command) => verb(command.args) === "rm")).toBe(false);
  });

  it("treats a malformed creation id as ambiguous and does not delete", () => {
    const runtime = scripted();
    runtime.runStdout = "short-id\n";
    const error = caught(() => createOwnedDisposableContainer(runtime));
    expect(error.code).toBe("CONTAINER_ID_UNPROVEN");
    expect(error.disposition).toEqual({ kind: "ambiguous" });
    expect(runtime.commands.some((command) => verb(command.args) === "rm")).toBe(false);
    expect(runtime.commands.some((command) => verb(command.args) === "inspect")).toBe(false);
  });

  it("keeps the original failure when inspect throws and refuses an unproven cleanup", () => {
    const runtime = scripted();
    runtime.failInspectWithSecrets = true;
    const error = caught(() => createOwnedDisposableContainer(runtime));
    expect(error.code).toBe("OWNERSHIP_UNPROVEN");
    expect(error.disposition).toEqual({ kind: "orphaned", containerId: ID, cleanup: "refused" });
    expect(JSON.stringify(error.disposition).includes(PASSWORD_MARK)).toBe(false);
    expect(error.message.includes(NONCE_MARK)).toBe(false);
    expect(runtime.commands.some((command) => verb(command.args) === "rm")).toBe(false);
  });

  it("removes only the exact id when a later inspect reconfirms ownership", () => {
    const runtime = scripted();
    runtime.inspectFailuresRemaining = 1;
    const error = caught(() => createOwnedDisposableContainer(runtime));
    expect(error.code).toBe("OWNERSHIP_UNPROVEN");
    expect(error.disposition).toEqual({ kind: "removed", containerId: ID });
    const removal = runtime.commands.filter((command) => verb(command.args) === "rm");
    expect(removal).toHaveLength(1);
    expect(removal[0]?.args).toEqual(["-H", WIN_PIPE, "rm", "-f", ID]);
    assertPinned(runtime, WIN_PIPE);
  });

  it("preserves the original failure when exact-id cleanup itself fails", () => {
    const runtime = scripted();
    runtime.inspectFailuresRemaining = 1;
    runtime.failRemoval = true;
    const error = caught(() => createOwnedDisposableContainer(runtime));
    expect(error.code).toBe("OWNERSHIP_UNPROVEN");
    expect(error.disposition).toEqual({ kind: "orphaned", containerId: ID, cleanup: "failed" });
    expect(error.message.includes(PASSWORD_MARK)).toBe(false);
  });

  it("refuses deletion when inspect returns the wrong id, name, label, image, or a stopped container", () => {
    const cases: Array<{
      mutate: (row: Record<string, unknown>) => void;
      code: string;
    }> = [
      {
        mutate: (row) => {
          row.Id = OTHER_ID;
        },
        code: "INSPECT_ID_MISMATCH",
      },
      {
        mutate: (row) => {
          row.Name = "/stell22-db-prod";
        },
        code: "NAME_MISMATCH",
      },
      {
        mutate: (row) => {
          row.Config = {
            Image: POSTGRES_IMAGE_REF,
            Labels: { [OWNED_CONTAINER_LABEL]: RUN + "x" },
          };
        },
        code: "LABEL_MISMATCH",
      },
      {
        mutate: (row) => {
          row.Image = OTHER_IMAGE;
        },
        code: "IMAGE_ID_UNEXPECTED",
      },
      {
        mutate: (row) => {
          row.State = { Running: false, Status: "exited", StartedAt: STARTED, Pid: 0 };
        },
        code: "CONTAINER_STOPPED",
      },
    ];
    for (const item of cases) {
      const runtime = scripted();
      runtime.inspectMutator = item.mutate;
      const error = caught(() => createOwnedDisposableContainer(runtime));
      expect(error.code).toBe(item.code);
      expect(error.disposition).toEqual({ kind: "orphaned", containerId: ID, cleanup: "refused" });
      expect(runtime.commands.some((command) => verb(command.args) === "rm")).toBe(false);
      expect(runtime.commands.some((command) => command.args.includes("prune"))).toBe(false);
    }
  });

  it("refuses cleanup of an unowned id without a broad removal", () => {
    const runtime = scripted();
    const handle = createOwnedDisposableContainer(runtime);
    runtime.commands.length = 0;
    runtime.inspectMutator = (row) => {
      row.Name = "/someone-else";
    };
    const error = caught(() => removeOwnedDisposableContainer(handle, runtime));
    expect(error.code).toBe("NAME_MISMATCH");
    expect(error.disposition).toEqual({ kind: "orphaned", containerId: ID, cleanup: "refused" });
    expect(runtime.commands.some((command) => verb(command.args) === "rm")).toBe(false);
  });
});

function ambiguous(host: string, contextName: string): ScriptedRuntime {
  const runtime = scripted();
  runtime.env = { DOCKER_HOST: host, DOCKER_CONTEXT: contextName, DOCKER_CONFIG: runtime.homedir };
  runtime.files.set(
    metaPath(runtime.homedir, contextName),
    JSON.stringify({
      Name: contextName,
      Endpoints: {
        docker: { Host: host.startsWith("tcp://") ? UNIX_SOCKET : "tcp://10.2.3.4:2376" },
      },
    }),
  );
  return runtime;
}

function code(run: () => unknown): string {
  return caught(run).code;
}

function caught(run: () => unknown): ContainerOriginRefusal {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ContainerOriginRefusal);
    return error as ContainerOriginRefusal;
  }
  throw new Error("expected refusal");
}

function verb(args: readonly string[]): string {
  return args[0] === "-H" ? (args[2] ?? "") : (args[0] ?? "");
}

const WIN_PIPE = "npipe:////./pipe/docker_engine";
const DESKTOP_PIPE = "npipe:////./pipe/dockerDesktopLinuxEngine";
const UNIX_SOCKET = "unix:///var/run/docker.sock";

function assertPinned(runtime: ScriptedRuntime, endpoint: string): void {
  expect(runtime.commands.length).toBeGreaterThan(0);
  for (const command of runtime.commands) {
    expect(command.command).toBe("docker");
    expect(command.args.slice(0, 2)).toEqual(["-H", endpoint]);
    expect(command.args).not.toContain("--context");
    expect(command.env.DOCKER_HOST).toBe(endpoint);
    expect(command.env.DOCKER_CONTEXT).toBeUndefined();
    expect(command.env.DOCKER_TLS).toBeUndefined();
    expect(command.env.DOCKER_TLS_VERIFY).toBeUndefined();
    expect(command.env.DOCKER_CERT_PATH).toBeUndefined();
  }
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

type ScriptedCommand = {
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
};

type ScriptedRuntime = OriginRuntime & {
  commands: ScriptedCommand[];
  files: Map<string, string>;
  daemonIds: string[];
  daemonId: string;
  inspectId: string;
  repoDigests: string[] | null;
  failInspectWithSecrets: boolean;
  failRemoval: boolean;
  failRun: boolean;
  runStdout: string;
  inspectFailuresRemaining: number;
  inspectMutator: ((row: Record<string, unknown>) => void) | null;
};

function scripted(): ScriptedRuntime {
  const runtime = {
    platform: "win32" as NodeJS.Platform,
    env: {} as Record<string, string | undefined>,
    homedir: path.join("K:", "docker-config"),
    files: new Map<string, string>(),
    commands: [] as ScriptedCommand[],
    daemonIds: [DAEMON],
    daemonId: DAEMON,
    inspectId: ID,
    repoDigests: null as string[] | null,
    failInspectWithSecrets: false,
    failRemoval: false,
    failRun: false,
    runStdout: `${ID}\n`,
    inspectFailuresRemaining: 0,
    inspectMutator: null as ((row: Record<string, unknown>) => void) | null,
    randomUUID: () => RUN,
    randomBytes: (size: number) => {
      const mark = runtime.commands.some((command) => verb(command.args) === "run")
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
    execFileSync: (
      command: string,
      args: readonly string[],
      env: Readonly<Record<string, string | undefined>>,
    ) => {
      runtime.commands.push({ command, args, env });
      if (command !== "docker" || args[0] !== "-H" || args.length < 3) {
        throw new Error("unpinned docker command");
      }
      const action = args[2];
      if (action === "info") {
        const next = runtime.daemonIds.shift();
        if (next !== undefined) runtime.daemonId = next;
        return `${runtime.daemonId}\n`;
      }
      if (action === "image" && args[3] === "inspect") {
        return JSON.stringify([
          {
            Id: IMAGE_ID,
            RepoDigests: runtime.repoDigests,
          },
        ]);
      }
      if (action === "run") {
        if (runtime.failRun) throw new Error(`run failed ${PASSWORD_MARK}`);
        return runtime.runStdout;
      }
      if (action === "inspect") {
        if (runtime.failInspectWithSecrets) {
          throw new Error(`backend ${PASSWORD_MARK} ${args.join(" ")} ${NONCE_MARK}`);
        }
        if (runtime.inspectFailuresRemaining > 0) {
          runtime.inspectFailuresRemaining -= 1;
          throw new Error("inspect unavailable");
        }
        return JSON.stringify(
          document((row) => {
            row.Id = runtime.inspectId;
            runtime.inspectMutator?.(row);
          }),
        );
      }
      if (action === "rm") {
        if (args[3] !== "-f" || args[4] !== ID || args.length !== 5) {
          throw new Error("broad removal");
        }
        if (runtime.failRemoval) throw new Error(`rm failed ${PASSWORD_MARK}`);
        return ID;
      }
      throw new Error(`unexpected docker args ${action ?? ""}`);
    },
  };
  return runtime;
}
