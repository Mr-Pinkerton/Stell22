import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import { Prisma } from "@prisma/client";
import { createIntegrityClients, ensureIntegritySchema } from "./harness";
import { userMovementActorFromAdmin } from "@/server/internal/inventory-movement-actor";
import {
  canonicalizeMovementTarget,
  effectKeyV1,
  type MovementEffect,
} from "@/server/internal/inventory-movement-identity";
import { canonicalLengthFixed4 } from "@/server/internal/blank-length";
import { utcNaiveTimestampString } from "@/server/internal/inventory-movement-time";
import { appendShadowInventoryMovements } from "@/server/internal/inventory-movement-shadow-gateway";
import { InventoryMovementShadowCoordinationError } from "@/server/internal/inventory-movement-shadow-coordination";
import {
  INVENTORY_MOVEMENT_SHADOW_WRITE_KEY,
  InventoryMovementShadowWriteConfigError,
  setInventoryMovementShadowWriteGate,
} from "@/server/internal/inventory-movement-shadow-write";

function isRawUniqueViolation(err: unknown): boolean {
  const text = err instanceof Error ? `${err.message} ${err.stack ?? ""}` : String(err);
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? String((err as { code: unknown }).code)
      : "";
  return (
    code === "P2002" ||
    code === "23505" ||
    /23505/.test(text) ||
    /already exists/i.test(text) ||
    /unique constraint/i.test(text)
  );
}

const enabled = Boolean(process.env.INTEGRITY_TEST_DATABASE_URL);
const txOpts = { maxWait: 20_000, timeout: 20_000 } as const;
const FIXTURE_KEY = "psr_p2_guard_ci_fixture";

const actor = userMovementActorFromAdmin({ id: "integrity-admin", name: "Integrity Admin" });

function railReceipt(railLotId: string, quantityDelta = 2): MovementEffect {
  return {
    role: "receipt",
    kind: "RECEIPT",
    quantityDelta,
    target: { stockDomain: "RAIL_LOT", railLotId },
  };
}

function blankOutput(
  lengthM: number | string | Decimal,
  quantityDelta = 1,
): MovementEffect {
  return {
    role: "output",
    kind: "PRODUCTION_OUTPUT",
    quantityDelta,
    target: {
      stockDomain: "BLANK",
      materialId: "mat-guard",
      lengthM,
      detailType: "POLKA",
      sort: "SORT1",
    },
  };
}

