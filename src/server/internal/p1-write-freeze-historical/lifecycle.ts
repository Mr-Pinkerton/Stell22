/**
 * Gates for one historical-application invocation.
 * A remembered container id or image id is not authority after the
 * Docker endpoint or daemon changes. Uncertain resources stay in place.
 */

import type { DockerWorld, ExecResult } from "@/server/internal/p1-write-freeze-proof/lifecycle";
import { APP_LABEL, evaluateAppInspect, type AppExpectation } from "@/server/internal/p1-write-freeze-historical/identity";

const FULL_ID = /^[0-9a-f]{64}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const FLAGS_WITH_VALUE = new Set([
  "--name",
  "--network",
  "--label",
  "--env-file",
  "--entrypoint",
  "--restart",
  "-p",
  "-e",
]);

export type InvocationBinding = {
  endpoint: string;
  daemonId: string;
  runId: string;
};

export type Gate = { ok: true } | { ok: false; reason: string };

export function bindingDrift(
  binding: Pick<InvocationBinding, "endpoint" | "daemonId">,
  world: DockerWorld,
): string | null {
  try {
    if (world.endpoint() !== binding.endpoint) return "ENDPOINT_CHANGED";
    if (world.daemonId() !== binding.daemonId) return "DAEMON_CHANGED";
    return null;
  } catch {
    return "ENDPOINT_UNREADABLE";
  }
}

export function beginImageBuild(binding: InvocationBinding, tag: string, world: DockerWorld): Gate {
  const drift = bindingDrift(binding, world);
  if (drift !== null) return { ok: false, reason: drift };
  if (tag !== ownedTag(binding.runId)) return { ok: false, reason: "TAG_MISMATCH" };
  return { ok: true };
}

export function createOwnedContainer(
  command: "create" | "run",
  args: readonly string[],
  binding: InvocationBinding,
  world: DockerWorld,
): { ok: true; id: string } | { ok: false; reason: string } {
  const gate = beginCreate(binding, args, world);
  if (!gate.ok) return gate;
  const argv = command === "run" ? ["run", "-d", ...args] : ["create", ...args];
  const created = world.exec(argv);
  const id = acceptCreatedId(created);
  if (id === null) return { ok: false, reason: "AMBIGUOUS" };
  return { ok: true, id };
}

export function allowContainerMutation(binding: InvocationBinding, expected: AppExpectation, world: DockerWorld): Gate {
  const drift = bindingDrift(binding, world);
  if (drift !== null) return { ok: false, reason: drift };
  if (expected.runId !== binding.runId) return { ok: false, reason: "LABEL_MISMATCH" };
  const inspected = world.exec(["inspect", expected.containerId]);
  const document = parseOne(inspected);
  if (document === undefined) return { ok: false, reason: inspected.status === 0 ? "MALFORMED" : "INSPECT_FAILED" };
  const verdict = evaluateAppInspect(document, expected);
  if (!verdict.ok) return { ok: false, reason: verdict.code };
  const again = bindingDrift(binding, world);
  if (again !== null) return { ok: false, reason: again };
  return { ok: true };
}

export function restartOwnedContainer(expected: AppExpectation, binding: InvocationBinding, world: DockerWorld): Gate {
  const ready = allowContainerMutation(binding, expected, world);
  if (!ready.ok) return ready;
  const restarted = world.exec(["restart", expected.containerId]);
  if (restarted.status !== 0) return { ok: false, reason: "RESTART_FAILED" };
  return { ok: true };
}

export function copyOwned(
  expected: AppExpectation,
  binding: InvocationBinding,
  args: readonly string[],
  world: DockerWorld,
): Gate {
  if (!commandTargets(expected.containerId, args)) return { ok: false, reason: "ID_MISMATCH" };
  const ready = allowContainerMutation(binding, expected, world);
  if (!ready.ok) return ready;
  const copied = world.exec(["cp", ...args]);
  if (copied.status !== 0) return { ok: false, reason: "COPY_FAILED" };
  return { ok: true };
}

export function execOwned(
  expected: AppExpectation,
  binding: InvocationBinding,
  args: readonly string[],
  world: DockerWorld,
): { ok: true; result: ExecResult } | { ok: false; reason: string } {
  if (args[0] !== expected.containerId || !commandTargets(expected.containerId, args)) {
    return { ok: false, reason: "ID_MISMATCH" };
  }
  const ready = allowContainerMutation(binding, expected, world);
  if (!ready.ok) return ready;
  return { ok: true, result: world.exec(["exec", ...args]) };
}

