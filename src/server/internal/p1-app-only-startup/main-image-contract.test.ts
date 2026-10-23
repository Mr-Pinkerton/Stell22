import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateMainImageStartup, legacyEntrypointViolatesContract } from "@/server/internal/p1-app-only-startup/main-image-contract";

describe("main image startup contract", () => {
  it("selects the app-only entrypoint and carries the gate dependencies", () => {
    const dockerfile = fs.readFileSync("Dockerfile", "utf8");
    const entrypoint = fs.readFileSync("docker-entrypoint-app-only.sh", "utf8");
    expect(entrypoint).not.toContain("\r");
    expect(evaluateMainImageStartup({ dockerfile, selectedEntrypoint: entrypoint })).toEqual({ ok: true });
    expect(fs.readFileSync("package.json", "utf8")).toContain('"start": "next start"');
  });

  it("rejects an image that still starts through docker-entrypoint.sh", () => {
    const legacy = fs.readFileSync("docker-entrypoint.sh", "utf8");
    const dockerfile = [
      "FROM scratch AS runner",
      "COPY docker-entrypoint.sh ./docker-entrypoint.sh",
      'ENTRYPOINT ["./docker-entrypoint.sh"]',
      "",
    ].join("\n");
    expect(legacyEntrypointViolatesContract(dockerfile, legacy)).toEqual({ ok: false, code: "ENTRYPOINT" });
    expect(legacy).toContain("npx prisma migrate deploy");
    expect(legacy).not.toContain("app-only");
  });

  it("rejects a script that runs prisma migrate deploy, db push, or migrate reset", () => {
    const dockerfile = candidateDockerfile();
    const entrypoint = fs.readFileSync("docker-entrypoint-app-only.sh", "utf8");
    expect(evaluateMainImageStartup({ dockerfile, selectedEntrypoint: entrypoint })).toEqual({ ok: true });
    for (const command of ["npx prisma migrate deploy", "npx prisma db push", "npx prisma migrate reset"]) {
      const selectedEntrypoint = `#!/bin/sh\nset -eu\n${command}\nexec npm run start\n`;
      expect(evaluateMainImageStartup({ dockerfile, selectedEntrypoint })).toEqual({ ok: false, code: "AUTOMATIC_MIGRATION" });
    }
    const withLegacyCopy = dockerfile.replace(
      "COPY docker-entrypoint-app-only.sh ./docker-entrypoint-app-only.sh",
      "COPY docker-entrypoint.sh ./docker-entrypoint.sh\nCOPY docker-entrypoint-app-only.sh ./docker-entrypoint-app-only.sh",
    );
    expect(evaluateMainImageStartup({ dockerfile: withLegacyCopy, selectedEntrypoint: entrypoint })).toEqual({
      ok: false,
      code: "LEGACY_ENTRYPOINT",
    });
  });

function candidateDockerfile(): string {
  return [
    "FROM scratch AS deps",
    "RUN npm ci",
    "FROM scratch AS build",
    "RUN npx prisma generate",
    "FROM scratch AS runner",
    "ENV NODE_ENV=production",
    "COPY --from=build /app/node_modules ./node_modules",
    "COPY --from=build /app/.next ./.next",
    "COPY --from=build /app/public ./public",
    "COPY --from=build /app/package.json ./package.json",
    "COPY --from=build /app/next.config.ts ./next.config.ts",
    "COPY --from=build /app/tsconfig.json ./tsconfig.json",
    "COPY --from=build /app/prisma ./prisma",
    "COPY --from=build /app/src ./src",
    "COPY docker-entrypoint-app-only.sh ./docker-entrypoint-app-only.sh",
    "RUN chmod +x docker-entrypoint-app-only.sh",
    'ENTRYPOINT ["./docker-entrypoint-app-only.sh"]',
    "",
  ].join("\n");
}
});
