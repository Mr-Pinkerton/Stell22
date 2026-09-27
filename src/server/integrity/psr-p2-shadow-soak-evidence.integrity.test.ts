import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { PINNED_PRODUCTION_APPLICATION_SHA } from "@/server/internal/inventory-movement-shadow-activation-policy";
import { evaluateShadowSoakEvidence } from "@/server/internal/inventory-movement-shadow-soak-evidence";
import { createIntegrityClients } from "./harness";

const enabled = Boolean(process.env.INTEGRITY_TEST_DATABASE_URL);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const PIN = PINNED_PRODUCTION_APPLICATION_SHA;

type ShiftVars = {
  shift_active: string;
  shift_start_sql: string;
  shift_end_sql: string;
  shift_start_compact: string;
  shift_end_compact: string;
};

const NO_SHIFT: ShiftVars = {
  shift_active: "NO",
  shift_start_sql: "1970-01-01 00:00:00+00",
  shift_end_sql: "1970-01-01 00:00:00+00",
  shift_start_compact: "NONE",
  shift_end_compact: "NONE",
};

const DAY_SHIFT: ShiftVars = {
  shift_active: "YES",
  shift_start_sql: "2026-09-23 08:00:00+00",
  shift_end_sql: "2026-09-23 15:59:59+00",
  shift_start_compact: "20260923T080000Z",
  shift_end_compact: "20260923T155959Z",
};

function extractSoakSql(): string {
  const script = fs.readFileSync(
    path.join(root, "scripts/shadow-soak-evidence-readonly-snapshot.sh"),
    "utf8",
  );
  const match = script.match(/<<'SQL'\r?\n([\s\S]*?)\r?\nSQL/);
  if (!match?.[1]) throw new Error("soak SQL heredoc missing");
  return match[1]
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "BEGIN TRANSACTION READ ONLY;")
    .filter((line) => line.trim() !== "COMMIT;")
    .join("\n")
    .trim()
    .replace(/;$/, "");
}

function bindSoakSql(sql: string, vars: ShiftVars): string {
  let bound = sql;
  for (const [name, value] of Object.entries(vars)) {
    if (!/^[A-Za-z0-9:+ -]+$/.test(value)) throw new Error(`unsafe soak variable ${name}`);
    bound = bound.replaceAll(`:'${name}'`, `'${value}'`);
  }
  if (bound.includes(":'")) throw new Error("unbound soak psql variable");
  return bound;
}

function toSnapshot(lines: string[]): string {
  return [
    `SHADOW_SOAK PRODUCTION_APP_SHA=${PIN}`,
    "SHADOW_SOAK SHA_PIN=MATCH",
    ...lines.map((line) => `SHADOW_SOAK ${line}`),
    "SHADOW_SOAK SNAPSHOT_MODE=READ_ONLY",
  ].join("\n");
}

