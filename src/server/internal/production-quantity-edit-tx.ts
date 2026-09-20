import { Prisma } from "@prisma/client";
import { writeChangeLog } from "@/server/change-log";
import { D } from "@/lib/cost";
import { lockProductionOperations } from "@/server/internal/finance-operations";
import { correctActivePrisadkaLine } from "@/server/internal/cost-flow-downstream";
import { correctActiveTorcovkaLineQuantityInTx } from "@/server/internal/cost-flow-raw";
import { isCostFlowActive } from "@/server/internal/cost-flow-state";
import type { MovementActorSnapshot } from "@/server/internal/inventory-movement-actor";
import { isInventoryMovementShadowWriteActiveForWriter } from "@/server/internal/inventory-movement-shadow-write";
import {
  assertTorcovkaBlankInventoryBoundary,
  preparePrisadkaEdit,
  prepareTorcovkaBlankMutation,
  prepareUpakovkaEdit,
  type BlankSpec,
} from "@/server/internal/inventory-integrity";
import {
  applyPrisadkaPick,
  applyUpakovkaPrepared,
  reversePrisadkaLine,
  reverseUpakovkaOperation,
} from "@/server/internal/production-reversal";
import { isOverRailLength } from "@/lib/torcovka";
import type { OperationType } from "@/types/domain";
import {
  QUANTITY_EDIT_SHADOW_WRITER_NOT_READY,
  QUANTITY_EDIT_UPAKOVKA_COST_FLOW_NOT_READY,
  STALE_QUANTITY_EDIT,
  acquireQuantityEditRequestLock,
  assertNoMoneyInQuantityEditContract,
  assertQuantityEditPayloadMatch,
  buildPrisadkaAfterProvenance,
  buildPrisadkaBeforeProvenance,
  buildQuantityEditEffectSnapshot,
  buildQuantityEditRequestSnapshot,
  buildTorcovkaProvenance,
  buildUpakovkaProvenance,
  collectPhysicalKeys,
  computeQuantityEditStateFingerprint,
  derivePhysicalAdjustments,
  quantityEditResultFromRow,
  snapshotPhysicalQuantities,
  type QuantityEditCommandPayload,
  type QuantityEditLine,
  type QuantityEditNomLine,
  type QuantityEditResult,
} from "@/server/internal/production-quantity-edit";

type OpFull = Prisma.ProductionOperationGetPayload<{
  include: { lines: true; nomenclatureLines: true };
}>;

function num(value: Prisma.Decimal | number | null): number {
  if (value == null) return 0;
  return typeof value === "object" && "toNumber" in value ? value.toNumber() : Number(value);
}

function asEditLine(line: OpFull["lines"][number]): QuantityEditLine {
  return {
    id: line.id,
    quantity: line.quantity,
    detailId: line.detailId,
    blankLengthM: line.blankLengthM,
    blankType: line.blankType,
    blankSort: line.blankSort,
    blankMaterialId: line.blankMaterialId,
    prisadkaTorcevaya: line.prisadkaTorcevaya,
    prisadkaPloskost: line.prisadkaPloskost,
    sourceIsBlank: line.sourceIsBlank,
    sourceTorcevayaDone: line.sourceTorcevayaDone,
    sourcePloskostDone: line.sourcePloskostDone,
  };
}

function asNomLine(line: OpFull["nomenclatureLines"][number]): QuantityEditNomLine {
  return {
    id: line.id,
    nomenclatureId: line.nomenclatureId,
    quantity: line.quantity,
  };
}

function requireUserActor(
  actor: MovementActorSnapshot,
): Extract<MovementActorSnapshot, { actorKind: "USER" }> {
  if (actor.actorKind !== "USER") {
    throw new Error("Quantity edit requires a retained USER actor");
  }
  return actor;
}

function requireTorcovkaBlankSpecs(lines: OpFull["lines"]): BlankSpec[] {
  return lines.map((l) => {
    if (
      l.blankLengthM == null ||
      l.blankType == null ||
      l.blankSort == null ||
      l.blankMaterialId == null
    ) {
      throw new Error("Строка торцовки без спецификации заготовки");
    }
    return {
      materialId: l.blankMaterialId,
      lengthM: l.blankLengthM,
      detailType: l.blankType,
      sort: l.blankSort,
    };
  });
}

