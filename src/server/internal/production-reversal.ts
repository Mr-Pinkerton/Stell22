import type { Prisma } from "@prisma/client";
import { allocate, isReady, requiredPrisadki } from "@/lib/detail-stock";
import {
  lockDetails,
  prepareUpakovkaReverse,
  snapshotUpakovkaApply,
  type PreparedUpakovkaApply,
} from "@/server/internal/inventory-integrity";
import type { RailType, Sort } from "@/types/domain";

export async function applyPrisadkaPick(
  tx: Prisma.TransactionClient,
  operationId: string,
  detailId: string,
  kind: "torcev" | "plosk",
  quantity: number,
): Promise<void> {
  await lockDetails(tx, [detailId]);
  const detail = await tx.detail.findUniqueOrThrow({ where: { id: detailId } });
  let left = quantity;

  const partials = await tx.detailStock.findMany({
    where: {
      detailId,
      quantity: { gt: 0 },
      ...(kind === "torcev" ? { torcevayaDone: false } : { ploskostDone: false }),
    },
    orderBy: { id: "asc" },
  });
  for (const src of partials) {
    if (left <= 0) break;
    const take = Math.min(src.quantity, left);
    const dec = await tx.detailStock.updateMany({
      where: { id: src.id, quantity: { gte: take } },
      data: { quantity: { decrement: take } },
    });
    if (dec.count === 0) throw new Error("Недостаточно остатка деталей для присадки");
    const torcevayaDone = kind === "torcev" ? true : src.torcevayaDone;
    const ploskostDone = kind === "plosk" ? true : src.ploskostDone;
    await tx.detailStock.upsert({
      where: {
        detailId_torcevayaDone_ploskostDone: { detailId, torcevayaDone, ploskostDone },
      },
      create: { detailId, torcevayaDone, ploskostDone, quantity: take },
      update: { quantity: { increment: take } },
    });
    await tx.operationDetailLine.create({
      data: {
        operationId,
        detailId,
        quantity: take,
        prisadkaTorcevaya: kind === "torcev",
        prisadkaPloskost: kind === "plosk",
        sourceIsBlank: false,
        sourceTorcevayaDone: src.torcevayaDone,
        sourcePloskostDone: src.ploskostDone,
      },
    });
    left -= take;
  }

  if (left > 0) {
    const dec = await tx.blankStock.updateMany({
      where: {
        materialId: detail.materialId,
        lengthM: detail.lengthM,
        detailType: detail.detailType,
        sort: detail.sort,
        quantity: { gte: left },
      },
      data: { quantity: { decrement: left } },
    });
    if (dec.count === 0) throw new Error("Недостаточно заготовок для присадки");
    const torcevayaDone = kind === "torcev";
    const ploskostDone = kind === "plosk";
    await tx.detailStock.upsert({
      where: {
        detailId_torcevayaDone_ploskostDone: { detailId, torcevayaDone, ploskostDone },
      },
      create: { detailId, torcevayaDone, ploskostDone, quantity: left },
      update: { quantity: { increment: left } },
    });
    await tx.operationDetailLine.create({
      data: {
        operationId,
        detailId,
        quantity: left,
        prisadkaTorcevaya: kind === "torcev",
        prisadkaPloskost: kind === "plosk",
        sourceIsBlank: true,
        blankLengthM: detail.lengthM,
        blankType: detail.detailType,
        blankSort: detail.sort,
        blankMaterialId: detail.materialId,
      },
    });
  }
}

