import type { Prisma, PrismaClient } from "@prisma/client";
import { D } from "@/lib/cost";
import { canonicalLengthFixed4 } from "@/server/internal/blank-length";

/**
 * Повтор терминального clientRequestId с другим составом.
 * Текст не содержит сотрудника, количеств и идентификаторов сохранённой операции.
 */
export const TERMINAL_REQUEST_ALREADY_RECORDED =
  "Этот запрос уже записан. Новые данные не сохранены. Проверьте ранее внесённую операцию в журнале.";

export const UPAKOVKA_ALREADY_RECORDED =
  "Это изделие уже записано. Новая упаковка его не повторяет.";

export type ReplayPresence = "ABSENT" | "MATCH";

const SORTS = new Set<string>(["SORT1", "SORT2"]);

type ReplayDb = Prisma.TransactionClient | PrismaClient;

function rejectConflict(verdict: "MATCH" | "CONFLICT"): "MATCH" {
  if (verdict === "CONFLICT") throw new Error(TERMINAL_REQUEST_ALREADY_RECORDED);
  return "MATCH";
}

function sameCounts(left: Map<string, number>, right: Map<string, number>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, qty] of left) {
    if (right.get(key) !== qty) return false;
  }
  return true;
}

function positiveInt(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function lengthKey(value: { toString(): string } | string | number): string | null {
  try {
    return canonicalLengthFixed4(value);
  } catch {
    return null;
  }
}

export type TorcovkaReplayRequest = {
  employeeId: string;
  batchId: string;
  railLotId: string;
  railsTaken: number;
  picks: readonly { lengthM: number | string | { toString(): string }; sort: string; quantity: number }[];
};

export type TorcovkaReplayStored = {
  employeeId: string;
  type: string;
  batchId: string | null;
  railLotId: string | null;
  railsTaken: number | null;
  lines: readonly {
    quantity: number;
    blankLengthM: { toString(): string } | string | number | null;
    blankSort: string | null;
  }[];
};

/** Сравнение состава торцовки. Ставки и текущие остатки в ключ не входят. */
export function decideTorcovkaReplay(
  stored: TorcovkaReplayStored,
  requested: TorcovkaReplayRequest,
): "MATCH" | "CONFLICT" {
  if (stored.type !== "TORCOVKA") return "CONFLICT";
  if (stored.employeeId !== requested.employeeId) return "CONFLICT";
  if (!positiveInt(requested.railsTaken) || stored.railsTaken !== requested.railsTaken) {
    return "CONFLICT";
  }
  if (stored.batchId == null || stored.batchId !== requested.batchId) return "CONFLICT";
  if (stored.railLotId == null || stored.railLotId !== requested.railLotId) return "CONFLICT";

  const requestedPicks = new Map<string, number>();
  for (const pick of requested.picks) {
    if (!positiveInt(pick.quantity)) continue;
    if (!SORTS.has(pick.sort)) return "CONFLICT";
    const length = lengthKey(pick.lengthM);
    if (length == null) return "CONFLICT";
    const key = `${length}|${pick.sort}`;
    requestedPicks.set(key, (requestedPicks.get(key) ?? 0) + pick.quantity);
  }

  const storedPicks = new Map<string, number>();
  for (const line of stored.lines) {
    if (!positiveInt(line.quantity)) return "CONFLICT";
    if (line.blankLengthM == null || line.blankSort == null || !SORTS.has(line.blankSort)) {
      return "CONFLICT";
    }
    const length = lengthKey(line.blankLengthM);
    if (length == null) return "CONFLICT";
    const key = `${length}|${line.blankSort}`;
    storedPicks.set(key, (storedPicks.get(key) ?? 0) + line.quantity);
  }
  return sameCounts(storedPicks, requestedPicks) ? "MATCH" : "CONFLICT";
}

export type PrisadkaReplayRequest = {
  employeeId: string;
  picks: readonly { detailId: string; kind: "torcev" | "plosk"; quantity: number }[];
};

export type PrisadkaReplayStored = {
  employeeId: string;
  type: string;
  lines: readonly {
    detailId: string | null;
    quantity: number;
    prisadkaTorcevaya: boolean;
    prisadkaPloskost: boolean;
  }[];
};

function prisadkaKind(line: {
  prisadkaTorcevaya: boolean;
  prisadkaPloskost: boolean;
}): "torcev" | "plosk" | null {
  if (line.prisadkaTorcevaya === line.prisadkaPloskost) return null;
  return line.prisadkaTorcevaya ? "torcev" : "plosk";
}

/**
 * Сравнение присадки по детали, виду и сумме количества.
 * Несколько строк одного вида из разных источников склада складываются.
 */
export function decidePrisadkaReplay(
  stored: PrisadkaReplayStored,
  requested: PrisadkaReplayRequest,
): "MATCH" | "CONFLICT" {
  if (stored.type !== "PRISADKA") return "CONFLICT";
  if (stored.employeeId !== requested.employeeId) return "CONFLICT";

  const requestedPicks = new Map<string, number>();
  for (const pick of requested.picks) {
    if (!positiveInt(pick.quantity)) continue;
    if (pick.kind !== "torcev" && pick.kind !== "plosk") return "CONFLICT";
    if (!pick.detailId) return "CONFLICT";
    const key = `${pick.detailId}|${pick.kind}`;
    requestedPicks.set(key, (requestedPicks.get(key) ?? 0) + pick.quantity);
  }

  const storedPicks = new Map<string, number>();
  for (const line of stored.lines) {
    if (!positiveInt(line.quantity) || !line.detailId) return "CONFLICT";
    const kind = prisadkaKind(line);
    if (kind == null) return "CONFLICT";
    const key = `${line.detailId}|${kind}`;
    storedPicks.set(key, (storedPicks.get(key) ?? 0) + line.quantity);
  }
  return sameCounts(storedPicks, requestedPicks) ? "MATCH" : "CONFLICT";
}

export function upakovkaOperationRequestId(parentRequestId: string, productId: string): string {
  return `${parentRequestId}:${productId}`;
}

export type UpakovkaReplayRequest = {
  employeeId: string;
  parentRequestId: string;
  picks: readonly { productId: string; quantity: number }[];
};

export type UpakovkaReplayStored = {
  employeeId: string;
  type: string;
  productId: string | null;
  productQty: number | null;
  clientRequestId: string;
};

/** Полный набор изделий отправки, а не только пересечение с новым списком. */
export function decideUpakovkaReplay(
  stored: readonly UpakovkaReplayStored[],
  requested: UpakovkaReplayRequest,
): "MATCH" | "PARTIAL" | "CONFLICT" {
  if (stored.length === 0) return "CONFLICT";

  const requestedPicks = new Map<string, number>();
  for (const pick of requested.picks) {
    if (!positiveInt(pick.quantity)) continue;
    if (!pick.productId || requestedPicks.has(pick.productId)) return "CONFLICT";
    requestedPicks.set(pick.productId, pick.quantity);
  }
  if (requestedPicks.size === 0) return "CONFLICT";

  const prefix = `${requested.parentRequestId}:`;
  const storedPicks = new Map<string, number>();
  for (const row of stored) {
    if (row.employeeId !== requested.employeeId) return "CONFLICT";
    if (row.type !== "UPAKOVKA") return "CONFLICT";
    if (!row.clientRequestId.startsWith(prefix)) return "CONFLICT";
    const productFromKey = row.clientRequestId.slice(prefix.length);
    if (!productFromKey || productFromKey !== row.productId) return "CONFLICT";
    if (row.productQty == null || !positiveInt(row.productQty)) return "CONFLICT";
    if (storedPicks.has(row.productId)) return "CONFLICT";
    storedPicks.set(row.productId, row.productQty);
  }

  for (const [productId, quantity] of storedPicks) {
    if (requestedPicks.get(productId) !== quantity) return "CONFLICT";
  }
  if (storedPicks.size === requestedPicks.size) return "MATCH";
  return "PARTIAL";
}

export type UpakovkaReplayOutcome =
  | { status: "ABSENT" }
  | { status: "MATCH" }
  | { status: "PARTIAL"; saved: { productId: string; quantity: number }[] };

export function partialSavedUpakovka(
  stored: readonly UpakovkaReplayStored[],
): { productId: string; quantity: number }[] {
  return stored
    .filter((row): row is UpakovkaReplayStored & { productId: string; productQty: number } =>
      row.productId != null && row.productQty != null,
    )
    .map((row) => ({ productId: row.productId, quantity: row.productQty }))
    .sort((left, right) => left.productId.localeCompare(right.productId));
}

export type ConfirmedUnrecordedGuard = "OK" | "CONFLICT" | "ALREADY_RECORDED";

/** A new request may include only products the employee confirmed, never the saved ones. */
export function guardConfirmedUnrecorded(
  stored: readonly UpakovkaReplayStored[],
  requested: UpakovkaReplayRequest & { recordedRequestId: string },
): ConfirmedUnrecordedGuard {
  if (requested.parentRequestId === requested.recordedRequestId) return "CONFLICT";
  if (stored.length === 0) return "CONFLICT";
  const savedPicks: { productId: string; quantity: number }[] = [];
  const prefix = `${requested.recordedRequestId}:`;
  for (const row of stored) {
    if (row.employeeId !== requested.employeeId) return "CONFLICT";
    if (row.type !== "UPAKOVKA" || row.productId == null || row.productQty == null) return "CONFLICT";
    if (!positiveInt(row.productQty)) return "CONFLICT";
    if (!row.clientRequestId.startsWith(prefix)) return "CONFLICT";
    if (row.clientRequestId.slice(prefix.length) !== row.productId) return "CONFLICT";
    savedPicks.push({ productId: row.productId, quantity: row.productQty });
  }
  if (
    decideUpakovkaReplay(stored, {
      employeeId: requested.employeeId,
      parentRequestId: requested.recordedRequestId,
      picks: savedPicks,
    }) !== "MATCH"
  ) {
    return "CONFLICT";
  }
  const savedIds = new Set(savedPicks.map((pick) => pick.productId));
  const seen = new Set<string>();
  for (const pick of requested.picks) {
    if (!pick.productId || !positiveInt(pick.quantity) || seen.has(pick.productId)) return "CONFLICT";
    seen.add(pick.productId);
    if (savedIds.has(pick.productId)) return "ALREADY_RECORDED";
  }
  if (seen.size === 0) return "CONFLICT";
  return "OK";
}

export type RecoveryReceiptRow = {
  recordedRequestId: string;
  productId: string;
  recoveryRequestId: string;
  employeeId: string;
  quantity: number;
  operationId: string;
};

export type RecoveryDecision = "CREATE" | "EXACT" | "ALREADY_RECOVERED" | "CONFLICT";

/**
 * Whole recovery submit. A product already recovered under another request id
 * refuses the entire set, including products that are not yet recovered.
 */
export function decideRecoveryReceipts(
  receipts: readonly RecoveryReceiptRow[],
  requested: UpakovkaReplayRequest & { recordedRequestId: string; recoveryRequestId: string },
): RecoveryDecision {
  if (requested.recoveryRequestId === requested.recordedRequestId) return "CONFLICT";
  const requestedPicks = new Map<string, number>();
  for (const pick of requested.picks) {
    if (!pick.productId || !positiveInt(pick.quantity) || requestedPicks.has(pick.productId)) {
      return "CONFLICT";
    }
    requestedPicks.set(pick.productId, pick.quantity);
  }
  if (requestedPicks.size === 0) return "CONFLICT";

  const seen = new Set<string>();
  for (const row of receipts) {
    if (!row.productId || !row.operationId || !positiveInt(row.quantity)) return "CONFLICT";
    const key = `${row.recordedRequestId}\0${row.productId}`;
    if (seen.has(key)) return "CONFLICT";
    seen.add(key);
    if (row.employeeId !== requested.employeeId) return "CONFLICT";
  }

  const forRecovery = receipts.filter((row) => row.recoveryRequestId === requested.recoveryRequestId);
  if (forRecovery.some((row) => row.recordedRequestId !== requested.recordedRequestId)) {
    return "CONFLICT";
  }
  const forProducts = receipts.filter(
    (row) => row.recordedRequestId === requested.recordedRequestId && requestedPicks.has(row.productId),
  );
  if (forProducts.some((row) => row.recoveryRequestId !== requested.recoveryRequestId)) {
    return "ALREADY_RECOVERED";
  }
  if (forProducts.length === 0 && forRecovery.length === 0) return "CREATE";
  if (forRecovery.length !== requestedPicks.size || forProducts.length !== requestedPicks.size) {
    return "CONFLICT";
  }
  for (const [productId, quantity] of requestedPicks) {
    const row = forProducts.find((item) => item.productId === productId);
    if (!row || row.quantity !== quantity || row.recoveryRequestId !== requested.recoveryRequestId) {
      return "CONFLICT";
    }
  }
  return "EXACT";
}

/**
 * Dedicated two-int advisory namespace for one upakovka recoveryRequestId.
 * Distinct from SHADOW `(8322, 1)`, R-05 `8325`, and quantity-edit/purchase `8326`.
 * key2 = hashtext(recoveryRequestId); a hash collision only extra-serializes.
 */
export const UPAKOVKA_RECOVERY_REQUEST_LOCK_NAMESPACE = 8327;

export const UPAKOVKA_RECOVERY_REQUEST_LOCK_TX_REQUIRED =
  "Upakovka recovery request lock requires an open Prisma transaction client.";

export async function acquireUpakovkaRecoveryRequestLock(
  tx: Prisma.TransactionClient,
  recoveryRequestId: string,
): Promise<void> {
  if (typeof (tx as { $transaction?: unknown }).$transaction === "function") {
    throw new Error(UPAKOVKA_RECOVERY_REQUEST_LOCK_TX_REQUIRED);
  }
  await tx.$queryRaw`
    SELECT 1 AS acquired
    FROM (
      SELECT pg_advisory_xact_lock(
        ${UPAKOVKA_RECOVERY_REQUEST_LOCK_NAMESPACE}::integer,
        hashtext(${recoveryRequestId})
      )
    ) AS upakovka_recovery_request_lock
  `;
}

export async function resolveRecoveryReceipts(
  db: ReplayDb,
  requested: UpakovkaReplayRequest & { recordedRequestId: string; recoveryRequestId: string },
): Promise<RecoveryDecision> {
  const productIds = requested.picks.map((pick) => pick.productId);
  const receipts = await db.upakovkaRecoveryReceipt.findMany({
    where: {
      OR: [
        { recordedRequestId: requested.recordedRequestId, productId: { in: productIds } },
        { recoveryRequestId: requested.recoveryRequestId },
      ],
    },
    select: {
      recordedRequestId: true,
      productId: true,
      recoveryRequestId: true,
      employeeId: true,
      quantity: true,
      operationId: true,
    },
  });
  return decideRecoveryReceipts(receipts, requested);
}

export type HoursReplayRequest = {
  employeeId: string;
  hours: number;
};

export type HoursReplayStored = {
  employeeId: string;
  type: string;
  hours: { toString(): string } | string | number | null;
};

export function decideHoursReplay(
  stored: HoursReplayStored,
  requested: HoursReplayRequest,
): "MATCH" | "CONFLICT" {
  if (stored.type !== "HOURS") return "CONFLICT";
  if (stored.employeeId !== requested.employeeId) return "CONFLICT";
  if (stored.hours == null) return "CONFLICT";
  let storedHours: string;
  let requestedHours: string;
  try {
    const left = D(stored.hours.toString());
    const right = D(requested.hours);
    if (!left.isFinite() || !right.isFinite()) return "CONFLICT";
    storedHours = left.toDecimalPlaces(2).toFixed(2);
    requestedHours = right.toDecimalPlaces(2).toFixed(2);
  } catch {
    return "CONFLICT";
  }
  return storedHours === requestedHours ? "MATCH" : "CONFLICT";
}

export async function resolveTorcovkaReplay(
  db: ReplayDb,
  requested: TorcovkaReplayRequest & { clientRequestId: string },
): Promise<ReplayPresence> {
  const stored = await db.productionOperation.findUnique({
    where: { clientRequestId: requested.clientRequestId },
    select: {
      employeeId: true,
      type: true,
      batchId: true,
      railLotId: true,
      railsTaken: true,
      lines: { select: { quantity: true, blankLengthM: true, blankSort: true } },
    },
  });
  if (!stored) return "ABSENT";
  return rejectConflict(decideTorcovkaReplay(stored, requested));
}

export async function resolvePrisadkaReplay(
  db: ReplayDb,
  requested: PrisadkaReplayRequest & { clientRequestId: string },
): Promise<ReplayPresence> {
  const stored = await db.productionOperation.findUnique({
    where: { clientRequestId: requested.clientRequestId },
    select: {
      employeeId: true,
      type: true,
      lines: {
        select: {
          detailId: true,
          quantity: true,
          prisadkaTorcevaya: true,
          prisadkaPloskost: true,
        },
      },
    },
  });
  if (!stored) return "ABSENT";
  return rejectConflict(decidePrisadkaReplay(stored, requested));
}

export async function assertConfirmedUnrecorded(
  db: ReplayDb,
  requested: UpakovkaReplayRequest & { recordedRequestId: string },
): Promise<void> {
  const stored = await db.productionOperation.findMany({
    where: { clientRequestId: { startsWith: `${requested.recordedRequestId}:` } },
    select: {
      employeeId: true,
      type: true,
      productId: true,
      productQty: true,
      clientRequestId: true,
    },
  });
  const guard = guardConfirmedUnrecorded(stored, requested);
  if (guard === "ALREADY_RECORDED") throw new Error(UPAKOVKA_ALREADY_RECORDED);
  if (guard !== "OK") throw new Error(TERMINAL_REQUEST_ALREADY_RECORDED);
}

export async function resolveUpakovkaReplay(
  db: ReplayDb,
  requested: UpakovkaReplayRequest,
): Promise<UpakovkaReplayOutcome> {
  const stored = await db.productionOperation.findMany({
    where: { clientRequestId: { startsWith: `${requested.parentRequestId}:` } },
    select: {
      employeeId: true,
      type: true,
      productId: true,
      productQty: true,
      clientRequestId: true,
    },
  });
  if (stored.length === 0) return { status: "ABSENT" };
  const decision = decideUpakovkaReplay(stored, requested);
  if (decision === "CONFLICT") throw new Error(TERMINAL_REQUEST_ALREADY_RECORDED);
  if (decision === "MATCH") return { status: "MATCH" };
  return { status: "PARTIAL", saved: partialSavedUpakovka(stored) };
}

export async function resolveHoursReplay(
  db: ReplayDb,
  requested: HoursReplayRequest & { clientRequestId: string },
): Promise<ReplayPresence> {
  const stored = await db.productionOperation.findUnique({
    where: { clientRequestId: requested.clientRequestId },
    select: { employeeId: true, type: true, hours: true },
  });
  if (!stored) return "ABSENT";
  return rejectConflict(decideHoursReplay(stored, requested));
}

export function assertReplayMatched(verdict: ReplayPresence): void {
  if (verdict !== "MATCH") throw new Error(TERMINAL_REQUEST_ALREADY_RECORDED);
}

/**
 * Integrity seam only. Lets a test commit another request between
 * ensurePendingApproval and the saved-operation comparison.
 * Unset in production paths.
 */
let approvalGateAfterEnsure: (() => Promise<void>) | null = null;

export function setApprovalGateAfterEnsureForTests(hook: (() => Promise<void>) | null): void {
  approvalGateAfterEnsure = hook;
}

export async function runApprovalGateAfterEnsureForTests(): Promise<void> {
  if (process.env.NODE_ENV === "production") return;
  const hook = approvalGateAfterEnsure;
  if (!hook) return;
  await hook();
}

/**
 * Integrity seam only. Throws inside a recovery write so the whole
 * transaction, including the receipt, rolls back. Unset in production.
 */
let upakovkaRecoveryAfterWrite: (() => Promise<void>) | null = null;

export function setUpakovkaRecoveryAfterWriteForTests(hook: (() => Promise<void>) | null): void {
  upakovkaRecoveryAfterWrite = hook;
}

export async function runUpakovkaRecoveryAfterWriteForTests(): Promise<void> {
  if (process.env.NODE_ENV === "production") return;
  const hook = upakovkaRecoveryAfterWrite;
  if (!hook) return;
  await hook();
}
