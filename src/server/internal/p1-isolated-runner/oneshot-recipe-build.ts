import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ONE_SHOT_IMAGE } from "@/server/internal/p1-isolated-runner/p1-release-gate";

const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const RECIPE_FILES = ["Dockerfile", "package.json", "package-lock.json"] as const;

export type OperatorTagDecision =
  | { action: "tag-new" }
  | { action: "reuse-exact" }
  | { action: "replace-owned"; previousId: string }
  | { action: "reject"; existingId: string };

export type RecipeAction =
  | { action: "built"; tag: string; id: string }
  | { action: "tagged"; id: string }
  | { action: "reused"; id: string }
  | { action: "replaced-owned"; previousId: string; id: string }
  | { action: "rejected"; existingId: string; builtId: string }
  | { action: "removed-owned"; name: string; id: string };

export type ReviewedOneShotBuild = {
  tag: string;
  id: string;
  remove(): void;
};

const actions: RecipeAction[] = [];
let ownedOperatorId: string | null = null;

export function recipeActions(): readonly RecipeAction[] {
  return actions.slice();
}

/**
 * Image identity is the immutable id. Equal rootfs layers do not make two
 * images the same when their config digests differ.
 */
export function sameImageIdentity(
  left: { id: string; config: string },
  right: { id: string; config: string },
): boolean {
  return left.id === right.id && left.config === right.config;
}

export function decideOperatorTag(input: {
  builtId: string;
  existingId: string | null;
  ownedId: string | null;
}): OperatorTagDecision {
  if (!IMAGE_ID.test(input.builtId)) throw new Error("reviewed one-shot id is not a Docker image digest");
  if (input.existingId === null) return { action: "tag-new" };
  if (!IMAGE_ID.test(input.existingId)) throw new Error("existing one-shot tag id is not a Docker image digest");
  if (input.existingId === input.builtId) return { action: "reuse-exact" };
  if (input.ownedId !== null && input.existingId === input.ownedId) {
    return { action: "replace-owned", previousId: input.existingId };
  }
  return { action: "reject", existingId: input.existingId };
}

export function mayRemoveOwnedTag(input: {
  currentId: string | null;
  expectedId: string;
  createdByUs: boolean;
}): boolean {
  return input.createdByUs && input.currentId !== null && input.currentId === input.expectedId && IMAGE_ID.test(input.expectedId);
}

export function buildReviewedOneShotImage(): ReviewedOneShotBuild {
  const tag = `p1pa-oneshot-${randomBytes(8).toString("hex")}`;
  if (readImageId(tag) !== null) {
    throw new Error(`STOP: ${tag} already exists. It was not replaced.`);
  }
  const context = fs.mkdtempSync(path.join(os.tmpdir(), "p1pa-oneshot-recipe-"));
  const recipeDir = path.join(process.cwd(), "docker", "p1-oneshot");
  let created = false;
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
    created = readImageId(tag) !== null;
    if (built.status !== 0 || built.signal) {
      throw new Error(`reviewed one-shot build failed: ${tail(built.stderr || built.stdout)}`);
    }
    const id = imageId(tag);
    assertRuntime(id);
    actions.push({ action: "built", tag, id });
    return {
      tag,
      id,
      remove() {
        removeTagIfIdentity(tag, id, true);
      },
    };
  } catch (error) {
    if (created) {
      const current = readImageId(tag);
      if (current !== null) removeTagIfIdentity(tag, current, true);
    }
    throw error;
  } finally {
    fs.rmSync(context, { recursive: true, force: true });
  }
}

