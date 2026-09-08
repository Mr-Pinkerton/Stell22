import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { sectionAreaM2 } from "@/lib/cost";
import { sectionFromBatch } from "@/server/internal/cost-flow-raw";

describe("sectionFromBatch monetary path", () => {
  it("uses Decimal sectionAreaM2 for non-integer millimetres", () => {
    const width = new Prisma.Decimal("20.5");
    const height = new Prisma.Decimal("32.7");
    const area = sectionFromBatch({ sectionWidthMm: width, sectionHeightMm: height });
    expect(area.equals(sectionAreaM2(width, height))).toBe(true);
    expect(area.equals(sectionAreaM2("20.5", "32.7"))).toBe(true);
    expect(area.toString()).toBe(sectionAreaM2("20.5", "32.7").toString());
  });
});
