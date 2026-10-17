import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ONE_SHOT_IMAGE } from "@/server/internal/p1-isolated-runner/p1-release-gate";
import {
  decideOperatorTag,
  mayRemoveOwnedTag,
  sameImageIdentity,
} from "@/server/internal/p1-isolated-runner/oneshot-recipe-build";

const docker = vi.hoisted(() => ({
  images: new Map<string, string>(),
  commands: [] as string[][],
  failBuild: false,
  leavePartialBuild: false,
  failRuntime: false,
  buildId: `sha256:${"1".repeat(64)}`,
}));

vi.mock("node:child_process", () => ({
  spawnSync: (_command: string, args: readonly string[]) => {
    docker.commands.push([...args]);
    const [action] = args;
    if (action === "image" && args[1] === "inspect") {
      const name = args.at(-1) ?? "";
      const id = docker.images.get(name);
      if (!id) return { status: 1, signal: null, stdout: "", stderr: `Error: No such image: ${name}` };
      return { status: 0, signal: null, stdout: `${id}\n`, stderr: "" };
    }
    if (action === "build") {
      const tag = args[args.indexOf("-t") + 1] ?? "";
      if (docker.leavePartialBuild) docker.images.set(tag, docker.buildId);
      if (docker.failBuild) return { status: 1, signal: null, stdout: "", stderr: "build failed" };
      docker.images.set(tag, docker.buildId);
      return { status: 0, signal: null, stdout: "built", stderr: "" };
    }
    if (action === "tag") {
      docker.images.set(args[2] ?? "", args[1] ?? "");
      return { status: 0, signal: null, stdout: "", stderr: "" };
    }
    if (action === "rmi") {
      docker.images.delete(args[1] ?? "");
      return { status: 0, signal: null, stdout: "", stderr: "" };
    }
    if (action === "run") {
      if (docker.failRuntime) return { status: 1, signal: null, stdout: "", stderr: "runtime failed" };
      if (args.includes("-p")) return { status: 0, signal: null, stdout: "v22.23.3\n", stderr: "" };
      if (args.includes("--version")) return { status: 0, signal: null, stdout: "prisma : 6.19.3\n", stderr: "" };
      return { status: 0, signal: null, stdout: "OpenSSL 3.0.22\n", stderr: "" };
    }
    return { status: 1, signal: null, stdout: "", stderr: "unexpected docker command" };
  },
}));

const BUILT = `sha256:${"a".repeat(64)}`;
const FOREIGN = `sha256:${"b".repeat(64)}`;
const OWNED = `sha256:${"c".repeat(64)}`;
const LAYER = `sha256:${"d".repeat(64)}`;
const CONFIG_A = `sha256:${"e".repeat(64)}`;
const CONFIG_B = `sha256:${"f".repeat(64)}`;

describe("one-shot recipe image identity", () => {
  it("rejects an existing tag with the same rootfs layers and a different config", () => {
    const existing = { id: FOREIGN, layers: [LAYER], config: CONFIG_A };
    const built = { id: BUILT, layers: [LAYER], config: CONFIG_B };
    expect(existing.layers).toEqual(built.layers);
    expect(sameImageIdentity(existing, built)).toBe(false);
    expect(decideOperatorTag({ builtId: built.id, existingId: existing.id, ownedId: null })).toEqual({
      action: "reject",
      existingId: FOREIGN,
    });
  });

  it("reuses a tag only when the immutable image id matches", () => {
    expect(decideOperatorTag({ builtId: BUILT, existingId: BUILT, ownedId: null })).toEqual({ action: "reuse-exact" });
    expect(sameImageIdentity({ id: BUILT, config: CONFIG_A }, { id: BUILT, config: CONFIG_A })).toBe(true);
  });

  it("refuses a different image id that this process does not own", () => {
    expect(decideOperatorTag({ builtId: BUILT, existingId: FOREIGN, ownedId: null })).toEqual({
      action: "reject",
      existingId: FOREIGN,
    });
    expect(decideOperatorTag({ builtId: BUILT, existingId: FOREIGN, ownedId: OWNED })).toEqual({
      action: "reject",
      existingId: FOREIGN,
    });
  });

  it("tags a fresh build when the operator tag is absent", () => {
    expect(decideOperatorTag({ builtId: BUILT, existingId: null, ownedId: null })).toEqual({ action: "tag-new" });
  });

  it("replaces only the image id this process published", () => {
    expect(decideOperatorTag({ builtId: BUILT, existingId: OWNED, ownedId: OWNED })).toEqual({
      action: "replace-owned",
      previousId: OWNED,
    });
  });

  it("removes a tag only when this process created that exact id", () => {
    expect(mayRemoveOwnedTag({ currentId: BUILT, expectedId: BUILT, createdByUs: true })).toBe(true);
    expect(mayRemoveOwnedTag({ currentId: FOREIGN, expectedId: BUILT, createdByUs: true })).toBe(false);
    expect(mayRemoveOwnedTag({ currentId: BUILT, expectedId: BUILT, createdByUs: false })).toBe(false);
    expect(mayRemoveOwnedTag({ currentId: null, expectedId: BUILT, createdByUs: true })).toBe(false);
  });

  it("does not accept an operator tag from rootfs equality", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/server/internal/p1-isolated-runner/oneshot-recipe-build.ts"), "utf8");
    expect(source).not.toContain("RootFS");
  });
});