function assertPhysicalType(type: OperationType): asserts type is "TORCOVKA" | "PRISADKA" | "UPAKOVKA" {
  if (type !== "TORCOVKA" && type !== "PRISADKA" && type !== "UPAKOVKA") {
    throw new Error("Редактирование этого типа операции пока недоступно");
  }
}

export type QuantityEditTxInput = {
  actor: MovementActorSnapshot;
  operationId: string;
  requestId: string;
  targetLineId: string | null;
  expectedOldQuantity: number;
  newQuantity: number;
  expectedStateFingerprint: string;
};

export type QuantityEditTxOutcome = {
  result: QuantityEditResult;
  enqueueBatchId: string | null;
  revalidateReports: boolean;
};

export async function editProductionOperationQuantityInTransaction(
  tx: Prisma.TransactionClient,
  input: QuantityEditTxInput,
): Promise<QuantityEditTxOutcome> {
  const actor = requireUserActor(input.actor);
  const command: QuantityEditCommandPayload = {
    operationId: input.operationId,
    adminUserId: actor.userId,
    targetLineId: input.targetLineId,
    expectedOldQuantity: input.expectedOldQuantity,
    newQuantity: input.newQuantity,
    expectedStateFingerprint: input.expectedStateFingerprint,
  };

  const shadowWriteActive = await isInventoryMovementShadowWriteActiveForWriter(tx);
  if (shadowWriteActive) {
    throw new Error(QUANTITY_EDIT_SHADOW_WRITER_NOT_READY);
  }

  await acquireQuantityEditRequestLock(tx, input.requestId);

  const applyExisting = (existing: {
    id: string;
    requestId: string;
    operationId: string;
    adminUserId: string;
    targetLineId: string | null;
    expectedOldQuantity: number;
    newQuantity: number;
    expectedStateFingerprint: string;
  }): QuantityEditTxOutcome => {
    assertQuantityEditPayloadMatch(
      {
        operationId: existing.operationId,
        adminUserId: existing.adminUserId,
        targetLineId: existing.targetLineId,
        expectedOldQuantity: existing.expectedOldQuantity,
        newQuantity: existing.newQuantity,
        expectedStateFingerprint: existing.expectedStateFingerprint,
      },
      command,
    );
    return { result: quantityEditResultFromRow(existing, true), enqueueBatchId: null, revalidateReports: false };
  };

  const existing = await tx.productionOperationQuantityEdit.findUnique({
    where: { requestId: input.requestId },
  });
  if (existing) return applyExisting(existing);

  await lockProductionOperations(tx, [input.operationId]);

  const raced = await tx.productionOperationQuantityEdit.findUnique({
    where: { requestId: input.requestId },
  });
  if (raced) return applyExisting(raced);

  const op = await tx.productionOperation.findUnique({
    where: { id: input.operationId },
    include: {
      lines: { orderBy: { id: "asc" } },
      nomenclatureLines: { orderBy: { id: "asc" } },
    },
  });
  if (!op) throw new Error("Операция не найдена");
  if (op.isPaid) throw new Error("Нельзя изменить — операция уже выплачена");
  assertPhysicalType(op.type);

  if (op.type === "UPAKOVKA") {
    if (input.targetLineId != null) {
      throw new Error("Для упаковки цель правки — сама операция, не строка");
    }
  } else if (!input.targetLineId) {
    throw new Error("Для торцовки и присадки нужна стабильная строка");
  }

  const targetLine =
    op.type === "UPAKOVKA"
      ? null
      : (op.lines.find((l) => l.id === input.targetLineId) ?? null);
  if (op.type !== "UPAKOVKA" && !targetLine) {
    throw new Error(STALE_QUANTITY_EDIT);
  }

  const currentQuantity = op.type === "UPAKOVKA" ? (op.productQty ?? 0) : targetLine!.quantity;
  if (currentQuantity !== input.expectedOldQuantity) {
    throw new Error(STALE_QUANTITY_EDIT);
  }

  const actualFingerprint = computeQuantityEditStateFingerprint({
    operationId: op.id,
    operationType: op.type,
    productId: op.productId,
    productQty: op.productQty,
    line: targetLine ? asEditLine(targetLine) : null,
    lines: op.lines.map(asEditLine),
    nomenclatureLines: op.nomenclatureLines.map(asNomLine),
  });
  if (actualFingerprint !== input.expectedStateFingerprint) {
    throw new Error(STALE_QUANTITY_EDIT);
  }

  if (currentQuantity === input.newQuantity) {
    return {
      result: {
        quantityEditId: null,
        requestId: input.requestId,
        operationId: op.id,
        replayed: false,
        noop: true,
      },
      enqueueBatchId: null,
      revalidateReports: false,
    };
  }

  const costFlowActive = await isCostFlowActive(tx);
  if (op.type === "UPAKOVKA" && costFlowActive) {
    throw new Error(QUANTITY_EDIT_UPAKOVKA_COST_FLOW_NOT_READY);
  }

  const beforeKeys = collectPhysicalKeys({
    productId: op.productId,
    lines: op.lines.map(asEditLine),
    nomenclatureLines: op.nomenclatureLines.map(asNomLine),
  });
  const beforeQty = await snapshotPhysicalQuantities(tx, beforeKeys);
  const beforeProvenance = captureBeforeProvenance(op, targetLine);

  await executePhysicalQuantityEdit(tx, {
    op,
    targetLine,
    newQty: input.newQuantity,
    costFlowActive,
  });

  const afterOp = await tx.productionOperation.findUniqueOrThrow({
    where: { id: op.id },
    include: {
      lines: { orderBy: { id: "asc" } },
      nomenclatureLines: { orderBy: { id: "asc" } },
    },
  });
  const afterKeys = collectPhysicalKeys({
    productId: afterOp.productId,
    lines: afterOp.lines.map(asEditLine),
    nomenclatureLines: afterOp.nomenclatureLines.map(asNomLine),
  });
  const keyById = new Map(beforeKeys.map((k) => [
    k.targetType === "BLANK"
      ? `BLANK|${k.materialId}|${k.lengthM}|${k.detailType}|${k.sort}`
      : k.targetType === "DETAIL"
        ? `DETAIL|${k.detailId}|${k.torcevayaDone ? "1" : "0"}|${k.ploskostDone ? "1" : "0"}`
        : k.targetType === "NOMENCLATURE"
          ? `NOMENCLATURE|${k.nomenclatureId}`
          : `PRODUCT|${k.productId}`,
    k,
  ]));
  for (const key of afterKeys) {
    const id =
      key.targetType === "BLANK"
        ? `BLANK|${key.materialId}|${key.lengthM}|${key.detailType}|${key.sort}`
        : key.targetType === "DETAIL"
          ? `DETAIL|${key.detailId}|${key.torcevayaDone ? "1" : "0"}|${key.ploskostDone ? "1" : "0"}`
          : key.targetType === "NOMENCLATURE"
            ? `NOMENCLATURE|${key.nomenclatureId}`
            : `PRODUCT|${key.productId}`;
    keyById.set(id, key);
  }
  const unionKeys = [...keyById.values()];
  const afterQty = await snapshotPhysicalQuantities(tx, unionKeys);
  const physicalAdjustments = derivePhysicalAdjustments(unionKeys, beforeQty, afterQty);
  const afterProvenance = captureAfterProvenance(op.type, afterOp, targetLine?.id ?? null);
  const requestSnapshot = buildQuantityEditRequestSnapshot({
    operationId: op.id,
    targetLineId: input.targetLineId,
    expectedOldQuantity: input.expectedOldQuantity,
    newQuantity: input.newQuantity,
    expectedStateFingerprint: input.expectedStateFingerprint,
  });
  const effectSnapshot = buildQuantityEditEffectSnapshot({
    before: beforeProvenance,
    after: afterProvenance,
    physicalAdjustments,
  });
  assertNoMoneyInQuantityEditContract(requestSnapshot);
  assertNoMoneyInQuantityEditContract(effectSnapshot);

  const row = await tx.productionOperationQuantityEdit.create({
    data: {
      requestId: input.requestId,
      operationId: op.id,
      adminUserId: actor.userId,
      actorDisplaySnapshot: actor.actorDisplaySnapshot,
      operationType: op.type,
      targetLineId: input.targetLineId,
      expectedOldQuantity: input.expectedOldQuantity,
      newQuantity: input.newQuantity,
      expectedStateFingerprint: input.expectedStateFingerprint,
      requestSnapshot: requestSnapshot as Prisma.InputJsonValue,
      effectSnapshot: effectSnapshot as Prisma.InputJsonValue,
    },
  });

  await writeChangeLog(
    {
      entity: "ProductionOperation",
      entityId: op.id,
      userId: actor.userId,
      newValues: {
        field: "Количество",
        oldValue: input.expectedOldQuantity,
        newValue: input.newQuantity,
        quantityEditId: row.id,
        requestId: input.requestId,
      },
    },
    tx,
  );

  return {
    result: quantityEditResultFromRow(row, false),
    enqueueBatchId: op.type === "TORCOVKA" ? op.batchId : null,
    revalidateReports: true,
  };
}

