import { bindingDrift, type InvocationBinding } from "@/server/internal/p1-write-freeze-historical/lifecycle";
import type { DockerWorld, ExecResult } from "@/server/internal/p1-write-freeze-proof/lifecycle";

const PRODUCTION_NAMES = new Set(["stell22-db-prod", "stell22-app", "stell22-caddy", "stell22-db"]);
const FULL_ID = /^[0-9a-f]{64}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

export type OwnedContainer = { id: string; name: string; imageId: string };
export type OwnedVolume = { name: string; mountpoint: string };
export type OwnedNetwork = { id: string; name: string };
export type OwnedImage = { tag: string; id: string };

export type AppOnlyRelease = {
  binding: InvocationBinding;
  labelKey: string;
  database: OwnedContainer | null;
  application: OwnedContainer | null;
  volume: OwnedVolume | null;
  network: OwnedNetwork | null;
  image: OwnedImage | null;
};

export type ReleaseReport = {
  removed: string[];
  preserved: Array<{ resource: string; reason: string }>;
  failures: Array<{ resource: string; reason: string }>;
};

export function formatReleaseReport(report: ReleaseReport): string {
  const list = (items: Array<{ resource: string; reason: string }>) =>
    items.length === 0 ? "none" : items.map((item) => `${item.resource}:${item.reason}`).join(",");
  return `cleanup removed=${report.removed.join(",") || "none"} preserved=${list(report.preserved)} failures=${list(report.failures)}`;
}

export function releaseAppOnly(input: AppOnlyRelease, world: DockerWorld): ReleaseReport {
  const report: ReleaseReport = { removed: [], preserved: [], failures: [] };
  if (input.labelKey.length === 0 || input.binding.runId.length === 0) {
    preserve(report, "invocation", "IDENTITY_MISSING");
    return report;
  }
  for (const container of [input.application, input.database]) {
    if (container === null) continue;
    if (!FULL_ID.test(container.id) || !IMAGE_ID.test(container.imageId)) {
      preserve(report, container.name || "container", "AMBIGUOUS");
      preserve(report, "volume", "AMBIGUOUS");
      preserve(report, "network", "AMBIGUOUS");
      return report;
    }
  }
  if (input.application !== null) removeContainer(input, input.application, world, report);
  if (input.database !== null && !report.preserved.some((item) => item.resource === "volume")) {
    removeContainer(input, input.database, world, report);
  }
  if (input.volume !== null && !report.preserved.some((item) => item.resource === "volume")) removeVolume(input, world, report);
  if (input.network !== null && !report.preserved.some((item) => item.resource === "network")) removeNetwork(input, world, report);
  if (input.image !== null && !report.preserved.some((item) => item.resource === "image")) removeImage(input, world, report);
  return report;
}

