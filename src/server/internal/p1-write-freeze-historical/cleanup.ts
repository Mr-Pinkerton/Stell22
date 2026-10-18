/**
 * Removes one historical application container only after a fresh inspect
 * of the id returned by docker run. An uncertain container is left in place.
 */

import type { DockerWorld } from "@/server/internal/p1-write-freeze-proof/lifecycle";
import { evaluateAppInspect, type AppExpectation } from "@/server/internal/p1-write-freeze-historical/identity";

export type AppCleanupReport = {
  removed: boolean;
  reason: string;
};

export function releaseAppContainer(
  expected: AppExpectation,
  endpoint: string,
  daemonId: string,
  world: DockerWorld,
): AppCleanupReport {
  const drift = readBinding(endpoint, daemonId, world);
  if (drift !== null) return { removed: false, reason: drift };
  const inspected = world.exec(["inspect", expected.containerId]);
  const document = parseOne(inspected.status, inspected.stdout);
  if (document === undefined) return { removed: false, reason: inspected.status === 0 ? "MALFORMED" : "INSPECT_FAILED" };
  const verdict = evaluateAppInspect(document, expected);
  if (!verdict.ok) return { removed: false, reason: verdict.code };
  const again = readBinding(endpoint, daemonId, world);
  if (again !== null) return { removed: false, reason: again };
  const removed = world.exec(["rm", "-f", expected.containerId]);
  if (removed.status !== 0) return { removed: false, reason: "REMOVAL_FAILED" };
  return { removed: true, reason: "REMOVED" };
}

function readBinding(endpoint: string, daemonId: string, world: DockerWorld): string | null {
  try {
    if (world.endpoint() !== endpoint) return "ENDPOINT_CHANGED";
    if (world.daemonId() !== daemonId) return "DAEMON_CHANGED";
    return null;
  } catch {
    return "ENDPOINT_UNREADABLE";
  }
}

function parseOne(status: number | null, stdout: string): unknown | undefined {
  if (status !== 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed) || parsed.length !== 1) return undefined;
    return parsed[0];
  } catch {
    return undefined;
  }
}
