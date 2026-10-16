import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ONE_SHOT_IMAGE } from "@/server/internal/p1-isolated-runner/p1-release-gate";

const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const RECIPE_FILES = ["Dockerfile", "package.json", "package-lock.json"] as const;

export type ReviewedOneShotBuild = {
  tag: string;
  id: string;
  remove(): void;
};

/**
 * Build the reviewed recipe into a new p1pa-oneshot-* tag.
 * Does not retag or delete stell22-p1-oneshot:node22.
 */
export function buildReviewedOneShotImage(): ReviewedOneShotBuild {
  const tag = `p1pa-oneshot-${randomBytes(8).toString("hex")}`;
  const context = fs.mkdtempSync(path.join(os.tmpdir(), "p1pa-oneshot-recipe-"));
  const recipeDir = path.join(process.cwd(), "docker", "p1-oneshot");
  try {
    for (const name of RECIPE_FILES) {
      fs.copyFileSync(path.join(recipeDir, name), path.join(context, name));
    }
    const built = spawnSync("docker", ["build", "-t", tag, context], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 600_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (built.status !== 0 || built.signal) {
      throw new Error(`reviewed one-shot build failed: ${tail(built.stderr || built.stdout)}`);
    }
  } finally {
    fs.rmSync(context, { recursive: true, force: true });
  }
  const id = imageId(tag);
  assertRuntime(tag);
  return {
    tag,
    id,
    remove() {
      const removed = spawnSync("docker", ["rmi", tag], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 60_000,
      });
      if (removed.status !== 0 && !/no such image/i.test(`${removed.stderr}`)) {
        throw new Error(`could not remove test-owned tag ${tag}: ${tail(removed.stderr || removed.stdout)}`);
      }
    },
  };
}

/**
 * Point the operator's fixed tag at the reviewed build only when that tag
 * is absent. Docker's index digest can change between builds when the
 * attestation changes, so an existing tag is kept when its rootfs layers
 * match the build. Any other existing tag is left untouched.
 */
export function attachReviewedImageToOperatorTag(built: ReviewedOneShotBuild): void {
  if (!IMAGE_ID.test(built.id)) throw new Error("reviewed one-shot id is not a Docker image digest");
  const builtLayers = rootfsLayers(built.tag);
  const existing = spawnSync("docker", ["image", "inspect", "--format", "{{.Id}}", ONE_SHOT_IMAGE], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  });
  if (existing.status !== 0 || existing.signal) {
    const stderr = existing.stderr ?? "";
    if (existing.signal || !/no such image/i.test(stderr) || /no such file/i.test(stderr)) {
      throw new Error(`one-shot tag inspect failed: ${tail(stderr || existing.stdout)}`);
    }
    const tagged = spawnSync("docker", ["tag", built.id, ONE_SHOT_IMAGE], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 60_000,
    });
    if (tagged.status !== 0 || tagged.signal) {
      throw new Error(`could not publish the reviewed image to ${ONE_SHOT_IMAGE}: ${tail(tagged.stderr || tagged.stdout)}`);
    }
  } else if (rootfsLayers(ONE_SHOT_IMAGE) !== builtLayers) {
    throw new Error(
      `STOP: ${ONE_SHOT_IMAGE} already exists as ${existing.stdout.trim()} and its rootfs does not match the reviewed build ${built.id}. The existing tag was not replaced.`,
    );
  }
  if (rootfsLayers(ONE_SHOT_IMAGE) !== builtLayers) {
    throw new Error(`${ONE_SHOT_IMAGE} does not have the reviewed image rootfs`);
  }
}

function rootfsLayers(name: string): string {
  const layers = run(["image", "inspect", "--format", "{{json .RootFS.Layers}}", name]);
  if (!layers.startsWith("[") || layers === "[]" || layers === "null") {
    throw new Error(`image ${name} has no rootfs layers`);
  }
  return layers;
}

function assertRuntime(tag: string): void {
  const node = run(["run", "--rm", "--pull", "never", "--entrypoint", "node", tag, "-p", "process.version"]);
  if (!node.startsWith("v22.")) throw new Error(`reviewed image node runtime is ${node}`);
  const prisma = run([
    "run",
    "--rm",
    "--pull",
    "never",
    "--entrypoint",
    "/opt/migrator/node_modules/prisma/build/index.js",
    tag,
    "--version",
  ]);
  if (!prisma.includes("6.19.3")) throw new Error(`reviewed image prisma runtime is ${prisma}`);
  const openssl = run(["run", "--rm", "--pull", "never", "--entrypoint", "openssl", tag, "version"]);
  if (!/OpenSSL 3\.0\.22/i.test(openssl)) throw new Error(`reviewed image openssl is ${openssl}`);
}

function imageId(name: string): string {
  const id = run(["image", "inspect", "--format", "{{.Id}}", name]);
  if (!IMAGE_ID.test(id)) throw new Error(`image id for ${name} is not a Docker digest`);
  return id;
}

function run(args: string[]): string {
  const child = spawnSync("docker", args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (child.status !== 0 || child.signal) {
    throw new Error(`${args[0] ?? "docker"} failed: ${tail(child.stderr || child.stdout)}`);
  }
  return (child.stdout ?? "").trim();
}

function tail(value: string | null | undefined): string {
  return (value ?? "").trim().slice(-800);
}
