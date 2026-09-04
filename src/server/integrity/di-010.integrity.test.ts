import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isDuplicateActiveSku } from "@/lib/active-sku";
import { prismaUniqueDiscriminator } from "@/lib/prisma-unique-conflict";
import {
  createIntegrityClients,
  ensureIntegritySchema,
  resetIntegrityFinance,
} from "./harness";

const enabled = Boolean(process.env.INTEGRITY_TEST_DATABASE_URL);

describe.skipIf(!enabled)("DI-010 integrity", () => {
  let prismaA: ReturnType<typeof createIntegrityClients>["prismaA"];

  beforeAll(() => {
    ensureIntegritySchema();
    ({ prismaA } = createIntegrityClients());
  });

  beforeEach(async () => {
    await resetIntegrityFinance(prismaA);
  });

  afterAll(async () => {
    await prismaA?.$disconnect();
  });

  async function material() {
    return prismaA.material.create({
      data: {
        name: `di010-${Date.now()}-${Math.random()}`,
        sectionWidthMm: 40,
        sectionHeightMm: 20,
      },
    });
  }

  async function product(
    materialId: string,
    over: { skuOzon?: string; skuWb?: string; status?: "ACTIVE" | "ARCHIVED"; name?: string },
  ) {
    return prismaA.product.create({
      data: {
        name: over.name ?? "Изделие",
        materialId,
        skuOzon: over.skuOzon ?? `OZ-${Math.random()}`,
        skuWb: over.skuWb ?? `WB-${Math.random()}`,
        sort: "SORT1",
        status: over.status ?? "ACTIVE",
      },
    });
  }

  it("duplicate ACTIVE skuOzon Prisma error exposes a stable discriminator", async () => {
    const m = await material();
    await product(m.id, { skuOzon: "OZ-DUP", skuWb: "WB-A" });
    try {
      await product(m.id, { skuOzon: "OZ-DUP", skuWb: "WB-B" });
      throw new Error("expected P2002");
    } catch (e) {
      expect(e).toMatchObject({ code: "P2002" });
      expect(prismaUniqueDiscriminator(e).length).toBeGreaterThan(0);
      expect(isDuplicateActiveSku(e)).toBe(true);
    }
  });

  it("two ARCHIVED products may share a SKU", async () => {
    const m = await material();
    await product(m.id, { skuOzon: "OZ-ARCH", skuWb: "WB-ARCH", status: "ARCHIVED", name: "A" });
    await product(m.id, { skuOzon: "OZ-ARCH", skuWb: "WB-ARCH", status: "ARCHIVED", name: "B" });
    expect(
      await prismaA.product.count({ where: { skuOzon: "OZ-ARCH", status: "ARCHIVED" } }),
    ).toBe(2);
  });

  it("ARCHIVED → ACTIVE is rejected when an ACTIVE product already has the SKU", async () => {
    const m = await material();
    await product(m.id, { skuOzon: "OZ-LIVE", skuWb: "WB-LIVE", status: "ACTIVE" });
    const archived = await product(m.id, {
      skuOzon: "OZ-LIVE",
      skuWb: "WB-OTHER",
      status: "ARCHIVED",
    });
    try {
      await prismaA.product.update({
        where: { id: archived.id },
        data: { status: "ACTIVE" },
      });
      throw new Error("expected P2002");
    } catch (e) {
      expect(e).toMatchObject({ code: "P2002" });
      expect(isDuplicateActiveSku(e)).toBe(true);
    }
  });
});
