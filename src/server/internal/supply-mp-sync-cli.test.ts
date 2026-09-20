import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const cliRel = "scripts/run-mp-sync.ts";
const cliAbs = path.join(root, cliRel);
const tsxCli = path.join(root, "node_modules/tsx/dist/cli.mjs");

function readCli(): string {
  return readFileSync(cliAbs, "utf8");
}

function runCli(args: string[]) {
  return spawnSync(process.execPath, [tsxCli, cliRel, ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://nouser:nopass@127.0.0.1:1/nodb",
    },
  });
}

describe("marketplace sync CLI physical disable", () => {
  it("does not impersonate ADMIN or invoke authenticated USER sync", () => {
    const src = readCli();
    expect(src).toContain("MP_SYNC_CLI_PHYSICAL_EXECUTION_DISABLED");
    expect(src).toContain("syncMarketplaces()");
    expect(src).not.toContain("syncMarketplacesAsUserInternal");
    expect(src).not.toContain("userMovementActorFromAdmin");
    expect(src).not.toContain('role: "ADMIN"');
    expect(src).not.toContain("findFirst");
    expect(src).not.toContain("prisma");
    expect(src).not.toContain("applySupplyDeduction");
    expect(src).not.toContain("appendSupplyConsumeShadowMovement");
    expect(src).not.toContain("InventoryMovement");
  });

  it("import-only smoke still exits 0 without physical work", () => {
    const result = runCli(["--import-only"]);
    expect(result.status).toBe(0);
    expect(`${result.stdout ?? ""}${result.stderr ?? ""}`).toContain("CLI import ok: scripts/run-mp-sync.ts");
  });

  it("normal execution fails closed and cannot mutate Supply", () => {
    const result = runCli([]);
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(result.status).not.toBe(0);
    expect(output).toContain("MP_SYNC_CLI_PHYSICAL_EXECUTION_DISABLED");
    expect(output).toMatch(/authenticated application action|syncMarketplaces\(\)/);
  });
});