describe.skipIf(!enabled)("PSR-P2 SHADOW soak evidence SQL", () => {
  const { prismaA: db } = createIntegrityClients();

  afterAll(async () => {
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS soak_ev CASCADE`);
    await db.$disconnect();
  });

  async function query(vars: ShiftVars, seed: (tx: typeof db) => Promise<void>) {
    return db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`DROP SCHEMA IF EXISTS soak_ev CASCADE`);
      await tx.$executeRawUnsafe(`CREATE SCHEMA soak_ev`);
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO soak_ev`);
      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'Asia/Tokyo'`);
      await tx.$executeRawUnsafe(`
        CREATE TABLE "Setting" (
          key text PRIMARY KEY,
          value jsonb
        )
      `);
      await tx.$executeRawUnsafe(`
        CREATE TABLE "ProductionOperation" (
          id text PRIMARY KEY,
          "createdAt" timestamp(3) without time zone NOT NULL,
          "workDate" timestamp(3) without time zone NOT NULL
        )
      `);
      await tx.$executeRawUnsafe(`
        CREATE TABLE "ProductionOperationCorrection" (
          id text PRIMARY KEY,
          "operationId" text NOT NULL
        )
      `);
      await tx.$executeRawUnsafe(`
        CREATE TABLE "ProductionOperationQuantityEdit" (
          id text PRIMARY KEY,
          "operationId" text NOT NULL
        )
      `);
      await tx.$executeRawUnsafe(`
        CREATE TABLE "InventoryMovement" (
          id text PRIMARY KEY,
          authority text NOT NULL,
          "epochId" text,
          "causationKind" text NOT NULL,
          "causationId" text NOT NULL,
          "effectiveAt" timestamp(3) without time zone NOT NULL,
          "recordedAt" timestamptz(3) NOT NULL
        )
      `);
      await seed(tx as typeof db);
      const rows = await tx.$queryRawUnsafe<Array<{ line: string }>>(bindSoakSql(extractSoakSql(), vars));
      await tx.$executeRawUnsafe(`DROP SCHEMA soak_ev CASCADE`);
      return rows.map((row) => row.line);
    });
  }

  function evaluate(lines: string[]) {
    return evaluateShadowSoakEvidence({
      expectedApplicationSha: PIN,
      snapshot: toSnapshot(lines),
    });
  }

  it("aggregates a fictional full shift in UTC and keeps supply out of production ops", async () => {
    const lines = await query(DAY_SHIFT, async (tx) => {
      await tx.$executeRawUnsafe(`
        INSERT INTO "Setting" (key, value)
        VALUES ('inventory_movement_shadow_write', '{"version":1,"active":true}'::jsonb)
      `);
      await tx.$executeRawUnsafe(`
        INSERT INTO "ProductionOperation" (id, "createdAt", "workDate") VALUES
          ('op-a', TIMESTAMP '2026-09-23 09:00:00', TIMESTAMP '2026-09-23 09:00:00'),
          ('op-b', TIMESTAMP '2026-09-23 10:00:00', TIMESTAMP '2026-09-23 10:00:00')
      `);
      await tx.$executeRawUnsafe(`
        INSERT INTO "ProductionOperationCorrection" (id, "operationId")
        VALUES ('corr-1', 'op-a')
      `);
      await tx.$executeRawUnsafe(`
        INSERT INTO "ProductionOperationQuantityEdit" (id, "operationId")
        VALUES ('qe-1', 'op-b')
      `);
      await tx.$executeRawUnsafe(`
        INSERT INTO "InventoryMovement"
          (id, authority, "causationKind", "causationId", "effectiveAt", "recordedAt")
        VALUES
          ('m-batch', 'SHADOW', 'BATCH', 'batch-cmd',
            TIMESTAMP '2026-09-23 06:50:00', TIMESTAMPTZ '2026-09-23 07:00:00+00'),
          ('m-08', 'SHADOW', 'PRODUCTION_OPERATION', 'op-a',
            TIMESTAMP '2026-09-23 08:00:00', TIMESTAMPTZ '2026-09-23 08:00:00+00'),
          ('m-09', 'SHADOW', 'PRODUCTION_OPERATION', 'op-a',
            TIMESTAMP '2026-09-23 09:00:00', TIMESTAMPTZ '2026-09-23 09:00:00+00'),
          ('m-10', 'SHADOW', 'PRODUCTION_OPERATION', 'op-b',
            TIMESTAMP '2026-09-23 10:00:00', TIMESTAMPTZ '2026-09-23 10:00:00+00'),
          ('m-11', 'SHADOW', 'PRODUCTION_OPERATION', 'op-b',
            TIMESTAMP '2026-09-23 11:00:00', TIMESTAMPTZ '2026-09-23 11:00:00+00'),
          ('m-corr', 'SHADOW', 'PRODUCTION_OPERATION_MUTATION', 'corr-1',
            TIMESTAMP '2026-09-23 11:30:00', TIMESTAMPTZ '2026-09-23 11:30:00+00'),
          ('m-12', 'SHADOW', 'PRODUCTION_OPERATION', 'op-b',
            TIMESTAMP '2026-09-23 12:00:00', TIMESTAMPTZ '2026-09-23 12:00:00+00'),
          ('m-qe', 'SHADOW', 'PRODUCTION_OPERATION_MUTATION', 'qe-1',
            TIMESTAMP '2026-09-23 12:30:00', TIMESTAMPTZ '2026-09-23 12:30:00+00'),
          ('m-13', 'SHADOW', 'PRODUCTION_OPERATION', 'op-b',
            TIMESTAMP '2026-09-23 13:00:00', TIMESTAMPTZ '2026-09-23 13:00:00+00'),
          ('m-supply', 'SHADOW', 'SUPPLY', 'op-a',
            TIMESTAMP '2026-09-23 13:30:00', TIMESTAMPTZ '2026-09-23 13:30:00+00'),
          ('m-14', 'SHADOW', 'PRODUCTION_OPERATION', 'op-b',
            TIMESTAMP '2026-09-23 14:00:00', TIMESTAMPTZ '2026-09-23 14:00:00+00'),
          ('m-inv', 'SHADOW', 'INVENTORY', 'count-doc',
            TIMESTAMP '2026-09-23 14:30:00', TIMESTAMPTZ '2026-09-23 14:30:00+00'),
          ('m-15', 'SHADOW', 'PRODUCTION_OPERATION', 'op-b',
            TIMESTAMP '2026-09-23 15:00:00', TIMESTAMPTZ '2026-09-23 15:00:00+00'),
          ('m-late', 'SHADOW', 'SYSTEM', 'job',
            TIMESTAMP '2026-09-23 18:00:00', TIMESTAMPTZ '2026-09-23 18:00:00+00')
      `);
    });
    const result = evaluate(lines);
    expect(result.ok, JSON.stringify(result.ok ? result.markers : result)).toBe(true);
    if (!result.ok) return;
    const markers = new Map(result.markers.map((line) => {
      const idx = line.indexOf("=");
      return [line.slice(0, idx), line.slice(idx + 1)] as const;
    }));
    expect(markers.get("SHADOW_COUNT")).toBe("14");
    expect(markers.get("SHADOW_RECORDED_AT_MIN")).toBe("20260923T070000000Z");
    expect(markers.get("SHADOW_RECORDED_AT_MAX")).toBe("20260923T180000000Z");
    expect(markers.get("SHADOW_EFFECTIVE_AT_MIN")).toBe("20260923T065000000Z");
    expect(markers.get("RECORDED_MINUS_EFFECTIVE_MAX_MS")).toBe("600000");
    expect(markers.get("FAMILY_PRODUCTION")).toBe("10");
    expect(markers.get("FAMILY_SUPPLY")).toBe("1");
    expect(markers.get("FAMILY_INVENTORY")).toBe("1");
    expect(markers.get("FAMILY_OTHER")).toBe("2");
    expect(markers.get("PRODUCTION_OPS_DISTINCT")).toBe("2");
    expect(markers.get("PRODUCTION_OPS_VIA_CORRECTION")).toBe("1");
    expect(markers.get("PRODUCTION_OPS_VIA_QUANTITY_EDIT")).toBe("1");
    expect(markers.get("SHIFT_SHADOW_ROWS")).toBe("12");
    expect(markers.get("SHIFT_SHADOW_OUTSIDE_ROWS")).toBe("2");
    expect(markers.get("SHIFT_COVERAGE")).toBe("FULL");
    expect(markers.get("SOAK_COMPLETE")).toBe("NO");
    expect(markers.get("SHADOW_DAY_20260923")).toBe("14");
    expect(markers.get("SHADOW_HOUR_20260923T07")).toBe("1");
    expect(markers.get("SHADOW_HOUR_20260924T02")).toBeUndefined();
    expect(result.markers.join("\n")).not.toContain("op-a");
  });

  it("reports a partial shift and an empty interval without treating effectiveAt as write time", async () => {
    const partial = evaluate(await query(DAY_SHIFT, async (tx) => {
      await tx.$executeRawUnsafe(`
        INSERT INTO "ProductionOperation" (id, "createdAt", "workDate")
        VALUES ('op-c', TIMESTAMP '2026-09-23 09:15:00', TIMESTAMP '2026-09-23 09:15:00')
      `);
      await tx.$executeRawUnsafe(`
        INSERT INTO "InventoryMovement"
          (id, authority, "causationKind", "causationId", "effectiveAt", "recordedAt")
        VALUES
          ('m-out', 'SHADOW', 'SUPPLY', 'op-c',
            TIMESTAMP '2026-09-23 07:00:00', TIMESTAMPTZ '2026-09-23 07:00:00+00'),
          ('m-09', 'SHADOW', 'PRODUCTION_OPERATION', 'op-c',
            TIMESTAMP '2026-09-23 09:00:00', TIMESTAMPTZ '2026-09-23 09:00:00+00'),
          ('m-10', 'SHADOW', 'PRODUCTION_OPERATION', 'op-c',
            TIMESTAMP '2026-09-23 10:00:01', TIMESTAMPTZ '2026-09-23 10:00:00+00')
      `);
    }));
    expect(partial.ok, JSON.stringify(partial)).toBe(true);
    if (!partial.ok) return;
    const markers = new Map(partial.markers.map((line) => {
      const idx = line.indexOf("=");
      return [line.slice(0, idx), line.slice(idx + 1)] as const;
    }));
    expect(markers.get("SHIFT_COVERAGE")).toBe("PARTIAL");
    expect(markers.get("SHIFT_SHADOW_OUTSIDE_ROWS")).toBe("1");
    expect(markers.get("FAMILY_PRODUCTION")).toBe("2");
    expect(markers.get("FAMILY_SUPPLY")).toBe("1");
    expect(markers.get("PRODUCTION_OPS_DISTINCT")).toBe("1");
    expect(markers.get("RECORDED_MINUS_EFFECTIVE_MIN_MS")).toBe("M1000");
    expect(markers.get("SHADOW_RECORDED_AT_MIN")).toBe("20260923T070000000Z");
    expect(markers.get("SOAK_COMPLETE")).toBe("NO");

    const empty = evaluate(await query(NO_SHIFT, async () => {}));
    expect(empty.ok, JSON.stringify(empty)).toBe(true);
    if (!empty.ok) return;
    const emptyMarkers = new Map(empty.markers.map((line) => {
      const idx = line.indexOf("=");
      return [line.slice(0, idx), line.slice(idx + 1)] as const;
    }));
    expect(emptyMarkers.get("SHADOW_COUNT")).toBe("0");
    expect(emptyMarkers.get("SHADOW_RECORDED_AT_MIN")).toBe("NONE");
    expect(emptyMarkers.get("SHIFT_COVERAGE")).toBe("NOT_EVALUATED");
    expect(emptyMarkers.get("SHADOW_SETTING")).toBe("ABSENT");
    expect(emptyMarkers.get("COST_FLOW_SETTING")).toBe("ABSENT");
  });

  it("keeps a late UTC instant on its UTC day under a non-UTC session and fails closed on bad causation", async () => {
    const utc = evaluate(await query(NO_SHIFT, async (tx) => {
      await tx.$executeRawUnsafe(`
        INSERT INTO "ProductionOperation" (id, "createdAt", "workDate")
        VALUES ('op-late', TIMESTAMP '2026-09-23 23:30:00', TIMESTAMP '2026-09-23 23:30:00')
      `);
      await tx.$executeRawUnsafe(`
        INSERT INTO "InventoryMovement"
          (id, authority, "causationKind", "causationId", "effectiveAt", "recordedAt")
        VALUES (
          'm-utc', 'SHADOW', 'PRODUCTION_OPERATION', 'op-late',
          TIMESTAMP '2026-09-23 23:20:00', TIMESTAMPTZ '2026-09-23 23:30:00+00'
        )
      `);
    }));
    expect(utc.ok, JSON.stringify(utc)).toBe(true);
    if (!utc.ok) return;
    const markers = new Map(utc.markers.map((line) => {
      const idx = line.indexOf("=");
      return [line.slice(0, idx), line.slice(idx + 1)] as const;
    }));
    expect(markers.get("SHADOW_RECORDED_AT_MIN")).toBe("20260923T233000000Z");
    expect(markers.get("SHADOW_EFFECTIVE_AT_MIN")).toBe("20260923T232000000Z");
    expect(markers.get("SHADOW_DAY_20260923")).toBe("1");
    expect(markers.get("SHADOW_HOUR_20260923T23")).toBe("1");
    expect(markers.get("SHADOW_DAY_20260924")).toBeUndefined();
    expect(markers.get("RECORDED_MINUS_EFFECTIVE_MIN_MS")).toBe("600000");

    const unmatched = evaluate(await query(NO_SHIFT, async (tx) => {
      await tx.$executeRawUnsafe(`
        INSERT INTO "InventoryMovement"
          (id, authority, "causationKind", "causationId", "effectiveAt", "recordedAt")
        VALUES (
          'm-missing', 'SHADOW', 'PRODUCTION_OPERATION', 'missing-op',
          TIMESTAMP '2026-09-23 09:00:00', TIMESTAMPTZ '2026-09-23 09:00:00+00'
        )
      `);
    }));
    expect(unmatched).toEqual({ ok: false, code: "PRODUCTION_CAUSATION_UNMATCHED" });

    const ambiguous = evaluate(await query(NO_SHIFT, async (tx) => {
      await tx.$executeRawUnsafe(`
        INSERT INTO "ProductionOperation" (id, "createdAt", "workDate")
        VALUES ('op-d', TIMESTAMP '2026-09-23 09:00:00', TIMESTAMP '2026-09-23 09:00:00')
      `);
      await tx.$executeRawUnsafe(`
        INSERT INTO "ProductionOperationCorrection" (id, "operationId") VALUES ('same-id', 'op-d')
      `);
      await tx.$executeRawUnsafe(`
        INSERT INTO "ProductionOperationQuantityEdit" (id, "operationId") VALUES ('same-id', 'op-d')
      `);
      await tx.$executeRawUnsafe(`
        INSERT INTO "InventoryMovement"
          (id, authority, "causationKind", "causationId", "effectiveAt", "recordedAt")
        VALUES (
          'm-ambiguous', 'SHADOW', 'PRODUCTION_OPERATION_MUTATION', 'same-id',
          TIMESTAMP '2026-09-23 09:00:00', TIMESTAMPTZ '2026-09-23 09:00:00+00'
        )
      `);
    }));
    expect(ambiguous).toEqual({ ok: false, code: "MUTATION_IDENTITY_AMBIGUOUS" });
  });
});
