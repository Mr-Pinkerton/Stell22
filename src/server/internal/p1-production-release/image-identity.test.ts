import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { P1_SHA256 } from "@/server/internal/p1-isolated-runner/contract";
import { selectReleaseImage } from "@/server/internal/p1-production-release/image-identity";

function pythonBin(): string {
  for (const candidate of ["python3", "python"]) {
    const probe = spawnSync(candidate, ["-c", "import sys; raise SystemExit(0 if sys.version_info[0] == 3 else 1)"], { encoding: "utf8" });
    if (probe.status === 0) return candidate;
  }
  throw new Error("Python 3 is required");
}

const legacy = `sha256:${"a".repeat(64)}`;
const built = `sha256:${"b".repeat(64)}`;
const entrypoint = ["./docker-entrypoint-app-only.sh"] as const;

describe("release image identity", () => {
  it("pins the built image and rejects the legacy image", () => {
    expect(selectReleaseImage({ legacyImageId: legacy, builtImageId: built, entrypoint, p1Checksum: P1_SHA256 })).toEqual({
      ok: true,
      imageId: built,
    });
    expect(selectReleaseImage({ legacyImageId: legacy, builtImageId: legacy, entrypoint, p1Checksum: P1_SHA256 })).toEqual({
      ok: false,
      code: "STOP_APP_START",
    });
    expect(selectReleaseImage({ legacyImageId: legacy, builtImageId: built, entrypoint: ["docker-entrypoint.sh"], p1Checksum: P1_SHA256 }).ok).toBe(false);
    expect(selectReleaseImage({ legacyImageId: legacy, builtImageId: built, entrypoint: [...entrypoint, "extra"], p1Checksum: P1_SHA256 }).ok).toBe(false);
    expect(selectReleaseImage({ legacyImageId: legacy, builtImageId: built, entrypoint, p1Checksum: "f".repeat(64) }).ok).toBe(false);
    expect(selectReleaseImage({ legacyImageId: "", builtImageId: built, entrypoint, p1Checksum: P1_SHA256 }).ok).toBe(false);
  });

  it("rejects a password that cannot stay unchanged in a database URL", () => {
    const marker = `${"a".repeat(23)}/`;
    const migrator = "b".repeat(32);
    const refused = spawnSync("sh", ["scripts/release-url-password.sh"], {
      encoding: "utf8",
      env: { ...process.env, APP_DB_PASSWORD: marker, MIGRATOR_DB_PASSWORD: migrator },
    });
    expect(refused.status).not.toBe(0);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).not.toContain(marker);
    const out = path.join(os.tmpdir(), `stell22-migrator-url-${process.pid}.env`);
    const python = pythonBin();
    const badUrl = spawnSync(python, ["scripts/release-migrator-url.py"], {
      encoding: "utf8",
      env: { ...process.env, MIGRATOR_DB_PASSWORD: marker, ROLE: "stell22_migrator", OUT: out },
    });
    expect(badUrl.status).not.toBe(0);
    expect(badUrl.stdout).not.toContain(marker);
    expect(badUrl.stderr).not.toContain(marker);
    expect(fs.existsSync(out)).toBe(false);
    const accepted = spawnSync("sh", ["scripts/release-url-password.sh"], {
      encoding: "utf8",
      env: { ...process.env, APP_DB_PASSWORD: "a".repeat(32), MIGRATOR_DB_PASSWORD: migrator },
    });
    expect(accepted.status).toBe(0);
    const written = spawnSync(python, ["scripts/release-migrator-url.py"], {
      encoding: "utf8",
      env: { ...process.env, MIGRATOR_DB_PASSWORD: migrator, ROLE: "stell22_migrator", OUT: out },
    });
    expect(written.status).toBe(0);
    expect(written.stdout).toBe("");
    const stored = fs.readFileSync(out, "utf8");
    fs.rmSync(out, { force: true });
    expect(new URL(stored.slice("DATABASE_URL=".length).trim()).password).toBe(migrator);
  });
});

describe("bundled image identity decision", () => {
  it("admits only the new image id", () => {
    const file = path.join(os.tmpdir(), `stell22-image-facts-${process.pid}.txt`);
    fs.writeFileSync(file, [`legacyImageId=${legacy}`, `builtImageId=${built}`, `entrypoint=${JSON.stringify(entrypoint)}`, `p1Checksum=${P1_SHA256}`, ""].join("\n"));
    const admitted = spawnSync(process.execPath, ["scripts/release-decision.cjs", "image-identity", file], { encoding: "utf8" });
    fs.writeFileSync(file, [`legacyImageId=${legacy}`, `builtImageId=${legacy}`, `entrypoint=${JSON.stringify(entrypoint)}`, `p1Checksum=${P1_SHA256}`, ""].join("\n"));
    const rejected = spawnSync(process.execPath, ["scripts/release-decision.cjs", "image-identity", file], { encoding: "utf8" });
    fs.rmSync(file, { force: true });
    expect(admitted.status).toBe(0);
    expect(admitted.stdout).toContain("CODE=ADMITTED");
    expect(admitted.stdout).toContain(`IMAGE_ID=${built}`);
    expect(admitted.stdout).toContain("RESTART_LEGACY=NO");
    expect(rejected.status).not.toBe(0);
    expect(rejected.stdout).toContain("CODE=STOP_APP_START");
    expect(rejected.stdout).not.toContain(`IMAGE_ID=${legacy}`);
  });
});
