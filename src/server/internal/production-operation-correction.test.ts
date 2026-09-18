import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { INVENTORY_MOVEMENT_SHADOW_LOCK_NS } from "./inventory-movement-shadow-coordination";
import {
  R05_CORRECTION_REQUEST_LOCK_NAMESPACE,
  REQUEST_ID_REUSE,
  STALE_CORRECTION,
  acquireCorrectionRequestLock,
  assertCorrectionCommandIntegers,
  assertCorrectionPayloadMatch,
  canonicalCorrectionReason,
  correctionDeltaReturned,
  correctionPayloadMatches,
} from "./production-operation-correction";

const base = {
  operationId: "op-1",
  adminUserId: "admin-1",
  expectedOldRailsTaken: 10,
  newRailsTaken: 7,
  reason: "ошиблись количеством",
};

describe("R-05 correction command integers", () => {
  it("accepts 10 → 7", () => {
    expect(() =>
      assertCorrectionCommandIntegers({ expectedOldRailsTaken: 10, newRailsTaken: 7 }),
    ).not.toThrow();
  });

  it("rejects equal target", () => {
    expect(() =>
      assertCorrectionCommandIntegers({ expectedOldRailsTaken: 10, newRailsTaken: 10 }),
    ).toThrow("Можно только уменьшить количество фактически взятых реек");
  });

  it("rejects increase", () => {
    expect(() =>
      assertCorrectionCommandIntegers({ expectedOldRailsTaken: 7, newRailsTaken: 10 }),
    ).toThrow("Можно только уменьшить количество фактически взятых реек");
  });

  it("rejects zero and non-integers", () => {
    expect(() =>
      assertCorrectionCommandIntegers({ expectedOldRailsTaken: 10, newRailsTaken: 0 }),
    ).toThrow("Количество реек должно быть целым и больше нуля");
    expect(() =>
      assertCorrectionCommandIntegers({ expectedOldRailsTaken: 10, newRailsTaken: 7.5 }),
    ).toThrow("Количество реек должно быть целым и больше нуля");
    expect(() =>
      assertCorrectionCommandIntegers({ expectedOldRailsTaken: 0, newRailsTaken: -1 }),
    ).toThrow("Ожидаемое количество реек должно быть целым и больше нуля");
  });
});

describe("R-05 payload binding", () => {
  it("trims reason as audit metadata", () => {
    expect(canonicalCorrectionReason("  foo  ")).toBe("foo");
  });

  it("deltaReturned is expectedOld - new", () => {
    expect(correctionDeltaReturned(10, 7)).toBe(3);
  });

  it("matches identical command fields", () => {
    expect(correctionPayloadMatches(base, { ...base })).toBe(true);
  });

  it("rejects requestId reuse for a different target, old, operation, reason, or admin", () => {
    expect(correctionPayloadMatches(base, { ...base, newRailsTaken: 6 })).toBe(false);
    expect(correctionPayloadMatches(base, { ...base, expectedOldRailsTaken: 9 })).toBe(false);
    expect(correctionPayloadMatches(base, { ...base, operationId: "op-2" })).toBe(false);
    expect(correctionPayloadMatches(base, { ...base, reason: "другое" })).toBe(false);
    expect(correctionPayloadMatches(base, { ...base, adminUserId: "admin-2" })).toBe(false);
    expect(() => assertCorrectionPayloadMatch(base, { ...base, reason: "другое" })).toThrow(
      REQUEST_ID_REUSE,
    );
  });

  it("exposes stable stale/reuse codes", () => {
    expect(STALE_CORRECTION.startsWith("STALE_CORRECTION")).toBe(true);
    expect(REQUEST_ID_REUSE.startsWith("REQUEST_ID_REUSE")).toBe(true);
  });
});

describe("R-05 requestId advisory lock", () => {
  it("uses a dedicated namespace distinct from R-10 SHADOW (8322)", () => {
    expect(R05_CORRECTION_REQUEST_LOCK_NAMESPACE).toBe(8325);
    expect(R05_CORRECTION_REQUEST_LOCK_NAMESPACE).not.toBe(INVENTORY_MOVEMENT_SHADOW_LOCK_NS);
    expect(R05_CORRECTION_REQUEST_LOCK_NAMESPACE).not.toBe(8322);
  });

  it("issues transaction-scoped pg_advisory_xact_lock(hashtext(requestId))", async () => {
    const sql: string[] = [];
    const tx = {
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        sql.push(strings.join("?"));
        expect(values).toContain(R05_CORRECTION_REQUEST_LOCK_NAMESPACE);
        expect(values).toContain("req-x");
        return [];
      },
    };
    await acquireCorrectionRequestLock(tx as never, "req-x");
    expect(sql.join("")).toMatch(/pg_advisory_xact_lock/);
    expect(sql.join("")).toMatch(/hashtext/);
    expect(sql.join("")).not.toMatch(/8322/);
  });

  it("pins production.ts: requestId lock before op FOR UPDATE and create; no P2002 recovery SELECT", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "src/server/production.ts"), "utf8");
    const action = src.slice(src.indexOf("export async function correctTorcovkaRailsTaken"));
    const lockAt = action.indexOf("acquireCorrectionRequestLock");
    const lookupAt = action.indexOf("productionOperationCorrection.findUnique");
    const opLockAt = action.indexOf("lockProductionOperations");
    const createAt = action.indexOf("productionOperationCorrection.create");
    expect(lockAt).toBeGreaterThan(-1);
    expect(lookupAt).toBeGreaterThan(lockAt);
    expect(opLockAt).toBeGreaterThan(lookupAt);
    expect(createAt).toBeGreaterThan(opLockAt);
    expect(action).not.toMatch(/P2002/);
    expect(action).not.toMatch(/isRequestIdUniqueConflict/);
    expect(action).not.toMatch(/PrismaClientKnownRequestError/);
  });
});
