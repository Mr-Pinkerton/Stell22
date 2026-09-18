import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  InventoryMovementShadowCoordinationError,
  acquireInventoryMovementShadowControlLock,
  acquireInventoryMovementShadowResetLock,
  acquireInventoryMovementShadowWriterLock,
  assertInventoryMovementShadowTransactionClient,
} from "./inventory-movement-shadow-coordination";
import {
  INVENTORY_MOVEMENT_SHADOW_WRITE_KEY,
  InventoryMovementShadowWriteConfigError,
  isInventoryMovementShadowWriteActiveForWriter,
  parseInventoryMovementShadowWriteValue,
  readInventoryMovementShadowWriteGate,
  setInventoryMovementShadowWriteGate,
} from "./inventory-movement-shadow-write";

function fakeTx(options: {
  settingValue?: unknown | null;
  hasTransaction?: boolean;
  calls?: string[];
  upserts?: Array<{ key: string; value: unknown }>;
}) {
  const calls = options.calls ?? [];
  const upserts = options.upserts ?? [];
  const settingValue = options.settingValue === undefined ? null : options.settingValue;
  const tx: Record<string, unknown> = {
    $queryRaw: async () => {
      calls.push("lock");
      return [];
    },
    setting: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        calls.push(`setting:${where.key}`);
        if (settingValue === null) return null;
        return { key: INVENTORY_MOVEMENT_SHADOW_WRITE_KEY, value: settingValue };
      },
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { key: string };
        create: { key: string; value: unknown };
        update: { value: unknown };
      }) => {
        calls.push(`upsert:${where.key}`);
        upserts.push({ key: where.key, value: update.value ?? create.value });
        return { key: where.key, value: update.value ?? create.value };
      },
    },
  };
  if (options.hasTransaction) {
    tx.$transaction = async () => undefined;
  }
  return tx as never;
}

describe("parseInventoryMovementShadowWriteValue", () => {
  it("version=1 active=false is inactive", () => {
    expect(parseInventoryMovementShadowWriteValue({ version: 1, active: false })).toEqual({
      active: false,
    });
  });

  it("version=1 active=true is active", () => {
    expect(parseInventoryMovementShadowWriteValue({ version: 1, active: true })).toEqual({
      active: true,
    });
  });

  it("malformed value fails closed with dedicated configuration error", () => {
    expect(() => parseInventoryMovementShadowWriteValue("yes")).toThrow(
      InventoryMovementShadowWriteConfigError,
    );
    expect(() => parseInventoryMovementShadowWriteValue(null)).toThrow(
      InventoryMovementShadowWriteConfigError,
    );
    expect(() => parseInventoryMovementShadowWriteValue({ active: true })).toThrow(
      InventoryMovementShadowWriteConfigError,
    );
    expect(() => parseInventoryMovementShadowWriteValue({ version: 2, active: true })).toThrow(
      InventoryMovementShadowWriteConfigError,
    );
    expect(() => parseInventoryMovementShadowWriteValue({ version: 1, active: "true" })).toThrow(
      InventoryMovementShadowWriteConfigError,
    );
    expect(() => parseInventoryMovementShadowWriteValue([])).toThrow(
      InventoryMovementShadowWriteConfigError,
    );
  });
});

describe("transaction client requirement", () => {
  it("rejects a root-style client that has $transaction", () => {
    const root = fakeTx({ hasTransaction: true });
    expect(() => assertInventoryMovementShadowTransactionClient(root)).toThrow(
      InventoryMovementShadowCoordinationError,
    );
  });

  it("writer-facing gate rejects root-style prisma before Setting read", async () => {
    const calls: string[] = [];
    const root = fakeTx({
      hasTransaction: true,
      settingValue: { version: 1, active: true },
      calls,
    });
    await expect(isInventoryMovementShadowWriteActiveForWriter(root)).rejects.toBeInstanceOf(
      InventoryMovementShadowCoordinationError,
    );
    expect(calls).toEqual([]);
  });

  it("gate setter rejects root-style prisma before lock or upsert", async () => {
    const calls: string[] = [];
    const root = fakeTx({ hasTransaction: true, calls });
    await expect(setInventoryMovementShadowWriteGate(root, true)).rejects.toBeInstanceOf(
      InventoryMovementShadowCoordinationError,
    );
    expect(calls).toEqual([]);
  });
});

describe("isInventoryMovementShadowWriteActiveForWriter", () => {
  it("uses dedicated Setting key independent from production_cost_flow", () => {
    expect(INVENTORY_MOVEMENT_SHADOW_WRITE_KEY).toBe("inventory_movement_shadow_write");
    expect(INVENTORY_MOVEMENT_SHADOW_WRITE_KEY).not.toBe("production_cost_flow");
  });

  it("acquires SHARED coordination before Setting read", async () => {
    const calls: string[] = [];
    const tx = fakeTx({ settingValue: null, calls });
    expect(await isInventoryMovementShadowWriteActiveForWriter(tx)).toBe(false);
    expect(calls).toEqual(["lock", "setting:inventory_movement_shadow_write"]);
  });

  it("missing Setting is inactive", async () => {
    expect(await isInventoryMovementShadowWriteActiveForWriter(fakeTx({ settingValue: null }))).toBe(
      false,
    );
  });

  it("valid active=false is inactive", async () => {
    expect(
      await isInventoryMovementShadowWriteActiveForWriter(
        fakeTx({ settingValue: { version: 1, active: false } }),
      ),
    ).toBe(false);
  });

  it("valid active=true is active", async () => {
    expect(
      await isInventoryMovementShadowWriteActiveForWriter(
        fakeTx({ settingValue: { version: 1, active: true } }),
      ),
    ).toBe(true);
  });

  it("malformed stored value fails closed", async () => {
    await expect(
      isInventoryMovementShadowWriteActiveForWriter(
        fakeTx({ settingValue: { version: 1, active: "yes" } }),
      ),
    ).rejects.toBeInstanceOf(InventoryMovementShadowWriteConfigError);
  });
});