export async function reversePrisadkaLine(
  tx: Prisma.TransactionClient,
  line: {
    detailId: string | null;
    quantity: number;
    prisadkaTorcevaya: boolean;
    sourceIsBlank: boolean;
    sourceTorcevayaDone: boolean;
    sourcePloskostDone: boolean;
    blankLengthM: Prisma.Decimal | number | null;
    blankType: RailType | null;
    blankSort: Sort | null;
    blankMaterialId: string | null;
  },
): Promise<void> {
  if (!line.detailId) throw new Error("Строка присадки без детали");
  const detailId = line.detailId;
  await lockDetails(tx, [detailId]);
  const kind: "torcev" | "plosk" = line.prisadkaTorcevaya ? "torcev" : "plosk";
  const destTorcev = line.sourceIsBlank
    ? kind === "torcev"
    : kind === "torcev"
      ? true
      : line.sourceTorcevayaDone;
  const destPlosk = line.sourceIsBlank
    ? kind === "plosk"
    : kind === "plosk"
      ? true
      : line.sourcePloskostDone;

  const dec = await tx.detailStock.updateMany({
    where: {
      detailId,
      torcevayaDone: destTorcev,
      ploskostDone: destPlosk,
      quantity: { gte: line.quantity },
    },
    data: { quantity: { decrement: line.quantity } },
  });
  if (dec.count === 0) {
    throw new Error("Нельзя изменить/удалить: деталь уже использована в упаковке или дальнейшей присадке");
  }

  if (line.sourceIsBlank) {
    if (
      line.blankLengthM == null ||
      line.blankType == null ||
      line.blankSort == null ||
      line.blankMaterialId == null
    ) {
      throw new Error("Нет спецификации заготовки для возврата");
    }
    await tx.blankStock.upsert({
      where: {
        materialId_lengthM_detailType_sort: {
          materialId: line.blankMaterialId,
          lengthM: line.blankLengthM,
          detailType: line.blankType,
          sort: line.blankSort,
        },
      },
      create: {
        materialId: line.blankMaterialId,
        lengthM: line.blankLengthM,
        detailType: line.blankType,
        sort: line.blankSort,
        quantity: line.quantity,
      },
      update: { quantity: { increment: line.quantity } },
    });
    return;
  }

  await tx.detailStock.upsert({
    where: {
      detailId_torcevayaDone_ploskostDone: {
        detailId,
        torcevayaDone: line.sourceTorcevayaDone,
        ploskostDone: line.sourcePloskostDone,
      },
    },
    create: {
      detailId,
      torcevayaDone: line.sourceTorcevayaDone,
      ploskostDone: line.sourcePloskostDone,
      quantity: line.quantity,
    },
    update: { quantity: { increment: line.quantity } },
  });
}

export async function applyUpakovkaPick(
  tx: Prisma.TransactionClient,
  operationId: string,
  productId: string,
  quantity: number,
): Promise<void> {
  const prepared = await snapshotUpakovkaApply(tx, productId);
  await applyUpakovkaPrepared(tx, operationId, quantity, prepared);
}

export async function applyUpakovkaPrepared(
  tx: Prisma.TransactionClient,
  operationId: string,
  quantity: number,
  prepared: PreparedUpakovkaApply,
): Promise<void> {
  const neededByDetail = new Map<string, number>();
  const byId = new Map(prepared.details.map((d) => [d.detailId, d]));
  for (const pd of prepared.details) {
    if (pd.quantity <= 0) continue;
    neededByDetail.set(pd.detailId, (neededByDetail.get(pd.detailId) ?? 0) + pd.quantity * quantity);
  }

  const detailIds = [...neededByDetail.keys()].sort();
  await lockDetails(tx, detailIds);

  for (const detailId of detailIds) {
    const needed = neededByDetail.get(detailId) ?? 0;
    if (needed <= 0) continue;
    const detail = byId.get(detailId);
    if (!detail) throw new Error("Деталь не найдена");
    const req = requiredPrisadki(detail);

    if (!req.torcev && !req.plosk) {
      const dec = await tx.blankStock.updateMany({
        where: {
          materialId: detail.materialId,
          lengthM: detail.lengthM,
          detailType: detail.detailType,
          sort: detail.sort,
          quantity: { gte: needed },
        },
        data: { quantity: { decrement: needed } },
      });
      if (dec.count === 0) throw new Error("Недостаточно заготовок для упаковки");
      await tx.operationDetailLine.create({
        data: {
          operationId,
          detailId,
          quantity: needed,
          sourceIsBlank: true,
          blankLengthM: detail.lengthM,
          blankType: detail.detailType,
          blankSort: detail.sort,
          blankMaterialId: detail.materialId,
        },
      });
      continue;
    }

    const rows = (
      await tx.detailStock.findMany({
        where: { detailId, quantity: { gt: 0 } },
        orderBy: { id: "asc" },
      })
    ).filter((r) => isReady(detail, r.torcevayaDone, r.ploskostDone));
    const takes = allocate(
      rows.map((r) => r.quantity),
      needed,
    );
    for (let i = 0; i < rows.length; i++) {
      const take = takes[i];
      if (take <= 0) continue;
      const dec = await tx.detailStock.updateMany({
        where: { id: rows[i].id, quantity: { gte: take } },
        data: { quantity: { decrement: take } },
      });
      if (dec.count === 0) throw new Error("Недостаточно готовых деталей для упаковки");
      await tx.operationDetailLine.create({
        data: {
          operationId,
          detailId,
          quantity: take,
          sourceIsBlank: false,
          sourceTorcevayaDone: rows[i].torcevayaDone,
          sourcePloskostDone: rows[i].ploskostDone,
        },
      });
    }
  }

  const nomNeeds: { nomenclatureId: string; quantity: number; kind: "fastener" | "packaging" | "extra" }[] =
    [];
  for (const f of prepared.fasteners) {
    const needed = f.quantity * quantity;
    if (needed <= 0) continue;
    nomNeeds.push({ nomenclatureId: f.nomenclatureId, quantity: needed, kind: "fastener" });
  }
  if (prepared.packagingId) {
    nomNeeds.push({ nomenclatureId: prepared.packagingId, quantity, kind: "packaging" });
  }
  for (const ex of prepared.extras) {
    nomNeeds.push({ nomenclatureId: ex.nomenclatureId, quantity, kind: "extra" });
  }
  nomNeeds.sort((a, b) => a.nomenclatureId.localeCompare(b.nomenclatureId));

  for (const need of nomNeeds) {
    const dec = await tx.nomenclatureStock.updateMany({
      where: { nomenclatureId: need.nomenclatureId, quantity: { gte: need.quantity } },
      data: { quantity: { decrement: need.quantity } },
    });
    if (dec.count === 0) {
      if (need.kind === "fastener") throw new Error("Недостаточно крепежа на складе");
      if (need.kind === "packaging") throw new Error("Недостаточно упаковки на складе");
      throw new Error("Недостаточно доп. комплектующих на складе");
    }
    await tx.operationNomenclatureLine.create({
      data: { operationId, nomenclatureId: need.nomenclatureId, quantity: need.quantity },
    });
  }

  await tx.productStock.upsert({
    where: { productId: prepared.productId },
    create: { productId: prepared.productId, quantity },
    update: { quantity: { increment: quantity } },
  });
}

