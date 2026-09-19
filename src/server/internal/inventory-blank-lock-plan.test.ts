import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalLengthFixed4 } from "@/server/internal/blank-length";
import {
  blankSpecSortKey,
  planInventoryBlankStockLockSpecs,
  type BlankSpec,
} from "@/server/internal/inventory-integrity";

const POLKA = "POLKA" as const;
const SORT1 = "SORT1" as const;

function specKey(spec: BlankSpec): string {
  return blankSpecSortKey(spec);
}

describe("planInventoryBlankStockLockSpecs", () => {
  const matA = "mat-a";
  const matZ = "mat-z";
  const blankShort = {
    id: "blank-short",
    materialId: matA,
    lengthM: "1.2000",
    detailType: POLKA,
    sort: SORT1,
  };
  const blankLong = {
    id: "blank-long",
    materialId: matZ,
    lengthM: "1.8000",
    detailType: POLKA,
    sort: SORT1,
  };
  const aliasDetail = {
    id: "detail-alias",
    materialId: matA,
    lengthM: "1.2000",
    detailType: POLKA,
    sort: SORT1,
    prisadkaTorcevaya: false,
    prisadkaPloskost: false,
  };
  const prisadkaDetail = {
    id: "detail-ready",
    materialId: matA,
    lengthM: "0.7360",
    detailType: POLKA,
    sort: SORT1,
    prisadkaTorcevaya: true,
    prisadkaPloskost: false,
  };

  it("A/B vs B/A line order produces the same canonical BlankStock lock plan", () => {
    const resolution = {
      blankRows: [blankLong, blankShort],
      details: [],
    };
    const forward = planInventoryBlankStockLockSpecs(
      [
        { refType: "BLANK", refId: blankLong.id },
        { refType: "BLANK", refId: blankShort.id },
      ],
      resolution,
    );
    const reverse = planInventoryBlankStockLockSpecs(
      [
        { refType: "BLANK", refId: blankShort.id },
        { refType: "BLANK", refId: blankLong.id },
      ],
      resolution,
    );
    expect(forward.map(specKey)).toEqual(reverse.map(specKey));
    expect(forward.map(specKey)).toEqual(
      [
        { materialId: matA, lengthM: "1.2000", detailType: POLKA, sort: SORT1 },
        { materialId: matZ, lengthM: "1.8000", detailType: POLKA, sort: SORT1 },
      ].map(specKey),
    );
  });

  it("duplicate aliases collapse to one spec", () => {
    const plan = planInventoryBlankStockLockSpecs(
      [
        { refType: "BLANK", refId: blankShort.id },
        { refType: "BLANK", refId: blankShort.id },
      ],
      { blankRows: [blankShort], details: [] },
    );
    expect(plan).toHaveLength(1);
    expect(specKey(plan[0]!)).toBe(
      specKey({ materialId: matA, lengthM: "1.2000", detailType: POLKA, sort: SORT1 }),
    );
  });

  it("1.8 and 1.8000 identify the same BLANK target via canonicalLengthFixed4", () => {
    expect(canonicalLengthFixed4("1.8")).toBe("1.8000");
    const rows = [
      {
        id: "blank-short-form",
        materialId: matZ,
        lengthM: "1.8",
        detailType: POLKA,
        sort: SORT1,
      },
      {
        id: "blank-fixed4",
        materialId: matZ,
        lengthM: "1.8000",
        detailType: POLKA,
        sort: SORT1,
      },
    ];
    const plan = planInventoryBlankStockLockSpecs(
      [
        { refType: "BLANK", refId: "blank-short-form" },
        { refType: "BLANK", refId: "blank-fixed4" },
      ],
      { blankRows: rows, details: [] },
    );
    expect(plan).toHaveLength(1);
    expect(canonicalLengthFixed4(String(plan[0]!.lengthM))).toBe("1.8000");
  });

  it("direct BLANK + no-prisadka DETAIL alias of the same physical tuple → one lock target", () => {
    const plan = planInventoryBlankStockLockSpecs(
      [
        { refType: "DETAIL", refId: aliasDetail.id },
        { refType: "BLANK", refId: blankShort.id },
      ],
      { blankRows: [blankShort], details: [aliasDetail] },
    );
    expect(plan).toHaveLength(1);
    expect(specKey(plan[0]!)).toBe(
      specKey({ materialId: matA, lengthM: "1.2000", detailType: POLKA, sort: SORT1 }),
    );
  });

  it("prisadka DETAIL does not add a BlankStock lock target", () => {
    const plan = planInventoryBlankStockLockSpecs(
      [{ refType: "DETAIL", refId: prisadkaDetail.id }],
      { blankRows: [], details: [prisadkaDetail] },
    );
    expect(plan).toEqual([]);
  });

  it("missing BLANK id is omitted rather than invented", () => {
    const plan = planInventoryBlankStockLockSpecs(
      [{ refType: "BLANK", refId: "missing" }],
      { blankRows: [blankShort], details: [] },
    );
    expect(plan).toEqual([]);
  });
});

describe("Inventory BlankStock lock acquisition source", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

  it("inactive Inventory path acquires BlankStock from the global planned spec set once", () => {
    const src = readFileSync(path.join(root, "src/server/internal/inventory-integrity.ts"), "utf8");
    const start = src.indexOf("export async function lockInventoryStockRows");
    const end = src.indexOf("export async function lockBlankStockByIds");
    const fn = src.slice(start, end);
    expect(fn).toContain("collectInventoryBlankLockSpecs");
    expect(fn).toContain("lockBlankSpecs");
    expect(fn).not.toContain("lockBlankStockByIds");
  });

  it("ACTIVE Inventory path does not take a second BlankStock id batch after the planned spec set", () => {
    const src = readFileSync(path.join(root, "src/server/internal/cost-flow-downstream.ts"), "utf8");
    const start = src.indexOf("export async function lockActiveInventoryWriteSet");
    const end = src.indexOf("export async function applyActiveInventoryConduct");
    const fn = src.slice(start, end);
    expect(fn).toContain("collectInventoryBlankLockSpecs");
    expect(fn).toContain("ensureAndLockActiveBlankPools");
    expect(fn).not.toContain("lockBlankStockByIds");
  });
});