export function releaseOwnedImage(
  binding: InvocationBinding,
  tag: string,
  imageId: string,
  world: DockerWorld,
): { removed: boolean; reason: string } {
  const drift = bindingDrift(binding, world);
  if (drift !== null) return { removed: false, reason: drift };
  if (tag !== ownedTag(binding.runId) || !IMAGE_ID.test(imageId)) return { removed: false, reason: "IDENTITY_MISSING" };
  const inspected = world.exec(["image", "inspect", tag]);
  const document = parseOne(inspected);
  if (document === undefined) return { removed: false, reason: inspected.status === 0 ? "MALFORMED" : "INSPECT_FAILED" };
  const row = asRecord(document);
  if (row === undefined) return { removed: false, reason: "MALFORMED" };
  if (row.Id !== imageId) return { removed: false, reason: "TAG_REPLACED" };
  const tags = tagSet(row.RepoTags, tag);
  if (tags === "absent") return { removed: false, reason: "IDENTITY_MISSING" };
  if (tags === "shared") return { removed: false, reason: "IMAGE_SHARED" };
  const again = bindingDrift(binding, world);
  if (again !== null) return { removed: false, reason: again };
  const removed = world.exec(["rmi", tag]);
  if (removed.status !== 0) return { removed: false, reason: "REMOVAL_FAILED" };
  return { removed: true, reason: "REMOVED" };
}

export function acceptCreatedId(result: ExecResult): string | null {
  const id = result.stdout.trim();
  if (result.status !== 0 || !FULL_ID.test(id)) return null;
  return id;
}

function beginCreate(binding: InvocationBinding, args: readonly string[], world: DockerWorld): Gate {
  const drift = bindingDrift(binding, world);
  if (drift !== null) return { ok: false, reason: drift };
  const verdict = evaluateCreationArgs(binding, args);
  if (!verdict.ok) return verdict;
  const again = bindingDrift(binding, world);
  if (again !== null) return { ok: false, reason: again };
  return { ok: true };
}

function evaluateCreationArgs(binding: InvocationBinding, args: readonly string[]): Gate {
  const name = flag(args, "--name");
  const network = flag(args, "--network");
  const label = flag(args, "--label");
  const port = flag(args, "-p");
  const restart = flag(args, "--restart");
  if (name === undefined || isForbidden(name) || !name.startsWith(`stell22-p1wf-${binding.runId}`)) {
    return { ok: false, reason: "NAME_MISMATCH" };
  }
  if (network !== `stell22-p1wf-${binding.runId}-net`) return { ok: false, reason: "NETWORK_MISMATCH" };
  if (label !== `${APP_LABEL}=${binding.runId}`) return { ok: false, reason: "LABEL_MISMATCH" };
  if (positionals(args)[0] !== ownedTag(binding.runId)) return { ok: false, reason: "IMAGE_MISMATCH" };
  if (port !== undefined && !port.startsWith("127.0.0.1:")) return { ok: false, reason: "PORT_EXPOSED" };
  if (restart !== undefined && restart !== "no") return { ok: false, reason: "RESTART_POLICY" };
  if (args.some((arg) => isForbidden(arg) || arg.includes("0.0.0.0") || arg.includes("com.docker.compose.project"))) {
    return { ok: false, reason: "FORBIDDEN_NAME" };
  }
  return { ok: true };
}

function commandTargets(containerId: string, args: readonly string[]): boolean {
  const mentioned = args.filter((arg) => FULL_ID.test(arg) || FULL_ID.test(arg.split(":")[0] ?? ""));
  return mentioned.length === 1 && mentioned[0]?.replace(/:.*$/, "") === containerId;
}

function ownedTag(runId: string): string {
  return `stell22-p1wf-hist-${runId}`;
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  return args[index + 1];
}

function positionals(args: readonly string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (FLAGS_WITH_VALUE.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    values.push(arg);
  }
  return values;
}

function tagSet(value: unknown, owned: string): "exact" | "shared" | "absent" {
  if (!Array.isArray(value) || value.length === 0) return "absent";
  const names = value.map((item) => (typeof item === "string" ? item.replace(/:latest$/, "") : ""));
  if (!names.every((item) => item.length > 0) || !names.includes(owned)) return "absent";
  return names.length === 1 ? "exact" : "shared";
}

function isForbidden(name: string): boolean {
  return ["stell22-db-prod", "stell22-app", "stell22-caddy"].includes(name.replace(/^\//, "").toLowerCase());
}

function parseOne(result: ExecResult): unknown | undefined {
  if (result.status !== 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(parsed) || parsed.length !== 1) return undefined;
    return parsed[0];
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