export function appOnlyCleanupAllowed(input: {
  expectedId: string;
  expectedName: string;
  expectedImageId: string;
  runId: string;
  labelKey: string;
  name: string;
  id: string;
  imageId: string;
  labels: Readonly<Record<string, string | undefined>>;
}): { ok: true } | { ok: false; code: string } {
  const bare = input.name.replace(/^\//, "");
  if (PRODUCTION_NAMES.has(bare) || bare === "stell22-db-prod") return { ok: false, code: "PRODUCTION_NAME" };
  if (!bare.startsWith("p1as-") || bare !== input.expectedName) return { ok: false, code: "NAME_MISMATCH" };
  if (input.id !== input.expectedId || !/^[0-9a-f]{64}$/.test(input.id)) return { ok: false, code: "ID_MISMATCH" };
  if (input.imageId !== input.expectedImageId) return { ok: false, code: "IMAGE_MISMATCH" };
  if (input.labels[input.labelKey] !== input.runId) return { ok: false, code: "LABEL_MISMATCH" };
  if (input.labels["com.docker.compose.project"]) return { ok: false, code: "COMPOSE_PROJECT" };
  return { ok: true };
}

function removeContainer(input: AppOnlyRelease, container: OwnedContainer, world: DockerWorld, report: ReleaseReport): boolean {
  const drift = bindingDrift(input.binding, world);
  if (drift !== null) return stop(report, container.name, drift);
  const inspected = world.exec(["inspect", container.id]);
  const row = oneRecord(inspected);
  if (row === undefined) return stop(report, container.name, inspected.status === 0 ? "MALFORMED" : "INSPECT_FAILED");
  const verdict = containerVerdict(input, container, row);
  if (!verdict.ok) return stop(report, container.name, verdict.code);
  if (bindingDrift(input.binding, world) !== null) return stop(report, container.name, "DAEMON_CHANGED");
  const removed = world.exec(["rm", "-f", container.id]);
  if (removed.status !== 0) {
    report.failures.push({ resource: container.name, reason: "REMOVAL_FAILED" });
    return stop(report, container.name, "REMOVAL_FAILED");
  }
  report.removed.push(container.name);
  return true;
}

function removeVolume(input: AppOnlyRelease, world: DockerWorld, report: ReleaseReport): void {
  const volume = input.volume;
  if (volume === null) return;
  if (bindingDrift(input.binding, world) !== null) {
    preserve(report, volume.name, "DAEMON_CHANGED");
    return;
  }
  const inspected = world.exec(["volume", "inspect", volume.name]);
  const row = oneRecord(inspected);
  if (row === undefined) {
    preserve(report, volume.name, inspected.status === 0 ? "MALFORMED" : "INSPECT_FAILED");
    return;
  }
  const labels = record(row.Labels) ?? {};
  if (row.Name !== volume.name || row.Mountpoint !== volume.mountpoint || !volume.name.startsWith("p1as-vol-") || PRODUCTION_NAMES.has(volume.name)) {
    preserve(report, volume.name, "NAME_MISMATCH");
    return;
  }
  if (labels[input.labelKey] !== input.binding.runId) {
    preserve(report, volume.name, "LABEL_MISMATCH");
    return;
  }
  if (labels["com.docker.compose.project"] !== undefined) {
    preserve(report, volume.name, "COMPOSE_PROJECT");
    return;
  }
  if (bindingDrift(input.binding, world) !== null) {
    preserve(report, volume.name, "DAEMON_CHANGED");
    return;
  }
  const removed = world.exec(["volume", "rm", volume.name]);
  if (removed.status !== 0) {
    report.failures.push({ resource: volume.name, reason: "REMOVAL_FAILED" });
    preserve(report, volume.name, "REMOVAL_FAILED");
    return;
  }
  report.removed.push(volume.name);
}

function removeNetwork(input: AppOnlyRelease, world: DockerWorld, report: ReleaseReport): void {
  const network = input.network;
  if (network === null || !FULL_ID.test(network.id)) {
    preserve(report, network?.name ?? "network", "AMBIGUOUS");
    return;
  }
  if (bindingDrift(input.binding, world) !== null) {
    preserve(report, network.name, "DAEMON_CHANGED");
    return;
  }
  const inspected = world.exec(["network", "inspect", network.id]);
  const row = oneRecord(inspected);
  if (row === undefined) {
    preserve(report, network.name, inspected.status === 0 ? "MALFORMED" : "INSPECT_FAILED");
    return;
  }
  const labels = record(row.Labels) ?? {};
  const containers = record(row.Containers) ?? {};
  const owned = new Set([input.application?.id, input.database?.id].filter((id): id is string => typeof id === "string"));
  if (row.Id !== network.id || row.Name !== network.name || !network.name.startsWith("p1as-net-") || PRODUCTION_NAMES.has(network.name)) {
    preserve(report, network.name, "NAME_MISMATCH");
    return;
  }
  if (labels[input.labelKey] !== input.binding.runId) {
    preserve(report, network.name, "LABEL_MISMATCH");
    return;
  }
  if (labels["com.docker.compose.project"] !== undefined) {
    preserve(report, network.name, "COMPOSE_PROJECT");
    return;
  }
  if (Object.keys(containers).some((id) => !owned.has(id))) {
    preserve(report, network.name, "ATTACHMENT");
    return;
  }
  if (bindingDrift(input.binding, world) !== null) {
    preserve(report, network.name, "DAEMON_CHANGED");
    return;
  }
  const removed = world.exec(["network", "rm", network.id]);
  if (removed.status !== 0) {
    report.failures.push({ resource: network.name, reason: "REMOVAL_FAILED" });
    preserve(report, network.name, "REMOVAL_FAILED");
    return;
  }
  report.removed.push(network.name);
}

function removeImage(input: AppOnlyRelease, world: DockerWorld, report: ReleaseReport): void {
  const image = input.image;
  if (image === null || !IMAGE_ID.test(image.id) || !image.tag.startsWith("p1as-app:")) {
    preserve(report, image?.tag ?? "image", "AMBIGUOUS");
    return;
  }
  if (bindingDrift(input.binding, world) !== null) {
    preserve(report, image.tag, "DAEMON_CHANGED");
    return;
  }
  const inspected = world.exec(["image", "inspect", image.tag]);
  const row = oneRecord(inspected);
  if (row === undefined) {
    preserve(report, image.tag, inspected.status === 0 ? "MALFORMED" : "INSPECT_FAILED");
    return;
  }
  const tags = Array.isArray(row.RepoTags) ? row.RepoTags.filter((tag): tag is string => typeof tag === "string") : [];
  if (row.Id !== image.id || tags.length !== 1 || tags[0] !== image.tag) {
    preserve(report, image.tag, row.Id === image.id ? "IMAGE_SHARED" : "TAG_REPLACED");
    return;
  }
  if (bindingDrift(input.binding, world) !== null) {
    preserve(report, image.tag, "DAEMON_CHANGED");
    return;
  }
  const removed = world.exec(["rmi", image.tag]);
  if (removed.status !== 0) {
    report.failures.push({ resource: image.tag, reason: "REMOVAL_FAILED" });
    preserve(report, image.tag, "REMOVAL_FAILED");
    return;
  }
  report.removed.push(image.tag);
}

function containerVerdict(input: AppOnlyRelease, container: OwnedContainer, row: Record<string, unknown>): { ok: true } | { ok: false; code: string } {
  const name = typeof row.Name === "string" ? row.Name.replace(/^\//, "") : "";
  const config = record(row.Config);
  const labels = config ? record(config.Labels) ?? {} : {};
  if (PRODUCTION_NAMES.has(name) || PRODUCTION_NAMES.has(container.name)) return { ok: false, code: "PRODUCTION_NAME" };
  if (name !== container.name || !name.startsWith("p1as-")) return { ok: false, code: "NAME_MISMATCH" };
  if (row.Id !== container.id) return { ok: false, code: "ID_MISMATCH" };
  if (row.Image !== container.imageId) return { ok: false, code: "IMAGE_MISMATCH" };
  if (labels[input.labelKey] !== input.binding.runId) return { ok: false, code: "LABEL_MISMATCH" };
  if (labels["com.docker.compose.project"] !== undefined) return { ok: false, code: "COMPOSE_PROJECT" };
  return { ok: true };
}

function stop(report: ReleaseReport, resource: string, reason: string): boolean {
  preserve(report, resource, reason);
  preserve(report, "volume", reason);
  preserve(report, "network", reason);
  preserve(report, "image", reason);
  return false;
}

function preserve(report: ReleaseReport, resource: string, reason: string): void {
  if (report.removed.includes(resource)) return;
  if (report.preserved.some((item) => item.resource === resource)) return;
  report.preserved.push({ resource, reason });
}

function oneRecord(result: ExecResult): Record<string, unknown> | undefined {
  if (result.status !== 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(parsed) || parsed.length !== 1) return undefined;
    return record(parsed[0]);
  } catch {
    return undefined;
  }
}

export function confirmOwnedContainer(
  input: AppOnlyRelease,
  container: OwnedContainer,
  world: DockerWorld,
): { ok: true } | { ok: false; reason: string } {
  const drift = bindingDrift(input.binding, world);
  if (drift !== null) return { ok: false, reason: drift };
  const row = oneRecord(world.exec(["inspect", container.id]));
  if (row === undefined) return { ok: false, reason: "INSPECT_FAILED" };
  const verdict = containerVerdict(input, container, row);
  if (!verdict.ok) return { ok: false, reason: verdict.code };
  if (bindingDrift(input.binding, world) !== null) return { ok: false, reason: "DAEMON_CHANGED" };
  return { ok: true };
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
