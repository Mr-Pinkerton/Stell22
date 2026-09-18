import { describe, expect, it } from "vitest";
import { InventoryMovementShadowCoordinationError } from "@/server/internal/inventory-movement-shadow-coordination";
import {
  appendShadowInventoryMovements,
  InventoryMovementShadowGatewayError,
} from "@/server/internal/inventory-movement-shadow-gateway";
import { userMovementActorFromAdmin } from "@/server/internal/inventory-movement-actor";
import { INVENTORY_MOVEMENT_SHADOW_WRITE_KEY } from "@/server/internal/inventory-movement-shadow-write";
import type { MovementEffect } from "@/server/internal/inventory-movement-identity";

function railReceipt(effectKeySeed: string, quantityDelta = 2): MovementEffect {
  return {
    role: "receipt",
    kind: "RECEIPT",
    quantityDelta,
    target: { stockDomain: "RAIL_LOT", railLotId: effectKeySeed },
  };
}

function fakeTx(options: {
  settingValue?: unknown | null;
  hasTransaction?: boolean;
  calls?: string[];
  inserts?: unknown[];
}) {
  const calls = options.calls ?? [];
  const inserts = options.inserts ?? [];
  const settingValue = options.settingValue === undefined ? null : options.settingValue;
  const tx: Record<string, unknown> = {
    $queryRaw: async () => {
      calls.push("lock");
      return [];
    },
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("?");
      calls.push("insert");
      inserts.push({ sql, values });
      return 1;
    },
    setting: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        calls.push(`setting:${where.key}`);
        if (settingValue === null) return null;
        return { key: INVENTORY_MOVEMENT_SHADOW_WRITE_KEY, value: settingValue };
      },
    },
  };
  if (options.hasTransaction) {
    tx.$transaction = async () => undefined;
  }
  return tx as never;
}

const actor = userMovementActorFromAdmin({ id: "user-1", name: "Admin" });
const causation = { causationKind: "BATCH" as const, causationId: "batch-1" };
const effectiveAt = new Date("2026-09-18T12:00:00.000Z");