function captureBeforeProvenance(
  op: OpFull,
  targetLine: OpFull["lines"][number] | null,
): Record<string, unknown> {
  if (op.type === "TORCOVKA" && targetLine) return buildTorcovkaProvenance(asEditLine(targetLine));
  if (op.type === "PRISADKA" && targetLine) return buildPrisadkaBeforeProvenance(asEditLine(targetLine));
  return buildUpakovkaProvenance({
    productId: op.productId ?? "",
    productQty: op.productQty ?? 0,
    lines: op.lines.map(asEditLine),
    nomenclatureLines: op.nomenclatureLines.map(asNomLine),
  });
}

function captureAfterProvenance(
  type: OperationType,
  afterOp: OpFull,
  originalLineId: string | null,
): Record<string, unknown> {
  if (type === "TORCOVKA") {
    const line = afterOp.lines.find((l) => l.id === originalLineId);
    if (!line) throw new Error("Строка торцовки не найдена после правки");
    return buildTorcovkaProvenance(asEditLine(line));
  }
  if (type === "PRISADKA") {
    const replacement = afterOp.lines.filter((l) => l.id !== originalLineId);
    return buildPrisadkaAfterProvenance(replacement.map(asEditLine));
  }
  return buildUpakovkaProvenance({
    productId: afterOp.productId ?? "",
    productQty: afterOp.productQty ?? 0,
    lines: afterOp.lines.map(asEditLine),
    nomenclatureLines: afterOp.nomenclatureLines.map(asNomLine),
  });
}

