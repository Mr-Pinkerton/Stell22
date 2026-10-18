/**
 * Cleanup for one disposable write-freeze proof invocation.
 * Removal is allowed only for a resource this invocation confirmed.
 * An uncertain owner is left in place. There is no label scan and no prune.
 */

import {
  evaluateInspect,
  networkCleanupAllowed,
  volumeCleanupAllowed,
  type OwnedExpectation,
  type OwnedNames,
} from "@/server/internal/p1-write-freeze-proof/identity";

export type ContainerPhase = "not-started" | "ambiguous" | "confirmed";

export type Invocation = {
  endpoint: string;
  daemonId: string;
  imageId: string;
  names: OwnedNames;
  networkCreated: boolean;
  volumeCreated: boolean;
  containerId: string | null;
  containerPhase: ContainerPhase;
};

export type ExecResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

export type DockerWorld = {
  endpoint(): string;
  daemonId(): string;
  exec(args: readonly string[]): ExecResult;
};

export type ProofResource = "container" | "volume" | "network";

export type CleanupReport = {
  removed: ProofResource[];
  preserved: Array<{ resource: ProofResource; reason: string }>;
  failures: Array<{ resource: ProofResource; reason: string }>;
};

const FULL_ID = /^[0-9a-f]{64}$/;

export function isDestructiveDockerArgv(args: readonly string[]): boolean {
  if (args.includes("prune")) return true;
  if (args[0] === "ps" || args.includes("--filter")) return true;
  if (args[0] === "rm") return true;
  return (args[0] === "volume" || args[0] === "network") && args[1] === "rm";
}

export function formatCleanupReport(report: CleanupReport): string {
  const list = (items: Array<{ resource: string; reason: string }>) =>
    items.length === 0 ? "none" : items.map((item) => `${item.resource}:${item.reason}`).join(",");
  return `cleanup removed=${report.removed.join(",") || "none"} preserved=${list(report.preserved)} failures=${list(report.failures)}`;
}

export function releaseInvocation(invocation: Invocation, world: DockerWorld): CleanupReport {
  const report: CleanupReport = { removed: [], preserved: [], failures: [] };
  if (invocation.containerPhase === "ambiguous" || !confirmedId(invocation)) {
    if (invocation.containerPhase !== "not-started") {
      preserve(report, invocation, "container", "AMBIGUOUS", true);
      return report;
    }
  } else {
    const removed = removeContainer(invocation, world, report);
    if (!removed) return report;
  }
  if (invocation.volumeCreated) removeVolume(invocation, world, report);
  if (invocation.networkCreated && !report.preserved.some((item) => item.resource === "network")) {
    removeNetwork(invocation, world, report);
  }
  return report;
}

function confirmedId(invocation: Invocation): boolean {
  return invocation.containerPhase === "confirmed" && invocation.containerId !== null && FULL_ID.test(invocation.containerId);
}

function removeContainer(invocation: Invocation, world: DockerWorld, report: CleanupReport): boolean {
  const drift = readBinding(invocation, world);
  if (drift !== null) {
    preserve(report, invocation, "container", drift, true);
    return false;
  }
  const containerId = invocation.containerId;
  if (containerId === null || !FULL_ID.test(containerId)) {
    preserve(report, invocation, "container", "AMBIGUOUS", true);
    return false;
  }
  const inspected = world.exec(["inspect", containerId]);
  const document = parseOne(inspected);
  if (document === undefined) {
    preserve(report, invocation, "container", inspected.status === 0 ? "MALFORMED" : "INSPECT_FAILED", true);
    return false;
  }
  const verdict = evaluateInspect(document, expectation(invocation, containerId), "cleanup");
  if (!verdict.ok) {
    preserve(report, invocation, "container", verdict.code, true);
    return false;
  }
  const again = readBinding(invocation, world);
  if (again !== null) {
    preserve(report, invocation, "container", again, true);
    return false;
  }
  const removed = world.exec(["rm", "-f", containerId]);
  if (removed.status !== 0) {
    report.failures.push({ resource: "container", reason: "REMOVAL_FAILED" });
    preserve(report, invocation, "volume", "CONTAINER_REMOVAL_FAILED", true);
    return false;
  }
  report.removed.push("container");
  return true;
}