describe("readInventoryMovementShadowWriteGate", () => {
  it("does not acquire writer/reset lock", async () => {
    const calls: string[] = [];
    const tx = fakeTx({ settingValue: { version: 1, active: false }, calls });
    expect(await readInventoryMovementShadowWriteGate(tx)).toBe(false);
    expect(calls).toEqual(["setting:inventory_movement_shadow_write"]);
  });
});

describe("setInventoryMovementShadowWriteGate", () => {
  it("uses dedicated Setting key independent from production_cost_flow", () => {
    expect(INVENTORY_MOVEMENT_SHADOW_WRITE_KEY).toBe("inventory_movement_shadow_write");
    expect(INVENTORY_MOVEMENT_SHADOW_WRITE_KEY).not.toBe("production_cost_flow");
  });

  it("acquires EXCLUSIVE control lock before Setting upsert", async () => {
    const calls: string[] = [];
    const upserts: Array<{ key: string; value: unknown }> = [];
    const tx = fakeTx({ calls, upserts });
    expect(await setInventoryMovementShadowWriteGate(tx, true)).toBe(true);
    expect(calls).toEqual(["lock", "upsert:inventory_movement_shadow_write"]);
  });

  it("active=true stores exactly { version: 1, active: true }", async () => {
    const upserts: Array<{ key: string; value: unknown }> = [];
    await setInventoryMovementShadowWriteGate(fakeTx({ upserts }), true);
    expect(upserts).toEqual([
      { key: INVENTORY_MOVEMENT_SHADOW_WRITE_KEY, value: { version: 1, active: true } },
    ]);
  });

  it("active=false stores exactly { version: 1, active: false }", async () => {
    const upserts: Array<{ key: string; value: unknown }> = [];
    await setInventoryMovementShadowWriteGate(fakeTx({ upserts }), false);
    expect(upserts).toEqual([
      { key: INVENTORY_MOVEMENT_SHADOW_WRITE_KEY, value: { version: 1, active: false } },
    ]);
  });
});

describe("acquire lock helpers", () => {
  it("writer lock issues SHARED advisory lock SQL", async () => {
    const calls: string[] = [];
    await acquireInventoryMovementShadowWriterLock(fakeTx({ calls }));
    expect(calls).toEqual(["lock"]);
  });

  it("reset lock is the exclusive control primitive", async () => {
    expect(acquireInventoryMovementShadowResetLock).toBe(acquireInventoryMovementShadowControlLock);
    const calls: string[] = [];
    await acquireInventoryMovementShadowResetLock(fakeTx({ calls }));
    expect(calls).toEqual(["lock"]);
  });

  it("control lock issues EXCLUSIVE advisory lock SQL", async () => {
    const calls: string[] = [];
    await acquireInventoryMovementShadowControlLock(fakeTx({ calls }));
    expect(calls).toEqual(["lock"]);
  });
});

describe("no InventoryMovement runtime writers", () => {
  it("only the approved gateway may insert InventoryMovement rows from application src", () => {
    const root = path.join(process.cwd(), "src");
    const hits: string[] = [];
    const allowed = new Set(["src/server/internal/inventory-movement-shadow-gateway.ts"]);
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "integrity") continue;
          walk(absolute);
          continue;
        }
        if (!entry.isFile() || !/\.(ts|tsx)$/.test(entry.name)) continue;
        if (entry.name.includes(".test.")) continue;
        const rel = path.relative(process.cwd(), absolute).replaceAll("\\", "/");
        if (allowed.has(rel)) continue;
        const text = fs.readFileSync(absolute, "utf8");
        if (
          /\binventoryMovement\s*\.\s*(createMany|create|updateMany|update|deleteMany|delete|upsert)\s*\(/.test(
            text,
          ) ||
          /\bINSERT\s+INTO\s+(?:(?:public\.)?(?:"InventoryMovement"|\bInventoryMovement\b))/i.test(text)
        ) {
          hits.push(rel);
        }
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });
});

describe("SHADOW write-gate control CLI", () => {
  it("calls the transaction-only setter with explicit on/off and confirmation", () => {
    const script = fs.readFileSync(
      path.join(process.cwd(), "scripts/set-inventory-movement-shadow-write.ts"),
      "utf8",
    );
    expect(script).toContain("setInventoryMovementShadowWriteGate");
    expect(script).toContain("--state=on");
    expect(script).toContain("--state=off");
    expect(script).toContain("--confirm=INVENTORY_MOVEMENT_SHADOW_WRITE_CONTROL");
    expect(script).toContain("$transaction");
    const txAt = script.lastIndexOf("prisma.$transaction");
    const setterCallAt = script.lastIndexOf("setInventoryMovementShadowWriteGate(tx");
    expect(txAt).toBeGreaterThan(-1);
    expect(setterCallAt).toBeGreaterThan(txAt);
  });
});