describe("one-shot recipe disposable image lifecycle", () => {
  beforeEach(() => {
    docker.images.clear();
    docker.commands.length = 0;
    docker.failBuild = false;
    docker.leavePartialBuild = false;
    docker.failRuntime = false;
    docker.buildId = `sha256:${"1".repeat(64)}`;
    vi.resetModules();
  });

  async function load() {
    return import("@/server/internal/p1-isolated-runner/oneshot-recipe-build");
  }

  it("tags a fresh build and checks runtime against that image id", async () => {
    const { buildReviewedOneShotImage, attachReviewedImageToOperatorTag, recipeActions, releaseOwnedOperatorTag } = await load();
    const built = buildReviewedOneShotImage();
    expect(attachReviewedImageToOperatorTag(built)).toEqual({ action: "tag-new" });
    expect(docker.images.get(ONE_SHOT_IMAGE)).toBe(built.id);
    expect(docker.commands.some((args) => args[0] === "run" && args.includes(built.id))).toBe(true);
    expect(docker.commands.some((args) => args[0] === "run" && args.includes(ONE_SHOT_IMAGE))).toBe(false);
    expect(recipeActions()).toEqual(expect.arrayContaining([{ action: "built", tag: built.tag, id: built.id }, { action: "tagged", id: built.id }]));
    built.remove();
    releaseOwnedOperatorTag();
    expect(docker.images.has(built.tag)).toBe(false);
    expect(docker.images.has(ONE_SHOT_IMAGE)).toBe(false);
  });

  it("uses the second reviewed build instead of the image this process published earlier", async () => {
    const { buildReviewedOneShotImage, attachReviewedImageToOperatorTag } = await load();
    const first = buildReviewedOneShotImage();
    attachReviewedImageToOperatorTag(first);
    const firstId = first.id;
    docker.buildId = `sha256:${"2".repeat(64)}`;
    const second = buildReviewedOneShotImage();
    expect(attachReviewedImageToOperatorTag(second)).toEqual({ action: "replace-owned", previousId: firstId });
    expect(docker.images.get(ONE_SHOT_IMAGE)).toBe(second.id);
    first.remove();
    second.remove();
  });

  it("preserves a foreign operator tag and does not retag it", async () => {
    docker.images.set(ONE_SHOT_IMAGE, FOREIGN);
    const { buildReviewedOneShotImage, attachReviewedImageToOperatorTag, recipeActions } = await load();
    const built = buildReviewedOneShotImage();
    expect(() => attachReviewedImageToOperatorTag(built)).toThrow(/STOP: .* was not replaced/);
    expect(docker.images.get(ONE_SHOT_IMAGE)).toBe(FOREIGN);
    expect(docker.commands.some((args) => args[0] === "tag" && args[2] === ONE_SHOT_IMAGE)).toBe(false);
    expect(docker.commands.some((args) => args[0] === "rmi" && args[1] === ONE_SHOT_IMAGE)).toBe(false);
    expect(recipeActions()).toContainEqual({ action: "rejected", existingId: FOREIGN, builtId: built.id });
    built.remove();
    expect(docker.images.get(ONE_SHOT_IMAGE)).toBe(FOREIGN);
  });

  it("reuses the operator tag only when its image id is the reviewed build", async () => {
    docker.images.set(ONE_SHOT_IMAGE, docker.buildId);
    const { buildReviewedOneShotImage, attachReviewedImageToOperatorTag, releaseOwnedOperatorTag } = await load();
    const built = buildReviewedOneShotImage();
    expect(attachReviewedImageToOperatorTag(built)).toEqual({ action: "reuse-exact" });
    releaseOwnedOperatorTag();
    expect(docker.images.get(ONE_SHOT_IMAGE)).toBe(docker.buildId);
    built.remove();
    expect(docker.images.get(ONE_SHOT_IMAGE)).toBe(docker.buildId);
  });

  it("removes a partial build tag after a failed build", async () => {
    docker.failBuild = true;
    docker.leavePartialBuild = true;
    const { buildReviewedOneShotImage } = await load();
    expect(() => buildReviewedOneShotImage()).toThrow(/reviewed one-shot build failed/);
    expect([...docker.images.keys()].some((name) => name.startsWith("p1pa-oneshot-"))).toBe(false);
    expect(docker.images.has(ONE_SHOT_IMAGE)).toBe(false);
  });

  it("removes the operator tag this process published when runtime verification fails", async () => {
    const { buildReviewedOneShotImage, attachReviewedImageToOperatorTag } = await load();
    const built = buildReviewedOneShotImage();
    docker.failRuntime = true;
    expect(() => attachReviewedImageToOperatorTag(built)).toThrow(/runtime failed/);
    expect(docker.images.has(ONE_SHOT_IMAGE)).toBe(false);
    expect(docker.images.get(built.tag)).toBe(built.id);
    built.remove();
    expect(docker.images.has(built.tag)).toBe(false);
  });

  it("does not remove the operator tag when its id is no longer the one this process published", async () => {
    const { buildReviewedOneShotImage, attachReviewedImageToOperatorTag, releaseOwnedOperatorTag } = await load();
    const built = buildReviewedOneShotImage();
    attachReviewedImageToOperatorTag(built);
    docker.images.set(ONE_SHOT_IMAGE, FOREIGN);
    releaseOwnedOperatorTag();
    expect(docker.images.get(ONE_SHOT_IMAGE)).toBe(FOREIGN);
    built.remove();
    expect(docker.images.get(ONE_SHOT_IMAGE)).toBe(FOREIGN);
  });
});
