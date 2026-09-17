import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { createIntegrityClients, ensureIntegritySchema } from "./harness";

const enabled = Boolean(process.env.INTEGRITY_TEST_DATABASE_URL);

function sqlText(error: unknown): string {
  if (error instanceof Error) return `${error.message}\n${error.stack ?? ""}`;
  return String(error);
}

function isCheckViolation(error: unknown): boolean {
  const text = sqlText(error);
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  return code === "P2004" || code === "23514" || /23514/.test(text) || /check constraint/i.test(text);
}

function isUniqueViolation(error: unknown): boolean {
  const text = sqlText(error);
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  return code === "P2002" || code === "23505" || /23505/.test(text) || /unique constraint/i.test(text);
}

const LOOKUP_INDEXES = [
  "InventoryMovement_railLotId_recordedAt_idx",
  "InventoryMovement_blank_pool_recordedAt_idx",
  "InventoryMovement_detail_pool_recordedAt_idx",
  "InventoryMovement_nomenclatureId_recordedAt_idx",
  "InventoryMovement_productId_recordedAt_idx",
  "InventoryMovement_userId_recordedAt_idx",
  "InventoryMovement_employeeId_recordedAt_idx",
  "InventoryMovement_reversalOfMovementId_recordedAt_idx",
] as const;

const OPENING_UNIQUE_INDEXES = [
  "InventoryMovement_opening_railLot_authoritative_key",
  "InventoryMovement_opening_blank_authoritative_key",
  "InventoryMovement_opening_detail_authoritative_key",
  "InventoryMovement_opening_nomenclature_authoritative_key",
  "InventoryMovement_opening_product_authoritative_key",
] as const;

const CHECKS = [
  "InventoryMovement_quantityDelta_nonzero",
  "InventoryMovement_kind_sign",
  "InventoryMovement_actor_shape",
  "InventoryMovement_authority_epoch",
  "InventoryMovement_stock_target_shape",
  "InventoryMovement_targetSnapshot_object",
  "InventoryMovement_causationSnapshot_object",
  "InventoryMovement_supply_causation_snapshot",
  "InventoryMovement_nonblank_required",
  "InventoryMovement_identity_length",
  "InventoryMovement_reversal_shape",
  "InventoryMovement_manual_reason",
] as const;

const ENUMS: Record<string, string[]> = {
  InventoryMovementKind: [
    "OPENING_BALANCE",
    "RECEIPT",
    "CONSUMPTION",
    "PRODUCTION_OUTPUT",
    "ADJUSTMENT",
    "REVERSAL",
  ],
  InventoryStockDomain: ["RAIL_LOT", "BLANK", "DETAIL", "NOMENCLATURE", "PRODUCT"],
  InventoryMovementAuthority: ["SHADOW", "AUTHORITATIVE"],
  InventoryMovementActorKind: ["USER", "EMPLOYEE", "SYSTEM"],
  InventoryMovementCausationKind: [
    "PRODUCTION_OPERATION",
    "PRODUCTION_OPERATION_MUTATION",
    "INVENTORY",
    "SIMPLE_PURCHASE",
    "BATCH",
    "RAIL_LOT",
    "SUPPLY",
    "MANUAL",
    "SYSTEM",
  ],
};

