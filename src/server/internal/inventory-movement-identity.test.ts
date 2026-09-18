import { createHash } from "node:crypto";
import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { canonicalLengthFixed4 } from "@/server/internal/blank-length";
import {
  canonicalizeMovementTarget,
  compareEffectKey,
  effectKeyV1,
  targetHashV1,
  targetKeyV1,
} from "@/server/internal/inventory-movement-identity";

describe("targetKeyV1 / targetHashV1", () => {
  it("serializes RAIL_LOT with exact key order", () => {
    const key = targetKeyV1({ stockDomain: "RAIL_LOT", railLotId: "lot-1" });
    expect(key).toBe('{"v":1,"d":"RAIL_LOT","railLotId":"lot-1"}');
    expect(targetHashV1(key)).toBe(createHash("sha256").update(key, "utf8").digest("hex"));
  });

  it("canonicalizes BLANK lengthM through canonicalLengthFixed4", () => {
    const fromNumber = targetKeyV1({
      stockDomain: "BLANK",
      materialId: "mat-1",
      lengthM: 1.8,
      detailType: "POLKA",
      sort: "SORT1",
    });
    const fromShort = targetKeyV1({
      stockDomain: "BLANK",
      materialId: "mat-1",
      lengthM: "1.8",
      detailType: "POLKA",
      sort: "SORT1",
    });
    const fromDecimal = targetKeyV1({
      stockDomain: "BLANK",
      materialId: "mat-1",
      lengthM: new Decimal("1.8"),
      detailType: "POLKA",
      sort: "SORT1",
    });
    const expected = `{"v":1,"d":"BLANK","materialId":"mat-1","lengthM":"${canonicalLengthFixed4("1.8")}","detailType":"POLKA","sort":"SORT1"}`;
    expect(canonicalLengthFixed4("1.8")).toBe("1.8000");
    expect(fromNumber).toBe(expected);
    expect(fromShort).toBe(expected);
    expect(fromDecimal).toBe(expected);
    expect(fromNumber).not.toContain('"1.8"');
  });

  it("serializes DETAIL / NOMENCLATURE / PRODUCT", () => {
    expect(
      targetKeyV1({
        stockDomain: "DETAIL",
        detailId: "d1",
        torcevayaDone: true,
        ploskostDone: false,
      }),
    ).toBe('{"v":1,"d":"DETAIL","detailId":"d1","torcevayaDone":true,"ploskostDone":false}');
    expect(targetKeyV1({ stockDomain: "NOMENCLATURE", nomenclatureId: "n1" })).toBe(
      '{"v":1,"d":"NOMENCLATURE","nomenclatureId":"n1"}',
    );
    expect(targetKeyV1({ stockDomain: "PRODUCT", productId: "p1" })).toBe(
      '{"v":1,"d":"PRODUCT","productId":"p1"}',
    );
  });
});

describe("effectKeyV1", () => {
  it("uses imfx1 role hash and optional qualifier", () => {
    const hash = "ab".repeat(32);
    expect(effectKeyV1("adjust", hash)).toBe(`imfx1:adjust:${hash}`);
    expect(effectKeyV1("restore", hash, "g=1")).toBe(`imfx1:restore:${hash}:g=1`);
  });
});

describe("canonicalizeMovementTarget", () => {
  it("keeps the same physical BLANK target identical", () => {
    const a = canonicalizeMovementTarget({
      stockDomain: "BLANK",
      materialId: "mat-1",
      lengthM: 1.8,
      detailType: "KANAVKA",
      sort: "SORT2",
    });
    const b = canonicalizeMovementTarget({
      stockDomain: "BLANK",
      materialId: "mat-1",
      lengthM: "1.8000",
      detailType: "KANAVKA",
      sort: "SORT2",
    });
    expect(a.targetKeyV1).toBe(b.targetKeyV1);
    expect(a.targetHashV1).toBe(b.targetHashV1);
    expect(a.lengthMFixed4).toBe("1.8000");
  });
});

describe("compareEffectKey", () => {
  it("is deterministic and independent of input array order", () => {
    const keys = ["imfx1:output:bb", "imfx1:consume:aa", "imfx1:adjust:cc"];
    const forward = [...keys].sort(compareEffectKey);
    const reverse = [...keys].reverse().sort(compareEffectKey);
    expect(forward).toEqual(reverse);
    expect(forward[0]).toBe("imfx1:adjust:cc");
    expect(forward[1]).toBe("imfx1:consume:aa");
  });
});