describe("appendShadowInventoryMovements", () => {
  it("rejects a root Prisma client fail-closed before lock or insert", async () => {
    const calls: string[] = [];
    const root = fakeTx({
      hasTransaction: true,
      settingValue: { version: 1, active: true },
      calls,
    });
    await expect(
      appendShadowInventoryMovements(root, {
        effectiveAt,
        actor,
        causation,
        effects: [railReceipt("lot-1")],
      }),
    ).rejects.toBeInstanceOf(InventoryMovementShadowCoordinationError);
    expect(calls).toEqual([]);
  });

  it("missing or inactive gate inserts zero rows", async () => {
    const missingInserts: unknown[] = [];
    const missing = await appendShadowInventoryMovements(
      fakeTx({ settingValue: null, inserts: missingInserts }),
      { effectiveAt, actor, causation, effects: [railReceipt("lot-1")] },
    );
    expect(missing).toEqual({ gateActive: false, inserted: 0 });
    expect(missingInserts).toEqual([]);

    const inactiveInserts: unknown[] = [];
    const inactive = await appendShadowInventoryMovements(
      fakeTx({ settingValue: { version: 1, active: false }, inserts: inactiveInserts }),
      { effectiveAt, actor, causation, effects: [railReceipt("lot-1")] },
    );
    expect(inactive).toEqual({ gateActive: false, inserted: 0 });
    expect(inactiveInserts).toEqual([]);
  });

  it("omits zero quantityDelta and does not supply recordedAt", async () => {
    const inserts: Array<{ sql: string; values: unknown[] }> = [];
    const result = await appendShadowInventoryMovements(
      fakeTx({ settingValue: { version: 1, active: true }, inserts }),
      {
        effectiveAt,
        actor,
        causation,
        effects: [railReceipt("lot-zero", 0), railReceipt("lot-2", 3)],
      },
    );
    expect(result).toEqual({ gateActive: true, inserted: 1 });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.sql).toContain('INSERT INTO "InventoryMovement"');
    expect(inserts[0]?.sql).not.toContain("recordedAt");
    expect(inserts[0]?.values).toContain("2026-09-18T12:00:00.000");
  });

  it("inserts in canonical effectKey order regardless of input array order", async () => {
    const forward: Array<{ values: unknown[] }> = [];
    const reverse: Array<{ values: unknown[] }> = [];
    const effects: MovementEffect[] = [
      railReceipt("lot-z", 1),
      railReceipt("lot-a", 1),
    ];
    await appendShadowInventoryMovements(
      fakeTx({ settingValue: { version: 1, active: true }, inserts: forward }),
      { effectiveAt, actor, causation, effects },
    );
    await appendShadowInventoryMovements(
      fakeTx({ settingValue: { version: 1, active: true }, inserts: reverse }),
      { effectiveAt, actor, causation, effects: [...effects].reverse() },
    );
    const effectKeysOf = (rows: Array<{ values: unknown[] }>) =>
      rows.map((row) => String(row.values.find((value) => String(value).startsWith("imfx1:"))));
    const forwardKeys = effectKeysOf(forward);
    const reverseKeys = effectKeysOf(reverse);
    expect(forwardKeys).toEqual(reverseKeys);
    expect(forwardKeys).toHaveLength(2);
    expect(forwardKeys[0] < forwardKeys[1]).toBe(true);
  });

  it("rejects role/kind mismatches and P6/reversal kinds", async () => {
    const active = fakeTx({ settingValue: { version: 1, active: true } });
    await expect(
      appendShadowInventoryMovements(active, {
        effectiveAt,
        actor,
        causation,
        effects: [
          {
            role: "consume",
            kind: "ADJUSTMENT",
            quantityDelta: -5,
            target: { stockDomain: "RAIL_LOT", railLotId: "lot-1" },
          } as unknown as MovementEffect,
        ],
      }),
    ).rejects.toBeInstanceOf(InventoryMovementShadowGatewayError);
    await expect(
      appendShadowInventoryMovements(active, {
        effectiveAt,
        actor,
        causation,
        effects: [
          {
            role: "adjust",
            kind: "RECEIPT",
            quantityDelta: 5,
            target: { stockDomain: "RAIL_LOT", railLotId: "lot-1" },
          } as unknown as MovementEffect,
        ],
      }),
    ).rejects.toBeInstanceOf(InventoryMovementShadowGatewayError);
    await expect(
      appendShadowInventoryMovements(active, {
        effectiveAt,
        actor,
        causation,
        effects: [
          {
            role: "receipt",
            kind: "OPENING_BALANCE",
            quantityDelta: 5,
            target: { stockDomain: "RAIL_LOT", railLotId: "lot-1" },
          } as unknown as MovementEffect,
        ],
      }),
    ).rejects.toThrow(/OPENING_BALANCE/);
    await expect(
      appendShadowInventoryMovements(active, {
        effectiveAt,
        actor,
        causation,
        effects: [
          {
            role: "adjust",
            kind: "REVERSAL",
            quantityDelta: -1,
            target: { stockDomain: "RAIL_LOT", railLotId: "lot-1" },
          } as unknown as MovementEffect,
        ],
      }),
    ).rejects.toThrow(/REVERSAL/);
  });

  it("rejects an oversized effectKey qualifier before insert", async () => {
    const inserts: unknown[] = [];
    await expect(
      appendShadowInventoryMovements(
        fakeTx({ settingValue: { version: 1, active: true }, inserts }),
        {
          effectiveAt,
          actor,
          causation,
          effects: [{ ...railReceipt("lot-1"), qualifier: "q".repeat(200) }],
        },
      ),
    ).rejects.toBeInstanceOf(InventoryMovementShadowGatewayError);
    expect(inserts).toEqual([]);
  });

  it("rejects non-integer quantityDelta", async () => {
    await expect(
      appendShadowInventoryMovements(
        fakeTx({ settingValue: { version: 1, active: true } }),
        {
          effectiveAt,
          actor,
          causation,
          effects: [{ ...railReceipt("lot-1"), quantityDelta: 1.5 }],
        },
      ),
    ).rejects.toBeInstanceOf(InventoryMovementShadowGatewayError);
  });
});
