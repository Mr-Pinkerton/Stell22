import { P1_SHA256 } from "@/server/internal/p1-isolated-runner/contract";

const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const APP_ONLY_ENTRYPOINT = ["./docker-entrypoint-app-only.sh"] as const;

export function selectReleaseImage(input: {
  legacyImageId: string;
  builtImageId: string;
  entrypoint: readonly string[];
  p1Checksum: string;
}): { ok: true; imageId: string } | { ok: false; code: "STOP_APP_START" } {
  if (!IMAGE_ID.test(input.legacyImageId) || !IMAGE_ID.test(input.builtImageId)) return { ok: false, code: "STOP_APP_START" };
  if (input.builtImageId === input.legacyImageId) return { ok: false, code: "STOP_APP_START" };
  if (input.entrypoint.length !== APP_ONLY_ENTRYPOINT.length) return { ok: false, code: "STOP_APP_START" };
  for (let index = 0; index < APP_ONLY_ENTRYPOINT.length; index += 1) {
    if (input.entrypoint[index] !== APP_ONLY_ENTRYPOINT[index]) return { ok: false, code: "STOP_APP_START" };
  }
  if (input.p1Checksum !== P1_SHA256) return { ok: false, code: "STOP_APP_START" };
  return { ok: true, imageId: input.builtImageId };
}
