import type { Prisma } from "@prisma/client";
import { lockBatches, lockRailLots } from "@/server/internal/finance-operations";
import { isCostFlowActive } from "@/server/internal/cost-flow-state";
import { writeChangeLog } from "@/server/change-log";

export const INCIDENT_ID = "INC-001";
export const RAIL_LOT_ID = "cmth51aoh006sph2af5gg0l4x";
export const EXPECTED_CODE = "ПАК-40-1280-01-7";
export const EXPECTED_BATCH_ID = "cmth51aog006dph2a1u1t9olf";
export const EXPECTED_QUANTITY = 1280;
export const EXPECTED_CURRENT_REMAINING = 0;
export const TARGET_REMAINING = 1280;
export const DELETED_OPERATION_ID = "cmtmj4dpi000srp29ek0iw37f";
export const INC_001_EXECUTE_TOKEN = "INC-001-RESTORE-1280";

export const INCIDENT_CHANGELOG_REASON =
  "INC-001: ошибочная TORCOVKA списала весь пакет. Удалённая операция отменила выпуск заготовок, но не вернула RailLot. Пакет восстановлен до исходного учётного состояния для повторного ввода фактической торцовки работником по бумажной первичной записи.";

type Tx = Prisma.TransactionClient;

export type Inc001RestoreDeps = {
  lockRailLots: typeof lockRailLots;
  lockBatches: typeof lockBatches;
  isCostFlowActive: (tx: Tx) => Promise<boolean>;
  writeChangeLog: typeof writeChangeLog;
};

const defaultDeps: Inc001RestoreDeps = {
  lockRailLots,
  lockBatches,
  isCostFlowActive,
  writeChangeLog,
};

export type Inc001RestorePlan = {
  ready: true;
  lotId: string;
  code: string;
  quantity: number;
  remainingQuantity: number;
  targetRemaining: number;
  batchStatus: string;
  frozen: boolean;
  liveOps: number;
  incidentOp: "ABSENT";
  costFlow: "INACTIVE";
  otherRailLotFieldsRequiringRestore: "NONE";
};

function fail(message: string): never {
  throw new Error(`INC-001 restore refused: ${message}`);
}