export function attachReviewedImageToOperatorTag(built: ReviewedOneShotBuild): OperatorTagDecision {
  const existingId = readImageId(ONE_SHOT_IMAGE);
  const decision = decideOperatorTag({ builtId: built.id, existingId, ownedId: ownedOperatorId });
  if (decision.action === "reject") {
    actions.push({ action: "rejected", existingId: decision.existingId, builtId: built.id });
    throw new Error(
      `STOP: ${ONE_SHOT_IMAGE} already exists as ${decision.existingId} and is not the reviewed build ${built.id}. The existing tag was not replaced.`,
    );
  }
  if (decision.action === "reuse-exact") {
    actions.push({ action: "reused", id: built.id });
    assertRuntime(built.id);
    return decision;
  }
  if (decision.action === "replace-owned") {
    removeTagIfIdentity(ONE_SHOT_IMAGE, decision.previousId, true);
    ownedOperatorId = null;
  }
  publishOperatorTag(built.id);
  try {
    assertRuntime(built.id);
  } catch (error) {
    removeTagIfIdentity(ONE_SHOT_IMAGE, built.id, true);
    ownedOperatorId = null;
    throw error;
  }
  ownedOperatorId = built.id;
  actions.push(
    decision.action === "replace-owned"
      ? { action: "replaced-owned", previousId: decision.previousId, id: built.id }
      : { action: "tagged", id: built.id },
  );
  return decision;
}

export function releaseOwnedOperatorTag(): void {
  if (ownedOperatorId === null) return;
  const expected = ownedOperatorId;
  const current = readImageId(ONE_SHOT_IMAGE);
  if (!mayRemoveOwnedTag({ currentId: current, expectedId: expected, createdByUs: true })) {
    ownedOperatorId = null;
    return;
  }
  removeTagIfIdentity(ONE_SHOT_IMAGE, expected, true);
  ownedOperatorId = null;
}

function publishOperatorTag(id: string): void {
  const tagged = spawnSync("docker", ["tag", id, ONE_SHOT_IMAGE], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  });
  if (tagged.status !== 0 || tagged.signal) {
    throw new Error(`could not publish the reviewed image to ${ONE_SHOT_IMAGE}: ${tail(tagged.stderr || tagged.stdout)}`);
  }
  if (imageId(ONE_SHOT_IMAGE) !== id) {
    throw new Error(`${ONE_SHOT_IMAGE} does not name the reviewed build ${id}`);
  }
}

function removeTagIfIdentity(name: string, expectedId: string, createdByUs: boolean): void {
  const currentId = readImageId(name);
  if (!mayRemoveOwnedTag({ currentId, expectedId, createdByUs })) {
    if (currentId !== null) {
      throw new Error(`refusing to remove ${name}: id is ${currentId}, expected ${expectedId}`);
    }
    return;
  }
  const removed = spawnSync("docker", ["rmi", name], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  });
  if (removed.status !== 0 && !/no such image/i.test(`${removed.stderr}`)) {
    throw new Error(`could not remove test-owned tag ${name}: ${tail(removed.stderr || removed.stdout)}`);
  }
  actions.push({ action: "removed-owned", name, id: expectedId });
}

function assertRuntime(id: string): void {
  if (!IMAGE_ID.test(id)) throw new Error("runtime check id is not a Docker image digest");
  const node = run(["run", "--rm", "--pull", "never", "--entrypoint", "node", id, "-p", "process.version"]);
  if (!node.startsWith("v22.")) throw new Error(`reviewed image node runtime is ${node}`);
  const prisma = run([
    "run",
    "--rm",
    "--pull",
    "never",
    "--entrypoint",
    "/opt/migrator/node_modules/prisma/build/index.js",
    id,
    "--version",
  ]);
  if (!prisma.includes("6.19.3")) throw new Error(`reviewed image prisma runtime is ${prisma}`);
  const openssl = run(["run", "--rm", "--pull", "never", "--entrypoint", "openssl", id, "version"]);
  if (!/OpenSSL 3\.0\.22/i.test(openssl)) throw new Error(`reviewed image openssl is ${openssl}`);
}

function imageId(name: string): string {
  const id = readImageId(name);
  if (id === null || !IMAGE_ID.test(id)) throw new Error(`image id for ${name} is not a Docker digest`);
  return id;
}

function readImageId(name: string): string | null {
  const child = spawnSync("docker", ["image", "inspect", "--format", "{{.Id}}", name], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  });
  if (child.status !== 0 || child.signal) {
    const stderr = child.stderr ?? "";
    if (!child.signal && child.status === 1 && /no such image/i.test(stderr) && !/no such file/i.test(stderr)) return null;
    throw new Error(`image inspect failed for ${name}: ${tail(stderr || child.stdout)}`);
  }
  const id = child.stdout.trim();
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