function removeVolume(invocation: Invocation, world: DockerWorld, report: CleanupReport): void {
  if (report.preserved.some((item) => item.resource === "volume")) return;
  const drift = readBinding(invocation, world);
  if (drift !== null) {
    preserve(report, invocation, "volume", drift, true);
    return;
  }
  const inspected = world.exec(["volume", "inspect", invocation.names.volumeName]);
  const document = parseOne(inspected);
  if (document === undefined) {
    preserve(report, invocation, "volume", inspected.status === 0 ? "MALFORMED" : "INSPECT_FAILED", false);
    return;
  }
  const verdict = volumeCleanupAllowed(document, expectation(invocation, invocation.containerId ?? ""));
  if (!verdict.ok) {
    preserve(report, invocation, "volume", verdict.code, false);
    return;
  }
  const again = readBinding(invocation, world);
  if (again !== null) {
    preserve(report, invocation, "volume", again, true);
    return;
  }
  const removed = world.exec(["volume", "rm", invocation.names.volumeName]);
  if (removed.status !== 0) {
    report.failures.push({ resource: "volume", reason: "REMOVAL_FAILED" });
    return;
  }
  report.removed.push("volume");
}

function removeNetwork(invocation: Invocation, world: DockerWorld, report: CleanupReport): void {
  if (report.preserved.some((item) => item.resource === "network")) return;
  const drift = readBinding(invocation, world);
  if (drift !== null) {
    preserve(report, invocation, "network", drift, false);
    return;
  }
  const inspected = world.exec(["network", "inspect", invocation.names.networkName]);
  const document = parseOne(inspected);
  if (document === undefined) {
    preserve(report, invocation, "network", inspected.status === 0 ? "MALFORMED" : "INSPECT_FAILED", false);
    return;
  }
  const verdict = networkCleanupAllowed(document, expectation(invocation, invocation.containerId ?? ""));
  if (!verdict.ok) {
    preserve(report, invocation, "network", verdict.code, false);
    return;
  }
  const again = readBinding(invocation, world);
  if (again !== null) {
    preserve(report, invocation, "network", again, false);
    return;
  }
  const removed = world.exec(["network", "rm", invocation.names.networkName]);
  if (removed.status !== 0) {
    report.failures.push({ resource: "network", reason: "REMOVAL_FAILED" });
    return;
  }
  report.removed.push("network");
}

function preserve(
  report: CleanupReport,
  invocation: Invocation,
  from: ProofResource,
  reason: string,
  cascade: boolean,
): void {
  const order: ProofResource[] = ["container", "volume", "network"];
  const resources = cascade ? order.slice(order.indexOf(from)) : [from];
  for (const resource of resources) {
    if (resource === "container" && invocation.containerPhase === "not-started") continue;
    if (resource === "volume" && !invocation.volumeCreated) continue;
    if (resource === "network" && !invocation.networkCreated) continue;
    if (report.removed.includes(resource)) continue;
    if (report.preserved.some((item) => item.resource === resource)) continue;
    if (report.failures.some((item) => item.resource === resource)) continue;
    report.preserved.push({ resource, reason });
  }
}

function expectation(invocation: Invocation, containerId: string): OwnedExpectation {
  return { ...invocation.names, containerId, imageId: invocation.imageId };
}

function readBinding(invocation: Invocation, world: DockerWorld): string | null {
  try {
    if (world.endpoint() !== invocation.endpoint) return "ENDPOINT_CHANGED";
    if (world.daemonId() !== invocation.daemonId) return "DAEMON_CHANGED";
    return null;
  } catch {
    return "ENDPOINT_UNREADABLE";
  }
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
