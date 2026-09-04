import { prisma } from "@/server/db";
import { isPrismaP2002, prismaUniqueDiscriminator } from "@/lib/prisma-unique-conflict";

export function activeSkuClashMessage(kind: "Ozon" | "WB", sku: string): string {
  return `Артикул ${kind} «${sku}» уже используется`;
}

export function isDuplicateActiveSku(err: unknown): boolean {
  if (!isPrismaP2002(err)) return false;
  const d = prismaUniqueDiscriminator(err);
  return /skuOzon|skuWb|Product_skuOzon_active_key|Product_skuWb_active_key/i.test(d);
}

export function throwFriendlyActiveSkuConflict(err: unknown): never | void {
  if (isDuplicateActiveSku(err)) {
    throw new Error("Артикул маркетплейса уже используется у активного изделия");
  }
}

export async function assertUniqueActiveSkus(
  skuOzon: string,
  skuWb: string,
  excludeId?: string,
): Promise<void> {
  const ozon = skuOzon.trim();
  const wb = skuWb.trim();
  const exclude = excludeId ? { id: { not: excludeId } } : {};

  const [ozonHit, wbHit] = await Promise.all([
    ozon
      ? prisma.product.findFirst({
          where: { status: "ACTIVE", skuOzon: ozon, ...exclude },
          select: { id: true },
        })
      : Promise.resolve(null),
    wb
      ? prisma.product.findFirst({
          where: { status: "ACTIVE", skuWb: wb, ...exclude },
          select: { id: true },
        })
      : Promise.resolve(null),
  ]);

  if (ozonHit) throw new Error(activeSkuClashMessage("Ozon", ozon));
  if (wbHit) throw new Error(activeSkuClashMessage("WB", wb));
}
