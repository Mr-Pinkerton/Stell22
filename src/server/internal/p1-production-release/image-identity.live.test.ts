import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { P1_SHA256 } from "@/server/internal/p1-isolated-runner/contract";
import { selectReleaseImage } from "@/server/internal/p1-production-release/image-identity";

const LIVE = process.env.P1_DISPOSABLE_LIVE === "1";

function canonical(id: string): string {
  return id.trim().replace(/^sha256:/, "");
}

describe.skipIf(!LIVE)("release image selection while the old container is running", () => {
  it("returns the new image, rejects the old image, and keeps the container after a failed build", () => {
    const runId = randomBytes(4).toString("hex");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p1img-"));
    const container = `p1as-img-${runId}`;
    const marker = "URLSAFEONLYMARKER1234567890";
    const compose = path.join(dir, "compose.yml");
    const dockerfile = path.join(dir, "ctx", "Dockerfile");
    fs.mkdirSync(path.join(dir, "ctx"));
    const writeDockerfile = (body: string) => fs.writeFileSync(dockerfile, body);
    writeDockerfile("FROM busybox:1.36.1\nRUN echo old > /id\nENTRYPOINT [\"sleep\", \"600\"]\n");
    fs.writeFileSync(
      compose,
      [
        "services:",
        "  app:",
        "    build: ./ctx",
        `    container_name: ${container}`,
        "    environment:",
        "      DATABASE_URL: postgresql://stell22_app:${APP_DB_PASSWORD}@db:5432/stell22",
        "",
      ].join("\n"),
    );
    const env = { ...process.env, APP_DB_PASSWORD: marker };
    const composeRun = (args: string[]) => spawnSync("docker", ["compose", "-f", compose, ...args], { encoding: "utf8", env });
    try {
      expect(composeRun(["build", "app"]).status).toBe(0);
      expect(composeRun(["up", "-d", "app"]).status).toBe(0);
      const oldId = spawnSync("docker", ["inspect", "-f", "{{.Image}}", container], { encoding: "utf8" }).stdout.trim();
      expect(canonical(composeRun(["images", "-q", "app"]).stdout)).toBe(canonical(oldId));
      expect(spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", container], { encoding: "utf8" }).stdout.trim()).toBe("true");
      writeDockerfile("FROM busybox:1.36.1\nRUN echo new > /id\nENTRYPOINT [\"sleep\", \"600\"]\n");
      expect(composeRun(["build", "app"]).status).toBe(0);
      expect(spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", container], { encoding: "utf8" }).stdout.trim()).toBe("true");
      const selected = spawnSync("sh", ["scripts/release-built-image-id.sh", compose, oldId], { encoding: "utf8", env });
      expect(selected.status).toBe(0);
      expect(selected.stdout).not.toContain(marker);
      expect(selected.stderr).not.toContain(marker);
      const imageId = selected.stdout
        .split("\n")
        .find((line) => line.startsWith("IMAGE_ID="))
        ?.slice("IMAGE_ID=".length);
      expect(imageId).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(imageId).not.toBe(oldId);
      const rejected = spawnSync("sh", ["scripts/release-built-image-id.sh", compose, imageId ?? ""], { encoding: "utf8", env });
      expect(rejected.status).not.toBe(0);
      expect(rejected.stdout).not.toContain(imageId);
      expect(selectReleaseImage({
        legacyImageId: oldId,
        builtImageId: oldId,
        entrypoint: ["./docker-entrypoint-app-only.sh"],
        p1Checksum: P1_SHA256,
      })).toEqual({ ok: false, code: "STOP_APP_START" });
      writeDockerfile("FROM busybox:1.36.1\nRUN false\n");
      expect(composeRun(["build", "app"]).status).not.toBe(0);
      expect(spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", container], { encoding: "utf8" }).stdout.trim()).toBe("true");
      expect(spawnSync("docker", ["inspect", "-f", "{{.Image}}", container], { encoding: "utf8" }).stdout.trim()).toBe(oldId);
    } finally {
      spawnSync("docker", ["compose", "-f", compose, "down", "--rmi", "local"], { encoding: "utf8", env });
      spawnSync("docker", ["rm", "-f", container], { encoding: "utf8" });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
