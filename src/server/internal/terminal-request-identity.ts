import type { Prisma, PrismaClient } from "@prisma/client";
import { D } from "@/lib/cost";
import { canonicalLengthFixed4 } from "@/server/internal/blank-length";

/**
 * Повтор терминального clientRequestId с другим составом.
 * Текст не содержит сотрудника, количеств и идентификаторов сохранённой операции.
 */
export const TERMINAL_REQUEST_ALREADY_RECORDED =
  "Этот запрос уже записан. Новые данные не сохранены. Проверьте ранее внесённую операцию в журнале.";

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
): "MATCH" | "CONFLICT" {
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
    if (row.type !== "UPAKOVKA" || row.employeeId !== requested.employeeId) return "CONFLICT";
    if (!row.clientRequestId.startsWith(prefix)) return "CONFLICT";
    const productFromKey = row.clientRequestId.slice(prefix.length);
    if (!productFromKey || productFromKey !== row.productId) return "CONFLICT";
    if (row.productQty == null || !positiveInt(row.productQty)) return "CONFLICT";
    if (storedPicks.has(row.productId)) return "CONFLICT";
    storedPicks.set(row.productId, row.productQty);
  }
  return sameCounts(storedPicks, requestedPicks) ? "MATCH" : "CONFLICT";
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

export async function resolveUpakovkaReplay(
  db: ReplayDb,
  requested: UpakovkaReplayRequest,
): Promise<ReplayPresence> {
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
  if (stored.length === 0) return "ABSENT";
  return rejectConflict(decideUpakovkaReplay(stored, requested));
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