describe.skipIf(!enabled)("PSR-P2-GUARD/CI SHADOW gateway", () => {
  let db: ReturnType<typeof createIntegrityClients>["prismaA"];

  beforeAll(() => {
    ensureIntegritySchema();
    ({ prismaA: db } = createIntegrityClients());
  });

  beforeEach(async () => {
    await db.$executeRawUnsafe(`DELETE FROM "InventoryMovement"`);
    await db.setting.deleteMany({
      where: { key: { in: [INVENTORY_MOVEMENT_SHADOW_WRITE_KEY, FIXTURE_KEY] } },
    });
  });

  afterAll(async () => {
    if (db) {
      await db.$executeRawUnsafe(`DELETE FROM "InventoryMovement"`);
      await db.setting.deleteMany({
        where: { key: { in: [INVENTORY_MOVEMENT_SHADOW_WRITE_KEY, FIXTURE_KEY] } },
      });
      await db.$disconnect();
    }
  });

  it("B: missing and explicit inactive gates insert zero movements", async () => {
    const missing = await db.$transaction(async (tx) => {
      return appendShadowInventoryMovements(tx, {
        effectiveAt: new Date("2026-09-18T12:00:00.000Z"),
        actor,
        causation: { causationKind: "BATCH", causationId: "batch-missing" },
        effects: [railReceipt("lot-missing")],
      });
    }, txOpts);
    expect(missing).toEqual({ gateActive: false, inserted: 0 });

    const inactive = await db.$transaction(async (tx) => {
      await setInventoryMovementShadowWriteGate(tx, false);
      return appendShadowInventoryMovements(tx, {
        effectiveAt: new Date("2026-09-18T12:00:00.000Z"),
        actor,
        causation: { causationKind: "BATCH", causationId: "batch-inactive" },
        effects: [railReceipt("lot-inactive")],
      });
    }, txOpts);
    expect(inactive).toEqual({ gateActive: false, inserted: 0 });
    expect(await db.inventoryMovement.count()).toBe(0);
  });

  it("B: malformed gate fails closed and active gate writes SHADOW with epochId NULL", async () => {
    await expect(
      db.$transaction(async (tx) => {
        await tx.setting.create({
          data: {
            key: INVENTORY_MOVEMENT_SHADOW_WRITE_KEY,
            value: { version: 1, active: "yes" },
          },
        });
        return appendShadowInventoryMovements(tx, {
          effectiveAt: new Date("2026-09-18T12:00:00.000Z"),
          actor,
          causation: { causationKind: "BATCH", causationId: "batch-bad" },
          effects: [railReceipt("lot-bad")],
        });
      }, txOpts),
    ).rejects.toBeInstanceOf(InventoryMovementShadowWriteConfigError);
    expect(await db.inventoryMovement.count()).toBe(0);

    const active = await db.$transaction(async (tx) => {
      await setInventoryMovementShadowWriteGate(tx, true);
      return appendShadowInventoryMovements(tx, {
        effectiveAt: new Date("2026-09-18T12:00:00.000Z"),
        actor,
        causation: { causationKind: "BATCH", causationId: "batch-active" },
        effects: [railReceipt("lot-active")],
      });
    }, txOpts);
    expect(active).toEqual({ gateActive: true, inserted: 1 });
    const row = await db.inventoryMovement.findFirst({ where: { causationId: "batch-active" } });
    expect(row?.authority).toBe("SHADOW");
    expect(row?.epochId).toBeNull();
  });

  it("C: movement insert rollback also rolls back same-transaction fixture state", async () => {
    await expect(
      db.$transaction(async (tx) => {
        await setInventoryMovementShadowWriteGate(tx, true);
        await appendShadowInventoryMovements(tx, {
          effectiveAt: new Date("2026-09-18T12:00:00.000Z"),
          actor,
          causation: { causationKind: "BATCH", causationId: "batch-rollback" },
          effects: [railReceipt("lot-rollback")],
        });
        await tx.setting.create({ data: { key: FIXTURE_KEY, value: { ok: true } } });
        throw new Error("rollback-gateway");
      }, txOpts),
    ).rejects.toThrow("rollback-gateway");
    expect(await db.inventoryMovement.count()).toBe(0);
    expect(await db.setting.findUnique({ where: { key: FIXTURE_KEY } })).toBeNull();
  });

  it("C: failed duplicate movement write rolls back the same-transaction fixture", async () => {
    await expect(
      db.$transaction(async (tx) => {
        await setInventoryMovementShadowWriteGate(tx, true);
        await tx.setting.create({ data: { key: FIXTURE_KEY, value: { step: 1 } } });
        const input = {
          effectiveAt: new Date("2026-09-18T12:00:00.000Z"),
          actor,
          causation: { causationKind: "BATCH" as const, causationId: "batch-dup-tx" },
          effects: [railReceipt("lot-dup-tx")],
        };
        await appendShadowInventoryMovements(tx, input);
        await appendShadowInventoryMovements(tx, input);
      }, txOpts),
    ).rejects.toSatisfy(isRawUniqueViolation);
    expect(await db.inventoryMovement.count()).toBe(0);
    expect(await db.setting.findUnique({ where: { key: FIXTURE_KEY } })).toBeNull();
  });

  it("D: TransactionClient is accepted and root Prisma is rejected", async () => {
    await expect(
      appendShadowInventoryMovements(db, {
        effectiveAt: new Date("2026-09-18T12:00:00.000Z"),
        actor,
        causation: { causationKind: "BATCH", causationId: "batch-root" },
        effects: [railReceipt("lot-root")],
      }),
    ).rejects.toBeInstanceOf(InventoryMovementShadowCoordinationError);
    expect(await db.inventoryMovement.count()).toBe(0);

    const ok = await db.$transaction(async (tx) => {
      await setInventoryMovementShadowWriteGate(tx, true);
      return appendShadowInventoryMovements(tx, {
        effectiveAt: new Date("2026-09-18T12:00:00.000Z"),
        actor,
        causation: { causationKind: "BATCH", causationId: "batch-tx" },
        effects: [railReceipt("lot-tx")],
      });
    }, txOpts);
    expect(ok).toEqual({ gateActive: true, inserted: 1 });
  });

  it("E: zero effects create zero movement rows", async () => {
    const result = await db.$transaction(async (tx) => {
      await setInventoryMovementShadowWriteGate(tx, true);
      return appendShadowInventoryMovements(tx, {
        effectiveAt: new Date("2026-09-18T12:00:00.000Z"),
        actor,
        causation: { causationKind: "BATCH", causationId: "batch-zero" },
        effects: [railReceipt("lot-zero", 0), { ...blankOutput("1.8000"), quantityDelta: 0 }],
      });
    }, txOpts);
    expect(result).toEqual({ gateActive: true, inserted: 0 });
    expect(await db.inventoryMovement.count()).toBe(0);
  });

  it("F: reversed inputs canonicalize to the same identity and order", async () => {
    const effects: MovementEffect[] = [
      blankOutput("1.8", 1),
      railReceipt("lot-b", 4),
      railReceipt("lot-a", 3),
    ];
    const expectedKeys = effects
      .map((effect) => {
        const canonical = canonicalizeMovementTarget(effect.target);
        return effectKeyV1(effect.role, canonical.targetHashV1, effect.qualifier);
      })
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    await db.$transaction(async (tx) => {
      await setInventoryMovementShadowWriteGate(tx, true);
      await appendShadowInventoryMovements(tx, {
        effectiveAt: new Date("2026-09-18T12:00:00.000Z"),
        actor,
        causation: { causationKind: "BATCH", causationId: "batch-order-fwd" },
        effects,
      });
    }, txOpts);
    await db.$transaction(async (tx) => {
      await appendShadowInventoryMovements(tx, {
        effectiveAt: new Date("2026-09-18T12:00:00.000Z"),
        actor,
        causation: { causationKind: "BATCH", causationId: "batch-order-rev" },
        effects: [...effects].reverse(),
      });
    }, txOpts);

    const forward = await db.inventoryMovement.findMany({
      where: { causationId: "batch-order-fwd" },
      orderBy: { effectKey: "asc" },
    });
    const reverse = await db.inventoryMovement.findMany({
      where: { causationId: "batch-order-rev" },
      orderBy: { effectKey: "asc" },
    });
    expect(forward.map((row) => row.effectKey)).toEqual(expectedKeys);
    expect(reverse.map((row) => row.effectKey)).toEqual(expectedKeys);
    expect(forward.map((row) => row.quantityDelta)).toEqual(reverse.map((row) => row.quantityDelta));
  });

  it("F: BLANK 1.8 / Decimal 1.8 share the fixed-4 target identity", async () => {
    await db.$transaction(async (tx) => {
      await setInventoryMovementShadowWriteGate(tx, true);
      await appendShadowInventoryMovements(tx, {
        effectiveAt: new Date("2026-09-18T12:00:00.000Z"),
        actor,
        causation: { causationKind: "PRODUCTION_OPERATION", causationId: "op-blank-a" },
        effects: [blankOutput(1.8)],
      });
    }, txOpts);
    await expect(
      db.$transaction(async (tx) => {
        await appendShadowInventoryMovements(tx, {
          effectiveAt: new Date("2026-09-18T12:00:00.000Z"),
          actor,
          causation: { causationKind: "PRODUCTION_OPERATION", causationId: "op-blank-a" },
          effects: [blankOutput(new Decimal("1.8"))],
        });
      }, txOpts),
    ).rejects.toSatisfy(isRawUniqueViolation);
    const row = await db.inventoryMovement.findFirst({
      where: { causationId: "op-blank-a" },
    });
    const snapshot = row?.targetSnapshot as { lengthM?: string };
    expect(snapshot.lengthM).toBe("1.8000");
    expect(canonicalLengthFixed4(row?.lengthM ?? "")).toBe("1.8000");
    const stored = await db.$queryRaw<Array<{ fixed4: string }>>`
      SELECT to_char("lengthM", 'FM999999990.0000') AS fixed4
      FROM "InventoryMovement"
      WHERE "causationId" = 'op-blank-a'
    `;
    expect(stored[0]?.fixed4).toBe("1.8000");
  });

  it("G: UNIQUE(causationKind, causationId, effectKey) is a barrier, not projection idempotency", async () => {
    const input = {
      effectiveAt: new Date("2026-09-18T12:00:00.000Z"),
      actor,
      causation: { causationKind: "BATCH" as const, causationId: "batch-unique" },
      effects: [railReceipt("lot-unique")],
    };
    await db.$transaction(async (tx) => {
      await setInventoryMovementShadowWriteGate(tx, true);
      await appendShadowInventoryMovements(tx, input);
    }, txOpts);
    await expect(
      db.$transaction(async (tx) => {
        await appendShadowInventoryMovements(tx, input);
      }, txOpts),
    ).rejects.toSatisfy(isRawUniqueViolation);
    expect(await db.inventoryMovement.count()).toBe(1);
  });

  it("H: application writer does not supply recordedAt; DB supplies it", async () => {
    const before = Date.now();
    await db.$transaction(async (tx) => {
      await setInventoryMovementShadowWriteGate(tx, true);
      await appendShadowInventoryMovements(tx, {
        effectiveAt: new Date("2026-01-01T00:00:00.000Z"),
        actor,
        causation: { causationKind: "BATCH", causationId: "batch-recorded" },
        effects: [railReceipt("lot-recorded")],
      });
    }, txOpts);
    const meta = await db.$queryRaw<
      Array<{ column_default: string | null; data_type: string }>
    >(Prisma.sql`
      SELECT column_default, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'InventoryMovement'
        AND column_name = 'recordedAt'
    `);
    expect((meta[0]?.column_default ?? "").toUpperCase()).toContain("CURRENT_TIMESTAMP");
    expect(meta[0]?.data_type).toBe("timestamp with time zone");
    const row = await db.inventoryMovement.findFirst({
      where: { causationId: "batch-recorded" },
    });
    expect(row?.recordedAt).toBeInstanceOf(Date);
    expect(row?.recordedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row?.effectiveAt.getTime()).not.toBe(row?.recordedAt.getTime());
  });

  it("I: effectiveAt UTC-naive round-trip is stable under a non-UTC session timezone", async () => {
    const instant = new Date("2026-09-18T16:05:06.123Z");
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'America/New_York'`);
      const tz = await tx.$queryRaw<Array<{ tz: string }>>`
        SELECT current_setting('TimeZone') AS tz
      `;
      expect(tz[0]?.tz).toBeTruthy();
      expect(tz[0]?.tz).not.toMatch(/^UTC$/i);
      await setInventoryMovementShadowWriteGate(tx, true);
      await appendShadowInventoryMovements(tx, {
        effectiveAt: instant,
        actor,
        causation: { causationKind: "BATCH", causationId: "batch-tz" },
        effects: [railReceipt("lot-tz")],
      });
      const stored = await tx.$queryRaw<Array<{ naive: string }>>`
        SELECT to_char("effectiveAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS naive
        FROM "InventoryMovement"
        WHERE "causationId" = 'batch-tz'
      `;
      expect(stored[0]?.naive).toBe(utcNaiveTimestampString(instant));
      const row = await tx.inventoryMovement.findFirst({
        where: { causationId: "batch-tz" },
      });
      expect(row?.effectiveAt.toISOString()).toBe(instant.toISOString());
      expect(row?.effectiveAt.getTime()).toBe(instant.getTime());
    }, txOpts);
  });

  it("B: invalid role/kind fails closed without inserting", async () => {
    await expect(
      db.$transaction(async (tx) => {
        await setInventoryMovementShadowWriteGate(tx, true);
        return appendShadowInventoryMovements(tx, {
          effectiveAt: new Date("2026-09-18T12:00:00.000Z"),
          actor,
          causation: { causationKind: "BATCH", causationId: "batch-kind-mismatch" },
          effects: [
            {
              role: "consume",
              kind: "ADJUSTMENT",
              quantityDelta: -5,
              target: { stockDomain: "RAIL_LOT", railLotId: "lot-mismatch" },
            } as never,
          ],
        });
      }, txOpts),
    ).rejects.toThrow(/consume requires kind CONSUMPTION|role consume/);
    expect(await db.inventoryMovement.count()).toBe(0);

    await expect(
      db.$transaction(async (tx) => {
        await setInventoryMovementShadowWriteGate(tx, true);
        return appendShadowInventoryMovements(tx, {
          effectiveAt: new Date("2026-09-18T12:00:00.000Z"),
          actor,
          causation: { causationKind: "BATCH", causationId: "batch-opening" },
          effects: [
            {
              role: "receipt",
              kind: "OPENING_BALANCE",
              quantityDelta: 5,
              target: { stockDomain: "RAIL_LOT", railLotId: "lot-opening" },
            } as never,
          ],
        });
      }, txOpts),
    ).rejects.toThrow(/OPENING_BALANCE/);
    expect(await db.inventoryMovement.count()).toBe(0);
  });
});
