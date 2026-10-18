const PRODUCTION_NAMES = new Set(["stell22-db-prod", "stell22-app", "stell22-caddy", "stell22-db"]);

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
