import { describe, expect, it } from "vitest";
import { resolveDockerSession, type DockerRun } from "@/server/internal/p1-production-adapter/docker-runtime";
import { RunnerRefusal } from "@/server/internal/p1-isolated-runner/refusal";

const LOCAL = "npipe:////./pipe/dockerDesktopLinuxEngine";

describe("Docker endpoint authentication", () => {
  it("rejects a DOCKER_CONTEXT that points at SSH", () => {
    const run = scripted({
      "context inspect prod": contextJson("ssh://root@203.0.113.10"),
    });
    expect(codeOf(() => resolveDockerSession({ DOCKER_CONTEXT: "prod" }, run))).toBe("DOCKER_ENDPOINT_REMOTE");
    expect(run.calls.some((args) => args[0] === "info")).toBe(false);
  });

  it("rejects a remote context that is the default when DOCKER_HOST is unset", () => {
    const run = scripted({
      "context show": "remote\n",
      "context inspect remote": contextJson("tcp://203.0.113.10:2376"),
    });
    expect(codeOf(() => resolveDockerSession({}, run))).toBe("DOCKER_ENDPOINT_REMOTE");
  });

  it("rejects a TCP DOCKER_HOST", () => {
    const run = scripted({});
    expect(codeOf(() => resolveDockerSession({ DOCKER_HOST: "tcp://127.0.0.1:2375" }, run))).toBe("DOCKER_ENDPOINT_REMOTE");
    expect(run.calls).toEqual([]);
  });

  it("rejects contradictory DOCKER_HOST and DOCKER_CONTEXT", () => {
    const run = scripted({});
    expect(
      codeOf(() => resolveDockerSession({ DOCKER_HOST: LOCAL, DOCKER_CONTEXT: "desktop-linux" }, run)),
    ).toBe("DOCKER_ENDPOINT_AMBIGUOUS");
    expect(run.calls).toEqual([]);
  });

  it("rejects an unrecognized unix socket and keeps parent secrets out of the Docker env", () => {
    const run = scripted({});
    expect(codeOf(() => resolveDockerSession({ DOCKER_HOST: "unix:///tmp/not-the-engine.sock" }, run))).toBe(
      "DOCKER_ENDPOINT_UNRECOGNIZED",
    );

    const seen: NodeJS.ProcessEnv[] = [];
    const local = scripted(
      { "info --format {{.ID}}": "daemon-local-1\n" },
      (env) => seen.push(env),
    );
    const session = resolveDockerSession(
      { DOCKER_HOST: LOCAL, AWS_SECRET_ACCESS_KEY: "parent-secret", DOCKER_AUTH_CONFIG: "parent-auth" },
      local,
    );
    expect(session.endpoint).toBe(LOCAL);
    expect(session.daemonId).toBe("daemon-local-1");
    expect(session.env.DOCKER_HOST).toBe(LOCAL);
    expect(session.env.DOCKER_CONTEXT).toBeUndefined();
    expect(session.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(session.env.DOCKER_AUTH_CONFIG).toBeUndefined();
    expect(seen[0]?.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });
});

function contextJson(host: string): string {
  return JSON.stringify([{ Name: "remote", Endpoints: { docker: { Host: host } } }]);
}

function codeOf(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(RunnerRefusal);
    return (error as RunnerRefusal).code;
  }
  throw new Error("expected a refusal");
}

function scripted(
  responses: Record<string, string>,
  onEnv?: (env: NodeJS.ProcessEnv) => void,
): DockerRun & { calls: string[][] } {
  const calls: string[][] = [];
  const run = ((args: readonly string[], env: NodeJS.ProcessEnv) => {
    calls.push([...args]);
    onEnv?.(env);
    const found = responses[args.join(" ")];
    if (found === undefined) throw new Error(`unexpected docker ${args.join(" ")}`);
    return found;
  }) as DockerRun & { calls: string[][] };
  run.calls = calls;
  return run;
}