async function executePhysicalQuantityEdit(
  tx: Prisma.TransactionClient,
  input: {
    op: OpFull;
    targetLine: OpFull["lines"][number] | null;
    newQty: number;
    costFlowActive: boolean;
  },
): Promise<void> {
  const { op, targetLine, newQty, costFlowActive } = input;
  const id = op.id;

  if (op.type === "UPAKOVKA") {
    if (!op.productId) throw new Error("У операции не указано изделие");
    const oldQty = op.productQty ?? 0;
    const prepared = await prepareUpakovkaEdit(
      tx,
      op.createdAt,
      op.productId,
      op.lines,
      op.nomenclatureLines,
    );
    await reverseUpakovkaOperation(
      tx,
      op.productId,
      oldQty,
      op.lines,
      op.nomenclatureLines,
      op.createdAt,
    );
    await tx.operationDetailLine.deleteMany({ where: { operationId: id } });
    await tx.operationNomenclatureLine.deleteMany({ where: { operationId: id } });
    await applyUpakovkaPrepared(tx, id, newQty, prepared);
    await tx.productionOperation.update({ where: { id }, data: { productQty: newQty } });
    return;
  }

  if (!targetLine) throw new Error("Строка не найдена");

  if (op.type === "PRISADKA") {
    const kind: "torcev" | "plosk" = targetLine.prisadkaTorcevaya ? "torcev" : "plosk";
    if (!targetLine.detailId) throw new Error("Строка присадки без детали");
    const lineIndex = op.lines.findIndex((l) => l.id === targetLine.id);
    if (lineIndex < 0) throw new Error(STALE_QUANTITY_EDIT);
    if (costFlowActive) {
      await correctActivePrisadkaLine({
        tx,
        op: { id: op.id, createdAt: op.createdAt, lines: op.lines },
        lineIndex,
        newQty,
      });
      return;
    }
    await preparePrisadkaEdit(tx, op.createdAt, targetLine, newQty);
    await reversePrisadkaLine(tx, targetLine);
    await tx.operationDetailLine.delete({ where: { id: targetLine.id } });
    await applyPrisadkaPick(tx, id, targetLine.detailId, kind, newQty);
    return;
  }

  const { blankLengthM, blankType, blankSort, blankMaterialId } = targetLine;
  if (blankLengthM == null || blankType == null || blankSort == null || blankMaterialId == null) {
    throw new Error("Строка торцовки без спецификации заготовки");
  }
  const lineId = targetLine.id;
  const oldQty = targetLine.quantity;
  const delta = newQty - oldQty;

  if (costFlowActive) {
    const specs = requireTorcovkaBlankSpecs(op.lines);
    await assertTorcovkaBlankInventoryBoundary(tx, op.createdAt, specs);
    if (op.railLotId && op.railsTaken) {
      const lot = await tx.railLot.findUnique({ where: { id: op.railLotId } });
      const takenM = D(op.railsTaken).times(D(lot ? lot.lengthM : 0));
      const usedM = op.lines.reduce(
        (sum, l) => sum.plus(D(num(l.blankLengthM)).times(l.id === lineId ? newQty : l.quantity)),
        D(0),
      );
      if (usedM.gt(takenM)) {
        throw new Error("Суммарная длина заготовок превышает длину взятых реек");
      }
    }
    await correctActiveTorcovkaLineQuantityInTx({
      tx,
      op,
      lineId,
      newQty,
    });
    return;
  }

  await prepareTorcovkaBlankMutation(tx, op.createdAt, [
    {
      materialId: blankMaterialId,
      lengthM: blankLengthM,
      detailType: blankType,
      sort: blankSort,
    },
  ]);

  if (delta < 0) {
    const dec = await tx.blankStock.updateMany({
      where: {
        materialId: blankMaterialId,
        lengthM: blankLengthM,
        detailType: blankType,
        sort: blankSort,
        quantity: { gte: -delta },
      },
      data: { quantity: { decrement: -delta } },
    });
    if (dec.count === 0) throw new Error("Нельзя уменьшить: заготовки уже прошли присадку/упаковку");
  } else {
    if (op.railLotId && op.railsTaken) {
      const lot = await tx.railLot.findUnique({ where: { id: op.railLotId } });
      const takenLengthM = op.railsTaken * (lot ? num(lot.lengthM) : 0);
      const usedLengthM = op.lines.reduce(
        (sum, l) => sum + num(l.blankLengthM) * (l.id === lineId ? newQty : l.quantity),
        0,
      );
      if (isOverRailLength(takenLengthM, usedLengthM)) {
        throw new Error("Суммарная длина заготовок превышает длину взятых реек");
      }
    }
    await tx.blankStock.upsert({
      where: {
        materialId_lengthM_detailType_sort: {
          materialId: blankMaterialId,
          lengthM: blankLengthM,
          detailType: blankType,
          sort: blankSort,
        },
      },
      create: {
        materialId: blankMaterialId,
        lengthM: blankLengthM,
        detailType: blankType,
        sort: blankSort,
        quantity: delta,
      },
      update: { quantity: { increment: delta } },
    });
  }
  await tx.operationDetailLine.update({ where: { id: lineId }, data: { quantity: newQty } });
}