describe.skipIf(!enabled)("PSR-P1 InventoryMovement SHADOW schema", () => {
  let db: ReturnType<typeof createIntegrityClients>["prismaA"];

  beforeAll(() => {
    ensureIntegritySchema();
    ({ prismaA: db } = createIntegrityClients());
  });

  beforeEach(async () => {
    await db.$executeRawUnsafe(`DELETE FROM "InventoryMovement"`);
  });

  afterAll(async () => {
    if (db) {
      await db.$executeRawUnsafe(`DELETE FROM "InventoryMovement"`);
      await db.$disconnect();
    }
  });

  it("creates empty table, enums, indexes, CHECKs, and no FKs", async () => {
    const tables = await db.$queryRaw<Array<{ exists: boolean }>>(Prisma.sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'InventoryMovement'
      ) AS exists
    `);
    expect(tables[0]?.exists).toBe(true);

    for (const [enumName, values] of Object.entries(ENUMS)) {
      const rows = await db.$queryRaw<Array<{ enumlabel: string }>>(Prisma.sql`
        SELECT e.enumlabel
        FROM pg_type t
        JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE t.typname = ${enumName}
        ORDER BY e.enumsortorder
      `);
      expect(rows.map((r) => r.enumlabel)).toEqual(values);
    }

    const unique = await db.$queryRaw<Array<{ indexname: string }>>(Prisma.sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'InventoryMovement'
        AND indexname = 'InventoryMovement_causationKind_causationId_effectKey_key'
    `);
    expect(unique).toHaveLength(1);

    const indexes = await db.$queryRaw<Array<{ indexname: string }>>(Prisma.sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'InventoryMovement'
      ORDER BY indexname
    `);
    const names = indexes.map((r) => r.indexname);
    for (const name of LOOKUP_INDEXES) expect(names).toContain(name);
    for (const name of OPENING_UNIQUE_INDEXES) expect(names).toContain(name);

    const checks = await db.$queryRaw<Array<{ conname: string }>>(Prisma.sql`
      SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class rel ON rel.oid = c.conrelid
      WHERE rel.relname = 'InventoryMovement' AND c.contype = 'c'
      ORDER BY c.conname
    `);
    expect(checks.map((r) => r.conname).sort()).toEqual([...CHECKS].sort());

    const fks = await db.$queryRaw<Array<{ conname: string }>>(Prisma.sql`
      SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class rel ON rel.oid = c.conrelid
      WHERE rel.relname = 'InventoryMovement' AND c.contype = 'f'
    `);
    expect(fks).toEqual([]);

    const count = await db.$queryRaw<Array<{ n: bigint }>>(
      Prisma.sql`SELECT COUNT(*)::bigint AS n FROM "InventoryMovement"`,
    );
    expect(Number(count[0]?.n)).toBe(0);

    const def = await db.$queryRaw<Array<{ column_default: string | null }>>(Prisma.sql`
      SELECT column_default
      FROM information_schema.columns
      WHERE table_name = 'InventoryMovement' AND column_name = 'authority'
    `);
    expect(def[0]?.column_default ?? "").toContain("SHADOW");
  });

  it("accepts valid SHADOW RAIL_LOT receipt and SHADOW rehearsal epoch", async () => {
    await insertRailLot(db, {
      id: "im-ok-1",
      causationId: "batch-1",
      effectKey: "receipt|RAIL_LOT|lot-1",
    });
    await insertRailLot(db, {
      id: "im-ok-shadow-epoch",
      causationId: "batch-shadow",
      effectKey: "receipt|RAIL_LOT|lot-shadow",
      epochId: "rehearsal-1",
    });
    await db.$executeRawUnsafe(`DELETE FROM "InventoryMovement"`);
  });

  it("rejects zero quantity, wrong sign, invalid actor, and AUTHORITATIVE without epoch", async () => {
    await expectRejected(
      insertRailLot(db, { id: "im-zero", quantityDelta: 0, causationId: "c-zero", effectKey: "k-zero" }),
    );
    await expectRejected(
      insertRailLot(db, {
        id: "im-sign",
        kind: "RECEIPT",
        quantityDelta: -1,
        causationId: "c-sign",
        effectKey: "k-sign",
      }),
    );
    await expectRejected(
      insertRailLot(db, {
        id: "im-actor",
        actorKind: "USER",
        userId: null,
        systemActorKey: "sys",
        causationId: "c-actor",
        effectKey: "k-actor",
      }),
    );
    await expectRejected(
      insertRailLot(db, {
        id: "im-auth",
        authority: "AUTHORITATIVE",
        epochId: null,
        causationId: "c-auth",
        effectKey: "k-auth",
      }),
    );
  });

  it("rejects BLANK length<=0, wrong domain shape, scalar JSON, SUPPLY without snapshot", async () => {
    await expectRejected(
      insertBlank(db, {
        id: "im-len",
        lengthM: "0",
        causationId: "c-len",
        effectKey: "k-len",
      }),
    );
    await expectRejected(
      insertRailLot(db, {
        id: "im-shape",
        stockDomain: "RAIL_LOT",
        productId: "p1",
        causationId: "c-shape",
        effectKey: "k-shape",
      }),
    );
    await expectRejected(
      db.$executeRawUnsafe(`
        INSERT INTO "InventoryMovement" (
          "id","kind","stockDomain","quantityDelta","authority","causationKind","causationId","effectKey",
          "actorKind","systemActorKey","actorDisplaySnapshot","effectiveAt","railLotId","targetSnapshot"
        ) VALUES (
          'im-json','RECEIPT','RAIL_LOT',1,'SHADOW','BATCH','c-json','k-json',
          'SYSTEM','sys','sys', TIMESTAMP '2026-09-17 00:00:00', 'lot-1', '1'::jsonb
        )
      `),
    );
    await expectRejected(
      insertProduct(db, {
        id: "im-supply",
        causationKind: "SUPPLY",
        causationId: "c-supply",
        effectKey: "k-supply",
      }),
    );
  });

  it("rejects blank/oversized effectKey, MANUAL without reason, bad reversal shape", async () => {
    await expectRejected(
      insertRailLot(db, { id: "im-blank-key", causationId: "c-bk", effectKey: "   " }),
    );
    await expectRejected(
      insertRailLot(db, {
        id: "im-long-key",
        causationId: "c-lk",
        effectKey: "x".repeat(201),
      }),
    );
    await expectRejected(
      insertRailLot(db, {
        id: "im-manual",
        causationKind: "MANUAL",
        reason: null,
        causationId: "c-man",
        effectKey: "k-man",
      }),
    );
    await expectRejected(
      insertRailLot(db, {
        id: "im-rev-missing",
        kind: "REVERSAL",
        quantityDelta: -1,
        reversalOfMovementId: null,
        causationId: "c-rev",
        effectKey: "k-rev",
      }),
    );
    await expectRejected(
      insertRailLot(db, {
        id: "im-rev-extra",
        kind: "RECEIPT",
        reversalOfMovementId: "other-id",
        causationId: "c-rev2",
        effectKey: "k-rev2",
      }),
    );
  });

  it("rejects duplicate causation/effect identity", async () => {
    await insertRailLot(db, { id: "im-dup-1", causationId: "same-c", effectKey: "same-e" });
    await expectUniqueRejected(
      insertRailLot(db, { id: "im-dup-2", causationId: "same-c", effectKey: "same-e" }),
    );
  });

  it("rejects duplicate AUTHORITATIVE opening of the same pool, allows SHADOW rehearsal openings", async () => {
    await insertRailLot(db, {
      id: "im-open-1",
      kind: "OPENING_BALANCE",
      quantityDelta: 4,
      authority: "AUTHORITATIVE",
      epochId: "final-epoch",
      causationKind: "SYSTEM",
      causationId: "open-1",
      effectKey: "opening|RAIL_LOT|lot-1",
      railLotId: "lot-1",
    });
    await expectUniqueRejected(
      insertRailLot(db, {
        id: "im-open-2",
        kind: "OPENING_BALANCE",
        quantityDelta: 4,
        authority: "AUTHORITATIVE",
        epochId: "final-epoch",
        causationKind: "SYSTEM",
        causationId: "open-2",
        effectKey: "opening|RAIL_LOT|lot-1-again",
        railLotId: "lot-1",
      }),
    );

    await insertRailLot(db, {
      id: "im-shadow-open-1",
      kind: "OPENING_BALANCE",
      quantityDelta: 4,
      authority: "SHADOW",
      epochId: "rehearsal-epoch",
      causationKind: "SYSTEM",
      causationId: "shadow-open-1",
      effectKey: "opening|RAIL_LOT|lot-r1",
      railLotId: "lot-r",
    });
    await insertRailLot(db, {
      id: "im-shadow-open-2",
      kind: "OPENING_BALANCE",
      quantityDelta: 4,
      authority: "SHADOW",
      epochId: "rehearsal-epoch",
      causationKind: "SYSTEM",
      causationId: "shadow-open-2",
      effectKey: "opening|RAIL_LOT|lot-r2",
      railLotId: "lot-r",
    });
  });

  it("leaves InventoryMovement empty after probes", async () => {
    await db.$executeRawUnsafe(`DELETE FROM "InventoryMovement"`);
    const count = await db.$queryRaw<Array<{ n: bigint }>>(
      Prisma.sql`SELECT COUNT(*)::bigint AS n FROM "InventoryMovement"`,
    );
    expect(Number(count[0]?.n)).toBe(0);
  });
});

async function expectRejected(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toSatisfy((err: unknown) => isCheckViolation(err));
}

async function expectUniqueRejected(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toSatisfy((err: unknown) => isUniqueViolation(err));
}

type RailInsert = {
  id: string;
  kind?: string;
  stockDomain?: string;
  quantityDelta?: number;
  authority?: string;
  epochId?: string | null;
  causationKind?: string;
  causationId: string;
  effectKey: string;
  actorKind?: string;
  userId?: string | null;
  employeeId?: string | null;
  systemActorKey?: string | null;
  actorDisplaySnapshot?: string;
  reason?: string | null;
  reversalOfMovementId?: string | null;
  railLotId?: string;
  productId?: string | null;
};

async function insertRailLot(
  db: ReturnType<typeof createIntegrityClients>["prismaA"],
  row: RailInsert,
): Promise<void> {
  const kind = row.kind ?? "RECEIPT";
  const stockDomain = row.stockDomain ?? "RAIL_LOT";
  const quantityDelta = row.quantityDelta ?? 1;
  const authority = row.authority ?? "SHADOW";
  const epochId = row.epochId === undefined ? null : row.epochId;
  const causationKind = row.causationKind ?? "BATCH";
  const actorKind = row.actorKind ?? "SYSTEM";
  const userId = row.userId === undefined ? null : row.userId;
  const employeeId = row.employeeId === undefined ? null : row.employeeId;
  const systemActorKey =
    row.systemActorKey === undefined
      ? actorKind === "SYSTEM"
        ? "psr-p1-probe"
        : null
      : row.systemActorKey;
  const actorDisplaySnapshot = row.actorDisplaySnapshot ?? "psr-p1-probe";
  const reason = row.reason === undefined ? null : row.reason;
  const reversalOfMovementId =
    row.reversalOfMovementId === undefined ? null : row.reversalOfMovementId;
  const railLotId = row.railLotId ?? "lot-1";
  const productId = row.productId === undefined ? null : row.productId;

  await db.$executeRaw`
    INSERT INTO "InventoryMovement" (
      "id","kind","stockDomain","quantityDelta","authority","epochId",
      "causationKind","causationId","effectKey",
      "actorKind","userId","employeeId","systemActorKey","actorDisplaySnapshot","reason",
      "effectiveAt","reversalOfMovementId","railLotId","productId","targetSnapshot"
    ) VALUES (
      ${row.id},
      ${kind}::"InventoryMovementKind",
      ${stockDomain}::"InventoryStockDomain",
      ${quantityDelta},
      ${authority}::"InventoryMovementAuthority",
      ${epochId},
      ${causationKind}::"InventoryMovementCausationKind",
      ${row.causationId},
      ${row.effectKey},
      ${actorKind}::"InventoryMovementActorKind",
      ${userId},
      ${employeeId},
      ${systemActorKey},
      ${actorDisplaySnapshot},
      ${reason},
      TIMESTAMP '2026-09-17 00:00:00',
      ${reversalOfMovementId},
      ${railLotId},
      ${productId},
      '{"v":1}'::jsonb
    )
  `;
}

async function insertBlank(
  db: ReturnType<typeof createIntegrityClients>["prismaA"],
  row: { id: string; lengthM: string; causationId: string; effectKey: string },
): Promise<void> {
  await db.$executeRaw`
    INSERT INTO "InventoryMovement" (
      "id","kind","stockDomain","quantityDelta","authority",
      "causationKind","causationId","effectKey",
      "actorKind","systemActorKey","actorDisplaySnapshot","effectiveAt",
      "materialId","lengthM","detailType","sort","targetSnapshot"
    ) VALUES (
      ${row.id},
      'PRODUCTION_OUTPUT'::"InventoryMovementKind",
      'BLANK'::"InventoryStockDomain",
      1,
      'SHADOW'::"InventoryMovementAuthority",
      'PRODUCTION_OPERATION'::"InventoryMovementCausationKind",
      ${row.causationId},
      ${row.effectKey},
      'SYSTEM'::"InventoryMovementActorKind",
      'psr-p1-probe',
      'psr-p1-probe',
      TIMESTAMP '2026-09-17 00:00:00',
      'mat-1',
      ${row.lengthM}::decimal,
      'POLKA'::"RailType",
      'SORT1'::"Sort",
      '{"v":1}'::jsonb
    )
  `;
}

async function insertProduct(
  db: ReturnType<typeof createIntegrityClients>["prismaA"],
  row: {
    id: string;
    causationKind: string;
    causationId: string;
    effectKey: string;
  },
): Promise<void> {
  await db.$executeRaw`
    INSERT INTO "InventoryMovement" (
      "id","kind","stockDomain","quantityDelta","authority",
      "causationKind","causationId","effectKey","causationSnapshot",
      "actorKind","systemActorKey","actorDisplaySnapshot","effectiveAt",
      "productId","targetSnapshot"
    ) VALUES (
      ${row.id},
      'CONSUMPTION'::"InventoryMovementKind",
      'PRODUCT'::"InventoryStockDomain",
      -1,
      'SHADOW'::"InventoryMovementAuthority",
      ${row.causationKind}::"InventoryMovementCausationKind",
      ${row.causationId},
      ${row.effectKey},
      NULL,
      'SYSTEM'::"InventoryMovementActorKind",
      'psr-p1-probe',
      'psr-p1-probe',
      TIMESTAMP '2026-09-17 00:00:00',
      'prod-1',
      '{"v":1}'::jsonb
    )
  `;
}