export async function restoreInc001SourcePackage(args: {
  tx: Tx;
  execute: boolean;
  deps?: Inc001RestoreDeps;
}): Promise<Inc001RestorePlan> {
  const deps = args.deps ?? defaultDeps;
  const { tx } = args;

  await deps.lockRailLots(tx, [RAIL_LOT_ID]);
  await deps.lockBatches(tx, [EXPECTED_BATCH_ID]);

  const lot = await tx.railLot.findUnique({ where: { id: RAIL_LOT_ID } });
  if (!lot) fail(`пакет ${RAIL_LOT_ID} не найден`);
  if (lot.id !== RAIL_LOT_ID) fail("id пакета не совпадает");
  if (lot.code !== EXPECTED_CODE) fail(`код пакета: expected ${EXPECTED_CODE}, got ${lot.code}`);
  if (lot.batchId !== EXPECTED_BATCH_ID) fail(`batchId: expected ${EXPECTED_BATCH_ID}`);
  if (lot.quantity !== EXPECTED_QUANTITY) fail(`quantity: expected ${EXPECTED_QUANTITY}`);
  if (lot.remainingQuantity !== EXPECTED_CURRENT_REMAINING) {
    fail(`remainingQuantity: expected ${EXPECTED_CURRENT_REMAINING}, got ${lot.remainingQuantity}`);
  }
  if (lot.initialValue != null || lot.remainingValue != null) {
    fail(
      `RailLot initialValue/remainingValue must stay null (inactive TORCOVKA did not write them); remainingValue=${String(lot.remainingValue)}`,
    );
  }

  const batch = await tx.batch.findUnique({ where: { id: EXPECTED_BATCH_ID } });
  if (!batch) fail(`партия ${EXPECTED_BATCH_ID} не найдена`);
  if (batch.id !== EXPECTED_BATCH_ID) fail("id партии не совпадает");
  if (lot.batchId !== batch.id) fail("пакет не принадлежит ожидаемой партии");
  if (batch.status !== "IN_WORK") fail(`status партии: expected IN_WORK, got ${batch.status}`);
  if (batch.closedAt != null) fail("партия закрыта (closedAt)");
  if (batch.frozenAt != null) fail("себестоимость партии заморожена");

  const incidentOp = await tx.productionOperation.findUnique({
    where: { id: DELETED_OPERATION_ID },
  });
  if (incidentOp) fail("удалённая операция существует — restore неоднозначен");

  const liveOps = await tx.productionOperation.count({
    where: { railLotId: RAIL_LOT_ID },
  });
  if (liveOps !== 0) fail(`на пакете есть живая операция (${liveOps})`);

  if (await deps.isCostFlowActive(tx)) {
    fail("production_cost_flow active — restore не адаптируется автоматически");
  }

  const plan: Inc001RestorePlan = {
    ready: true,
    lotId: lot.id,
    code: lot.code ?? "",
    quantity: lot.quantity,
    remainingQuantity: lot.remainingQuantity,
    targetRemaining: TARGET_REMAINING,
    batchStatus: batch.status,
    frozen: batch.frozenAt != null,
    liveOps,
    incidentOp: "ABSENT",
    costFlow: "INACTIVE",
    otherRailLotFieldsRequiringRestore: "NONE",
  };

  if (!args.execute) return plan;

  const updated = await tx.railLot.updateMany({
    where: {
      id: RAIL_LOT_ID,
      batchId: EXPECTED_BATCH_ID,
      quantity: EXPECTED_QUANTITY,
      remainingQuantity: EXPECTED_CURRENT_REMAINING,
    },
    data: { remainingQuantity: TARGET_REMAINING },
  });
  if (updated.count !== 1) {
    fail(`условный update затронул ${updated.count} строк, ожидалась 1`);
  }

  await deps.writeChangeLog(
    {
      entity: "RailLot",
      entityId: RAIL_LOT_ID,
      userId: null,
      oldValues: { remainingQuantity: EXPECTED_CURRENT_REMAINING },
      newValues: {
        incidentId: INCIDENT_ID,
        source: "cli-incident-repair",
        action: "restore_source_package_for_factual_replay",
        railLotId: RAIL_LOT_ID,
        code: EXPECTED_CODE,
        batchId: EXPECTED_BATCH_ID,
        deletedOperationId: DELETED_OPERATION_ID,
        oldRemainingQuantity: EXPECTED_CURRENT_REMAINING,
        newRemainingQuantity: TARGET_REMAINING,
        reason: INCIDENT_CHANGELOG_REASON,
      },
    },
    tx,
  );

  return plan;
}

export function describeDatabaseUrl(url: string): { host: string; port: string; database: string } {
  const parsed = new URL(url);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, "").split("/")[0] ?? "");
  return {
    host: parsed.hostname,
    port: parsed.port || (parsed.protocol === "postgresql:" ? "5432" : ""),
    database,
  };
}

export function formatInc001DryRun(plan: Inc001RestorePlan, db: { host: string; database: string }): string {
  return [
    "INC-001 RESTORE DRY RUN",
    "",
    "DATABASE:",
    `${db.host}/${db.database}`,
    "",
    "LOT:",
    `${plan.lotId}/${plan.code}`,
    "",
    "CURRENT:",
    `quantity=${plan.quantity}`,
    `remainingQuantity=${plan.remainingQuantity}`,
    "",
    "TARGET:",
    `remainingQuantity=${plan.targetRemaining}`,
    "",
    "BATCH:",
    `${plan.batchStatus} / unfrozen`,
    "",
    "LIVE OPS:",
    String(plan.liveOps),
    "",
    "INCIDENT OP:",
    plan.incidentOp,
    "",
    "COST FLOW:",
    plan.costFlow,
    "",
    "OTHER RAILLOT FIELDS REQUIRING RESTORE:",
    plan.otherRailLotFieldsRequiringRestore,
    "",
    "PLANNED BUSINESS MUTATION:",
    "RailLot.remainingQuantity 0 -> 1280",
    "",
    "PLANNED CHANGELOG:",
    "YES (userId=null, incidentId=INC-001, source=cli-incident-repair)",
    "",
    "BLANKSTOCK:",
    "NO CHANGE",
    "",
    "PRODUCTION OPERATION:",
    "NO CHANGE",
    "",
    "PAYROLL:",
    "NO CHANGE",
    "",
    "RAW SQL:",
    "NO",
    "",
    "DRY RUN MUTATIONS:",
    "0",
    "",
    "READY TO EXECUTE:",
    plan.ready ? "YES" : "NO",
  ].join("\n");
}