export async function reverseUpakovkaOperation(
  tx: Prisma.TransactionClient,
  productId: string,
  productQty: number,
  detailLines: {
    detailId: string | null;
    quantity: number;
    sourceIsBlank: boolean;
    sourceTorcevayaDone: boolean;
    sourcePloskostDone: boolean;
    blankLengthM: Prisma.Decimal | number | null;
    blankType: RailType | null;
    blankSort: Sort | null;
    blankMaterialId: string | null;
  }[],
  nomenclatureLines: { nomenclatureId: string; quantity: number }[],
  occurredAt: Date,
): Promise<void> {
  await prepareUpakovkaReverse(tx, occurredAt, productId, detailLines, nomenclatureLines);
  await lockDetails(
    tx,
    detailLines.map((l) => l.detailId),
  );
  const dec = await tx.productStock.updateMany({
    where: { productId, quantity: { gte: productQty } },
    data: { quantity: { decrement: productQty } },
  });
  if (dec.count === 0) {
    throw new Error("Нельзя изменить/удалить: изделие уже отгружено/продано");
  }

  for (const l of detailLines) {
    if (l.sourceIsBlank) {
      if (
        l.blankLengthM == null ||
        l.blankType == null ||
        l.blankSort == null ||
        l.blankMaterialId == null
      ) {
        throw new Error("Нет спецификации заготовки для возврата");
      }
      await tx.blankStock.upsert({
        where: {
          materialId_lengthM_detailType_sort: {
            materialId: l.blankMaterialId,
            lengthM: l.blankLengthM,
            detailType: l.blankType,
            sort: l.blankSort,
          },
        },
        create: {
          materialId: l.blankMaterialId,
          lengthM: l.blankLengthM,
          detailType: l.blankType,
          sort: l.blankSort,
          quantity: l.quantity,
        },
        update: { quantity: { increment: l.quantity } },
      });
      continue;
    }
    if (l.detailId == null) throw new Error("Строка упаковки без детали");
    await tx.detailStock.upsert({
      where: {
        detailId_torcevayaDone_ploskostDone: {
          detailId: l.detailId,
          torcevayaDone: l.sourceTorcevayaDone,
          ploskostDone: l.sourcePloskostDone,
        },
      },
      create: {
        detailId: l.detailId,
        torcevayaDone: l.sourceTorcevayaDone,
        ploskostDone: l.sourcePloskostDone,
        quantity: l.quantity,
      },
      update: { quantity: { increment: l.quantity } },
    });
  }

  for (const nl of nomenclatureLines) {
    await tx.nomenclatureStock.upsert({
      where: { nomenclatureId: nl.nomenclatureId },
      create: { nomenclatureId: nl.nomenclatureId, quantity: nl.quantity },
      update: { quantity: { increment: nl.quantity } },
    });
  }
}
