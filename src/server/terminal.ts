"use server";

import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";
import type {
  Batch as PrismaBatch,
  Detail as PrismaDetail,
  Material as PrismaMaterial,
  Prisma,
  RailLot as PrismaRailLot,
} from "@prisma/client";
import { prisma } from "@/server/db";
import { writeChangeLog } from "@/server/change-log";
import { enqueueRecalcBatchCosts } from "@/server/cost-queue";
import {
  applyPrisadkaPicks,
  applyUpakovkaPrepared,
} from "@/server/internal/production-reversal";
import {
  buildStockSnapshot,
  type BlankStockRow,
  type DetailStockRow,
} from "@/lib/detail-stock";
import { employeeMovementActor } from "@/server/internal/inventory-movement-actor";
import { isInventoryMovementShadowWriteActiveForWriter } from "@/server/internal/inventory-movement-shadow-write";
import { planProductionShadowMovements } from "@/server/internal/production-movement-plan";
import { appendProductionShadowMovements } from "@/server/internal/production-shadow-write";
import {
  lockUpakovkaPhysicalWriteSet,
  planUpakovkaPhysicalLockSet,
} from "@/server/internal/upakovka-lock-plan";
import {
  parseApprovalCode,
  TORCOVKA_APPROVAL_CONSUMED_ORPHAN,
  TORCOVKA_APPROVAL_MAX_ATTEMPTS,
  TORCOVKA_WRONG_CODE_MESSAGE,
} from "@/lib/torcovka-approval";
import {
  type SubmitTorcovkaResult,
  type TorcovkaPlausibilityAck,
} from "@/lib/torcovka-plausibility";
import { isCostFlowActive } from "@/server/internal/cost-flow-state";
import { lockDetails, snapshotUpakovkaApply } from "@/server/internal/inventory-integrity";
import { canonicalizeTorcovkaPicks } from "@/server/internal/blank-length";
import {
  loadRetainedProductionOperation,
  lockAndReadRateSnapshots,
  snapshotFieldsForLog,
} from "@/server/internal/production-terminal-shared";
import {
  submitTorcovkaInTransaction,
  type TorcovkaTxResult,
} from "@/server/internal/submit-torcovka-tx";
import {
  ensurePendingApproval,
  invalidateTorcovkaApprovalIfNotNeeded,
  type TorcovkaApprovalSnapshot,
} from "@/server/internal/torcovka-approval";
import { requireClientRequestId } from "@/lib/request-id";
import { assertValidHours, HOURS_NO_RATE_MESSAGE, isHourlyRateUnavailable } from "@/lib/hours-input";
import { upakovkaAvailability } from "@/lib/upakovka-availability";
import { operationEarning, operationRatesFromSnapshots } from "@/lib/payroll";
import { resolvePinLookup } from "@/lib/terminal-auth";
import { RateLimiter, retryAfterSeconds } from "@/lib/rate-limit";
import {
  TERMINAL_COOKIE,
  encryptTerminalSession,
  terminalCookieOptions,
} from "@/lib/session";
import { requireTerminalEmployee } from "@/server/session";
import type {
  Detail,
  Sort,
  TerminalEntry,
} from "@/types/domain";
import type {
  TerminalBatch,
  TerminalData,
  TerminalDetail,
  TerminalIdentity,
  TerminalMaterial,
  TerminalProduct,
  TerminalRailLot,
} from "@/components/terminal/types";

function num(value: Prisma.Decimal | number | null): number | null {
  if (value == null) return null;
  return typeof value === "object" && "toNumber" in value ? value.toNumber() : Number(value);
}

/**
 * Дубль по ключу идемпотентности терминала (A21): unique-конфликт P2002 на
 * `clientRequestId`. Такой повтор одной попытки (двойной тап / сетевой retry /
 * replay того же id) считаем успешно обработанным — операция уже создана
 * первым запросом. Две вкладки обычно дают два разных id — это две попытки.
 */
function isDuplicateClientRequest(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const err = e as { code?: string; meta?: { target?: unknown } };
  if (err.code !== "P2002") return false;
  const target = err.meta?.target;
  return Array.isArray(target)
    ? target.includes("clientRequestId")
    : String(target ?? "").includes("clientRequestId");
}

function isPrismaP2025(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "P2025";
}

function logTorcovkaP2025Forensic(payload: {
  clientRequestId: string;
  employeeId: string;
  railLotId: string;
  batchId: string;
  rawPicks: unknown;
  normalizedPicks: unknown;
}): void {
  try {
    console.error(
      JSON.stringify({
        event: "torcovka_p2025",
        clientRequestId: payload.clientRequestId,
        employeeId: payload.employeeId,
        railLotId: payload.railLotId,
        batchId: payload.batchId,
        rawPicks: payload.rawPicks,
        normalizedPicks: payload.normalizedPicks,
        prismaCode: "P2025",
      }),
    );
  } catch {
    try {
      console.error(
        JSON.stringify({
          event: "torcovka_p2025",
          clientRequestId: payload.clientRequestId,
          employeeId: payload.employeeId,
          railLotId: payload.railLotId,
          batchId: payload.batchId,
          prismaCode: "P2025",
          forensicPayloadSerializationFailed: true,
        }),
      );
    } catch {
      // Forensic logging must never replace the original P2025.
    }
  }
}

// ============================ СЕРИАЛИЗАЦИЯ =================================

function serMaterial(m: PrismaMaterial): TerminalMaterial {
  return {
    id: m.id,
    name: m.name,
    sectionWidthMm: num(m.sectionWidthMm),
    sectionHeightMm: num(m.sectionHeightMm),
  };
}

function serBatch(b: PrismaBatch): TerminalBatch {
  return {
    id: b.id,
    name: b.name,
    materialId: b.materialId,
    sectionWidthMm: num(b.sectionWidthMm) ?? 0,
    sectionHeightMm: num(b.sectionHeightMm) ?? 0,
    status: b.status,
  };
}

function serLot(l: PrismaRailLot): TerminalRailLot {
  return {
    id: l.id,
    batchId: l.batchId,
    lengthM: num(l.lengthM) ?? 0,
    railType: l.railType,
    sort: l.sort,
    isPackage: l.isPackage,
    code: l.code,
    remainingQuantity: l.remainingQuantity,
  };
}

function serDetail(d: PrismaDetail): TerminalDetail {
  return {
    id: d.id,
    name: d.name,
    materialId: d.materialId,
    detailNumber: d.detailNumber,
    lengthM: num(d.lengthM) ?? 0,
    detailType: d.detailType,
    sort: d.sort,
    prisadkaTorcevaya: d.prisadkaTorcevaya,
    prisadkaPloskost: d.prisadkaPloskost,
    status: d.status,
  };
}

type ProductWithRel = Prisma.ProductGetPayload<{
  include: { details: true; fasteners: true; extras: true };
}>;

function serProduct(p: ProductWithRel): TerminalProduct {
  return {
    id: p.id,
    name: p.name,
    materialId: p.materialId,
    skuOzon: p.skuOzon,
    skuWb: p.skuWb,
    packagingId: p.packagingId,
    status: p.status,
    details: p.details.map((d) => ({
      detailId: d.detailId,
      quantity: d.quantity,
    })),
    fastenerIds: p.fasteners.map((f) => ({ nomenclatureId: f.nomenclatureId, quantity: f.quantity })),
    extraIds: p.extras.map((e) => e.nomenclatureId),
  };
}

// ============================ ЧТЕНИЕ =======================================

export async function getTerminalData(): Promise<TerminalData> {
  const sessionEmployee = await requireTerminalEmployee();
  const [
    currentEmployee,
    employees,
    materials,
    batches,
    lots,
    details,
    products,
    stockRows,
    nomStock,
    nomItems,
    blankStock,
  ] = await Promise.all([
      prisma.employee.findUnique({
        where: { id: sessionEmployee.id },
        select: { id: true, fullName: true, hourlyRate: true },
      }),
      prisma.employee.findMany({
        where: { status: "ACTIVE", birthDate: { not: null } },
        select: { id: true, fullName: true, birthDate: true },
        orderBy: { fullName: "asc" },
      }),
      prisma.material.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
      prisma.batch.findMany({ orderBy: { purchaseDate: "desc" } }),
      prisma.railLot.findMany(),
      prisma.detail.findMany(),
      prisma.product.findMany({ include: { details: true, fasteners: true, extras: true } }),
      prisma.detailStock.findMany(),
      prisma.nomenclatureStock.findMany(),
      prisma.nomenclatureItem.findMany({ select: { id: true, name: true, type: true } }),
      prisma.blankStock.findMany(),
    ]);
  if (!currentEmployee) {
    throw new Error("Сессия терминала недействительна. Войдите заново.");
  }

  const domainDetails = details.map(serDetail);

  // Склад крепежа/упаковки/разного — остаток из NomenclatureStock.
  const nomenclatureStock: Record<string, number> = {};
  for (const s of nomStock) nomenclatureStock[s.nomenclatureId] = s.quantity;

  const rows: DetailStockRow[] = stockRows.map((r) => ({
    detailId: r.detailId,
    torcevayaDone: r.torcevayaDone,
    ploskostDone: r.ploskostDone,
    quantity: r.quantity,
  }));

  const blankRows: BlankStockRow[] = blankStock.map((b) => ({
    materialId: b.materialId,
    lengthM: num(b.lengthM) ?? 0,
    detailType: b.detailType,
    sort: b.sort,
    quantity: b.quantity,
  }));

  const stock = buildStockSnapshot(
    domainDetails as Detail[],
    rows,
    blankRows,
    nomenclatureStock,
  );
  const serializedProducts = products.map(serProduct);
  const detailNames: Record<string, string> = {};
  for (const d of domainDetails) detailNames[d.id] = d.name;
  const nomNames: Record<string, { name: string; type: (typeof nomItems)[number]["type"] }> = {};
  for (const item of nomItems) nomNames[item.id] = { name: item.name, type: item.type };
  const upakovka: TerminalData["stock"]["upakovka"] = {};
  for (const p of serializedProducts) {
    upakovka[p.id] = upakovkaAvailability(
      p,
      { detailsReady: stock.detailsReady, nomenclature: stock.nomenclature },
      { details: detailNames, nomenclature: nomNames },
    );
  }
  const today = new Date();
  const birthdaysToday = employees
    .filter((employee) => {
      if (!employee.birthDate) return false;
      return (
        employee.birthDate.getMonth() === today.getMonth() &&
        employee.birthDate.getDate() === today.getDate()
      );
    })
    .map(({ id, fullName }) => ({ id, fullName }));

  return {
    currentEmployee: {
      id: currentEmployee.id,
      fullName: currentEmployee.fullName,
      hourlyRate: num(currentEmployee.hourlyRate),
    },
    birthdaysToday,
    materials: materials.map(serMaterial),
    batches: batches.map(serBatch),
    railLots: lots.map(serLot),
    details: domainDetails,
    products: serializedProducts,
    stock: {
      prisadkaPending: stock.prisadkaPending,
      detailsReady: stock.detailsReady,
      nomenclature: stock.nomenclature,
      upakovka,
    },
  };
}

// ============================ АВТОРИЗАЦИЯ (A14) =============================

// Единый текст отказа: клиент не должен различать «такого PIN нет»,
// «PIN неверный» и «в БД коллизия» — иначе терминал подсказывает подбирающему.
const PIN_REJECTED = "Неверный PIN";

// Защита от перебора 4-значного PIN. Лимиты мягче, чем у входа админа
// (auth.ts: 5 попыток / блок 15 мин): терминал — общий киоск, и длинная
// блокировка из-за чужих опечаток остановила бы работу смены. 10 попыток в
// 5 минут с блоком на минуту ограничивают перебор ~10 попыток/мин (полный
// перебор 10 000 кодов — больше 16 часов), почти не мешая живым людям.
// In-memory: корректно при одном инстансе приложения (см. DEPLOY.md).
const pinLimiter = new RateLimiter({
  maxAttempts: 10,
  windowMs: 5 * 60 * 1000,
  lockoutMs: 60 * 1000,
});

/** IP клиента из заголовков обратного прокси (как в auth.ts, fallback — общий ключ). */
async function clientKey(): Promise<string> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() || h.get("x-real-ip")?.trim();
  return ip || "unknown";
}

/**
 * Вход в терминал ТОЛЬКО по PIN: работник не выбирает себя из списка — сервер
 * сам опознаёт его по коду. Проверка целиком на сервере (PIN не покидает БД,
 * клиенту не отдаётся). При успехе ставит подписанную терминальную
 * cookie-сессию, которую проверяют все операции. Возвращает сотрудника без PIN.
 */
export type TerminalPinLoginResult =
  | { ok: true; employee: TerminalIdentity }
  | { ok: false; error: string };

export async function terminalLoginByPin(pin: string): Promise<TerminalPinLoginResult> {
  const key = await clientKey();
  const gate = pinLimiter.check(key);
  if (gate.blocked) {
    const sec = retryAfterSeconds(gate.retryAfterMs);
    return { ok: false, error: `Слишком много попыток. Повторите через ${sec} с.` };
  }

  // take: 2 — одной записи достаточно для входа, вторая доказывает коллизию.
  const candidates = await prisma.employee.findMany({
    where: { pin, status: "ACTIVE" },
    select: { id: true, pin: true, status: true },
    take: 2,
  });

  const lookup = resolvePinLookup(pin, candidates);

  if (lookup.kind === "collision") {
    // Нарушен инвариант уникальности PIN среди активных (валидация в
    // employees.ts не должна такое допускать). Не пускаем никого: угадать,
    // кто именно пришёл, нельзя. PIN в лог не пишем.
    console.error(
      `[terminal] PIN-коллизия: один PIN у нескольких активных сотрудников (${lookup.employeeIds.join(", ")}). Вход запрещён, исправьте PIN в справочнике сотрудников.`,
    );
  }

  if (lookup.kind !== "ok") {
    pinLimiter.recordFailure(key);
    return { ok: false, error: PIN_REJECTED };
  }

  const employee = await prisma.employee.findUnique({
    where: { id: lookup.employeeId },
    select: { id: true, fullName: true },
  });
  if (!employee) {
    pinLimiter.recordFailure(key);
    return { ok: false, error: PIN_REJECTED };
  }

  pinLimiter.reset(key);
  const token = await encryptTerminalSession({ employeeId: employee.id });
  (await cookies()).set(TERMINAL_COOKIE, token, terminalCookieOptions);
  return { ok: true, employee };
}

/** Выход из терминала: снимает сессию (клиентский автовыход по бездействию). */
export async function terminalLogout(): Promise<void> {
  (await cookies()).delete(TERMINAL_COOKIE);
}

// ============================ ТОРЦОВКА =====================================

export type { SubmitTorcovkaResult, TorcovkaPlausibilityAck };

export interface TorcovkaInput {
  employeeId: string;
  /** Ключ идемпотентности с клиента (A21): один на попытку операции. */
  clientRequestId: string;
  batchId: string;
  railLotId: string;
  railsTaken: number;
  /**
   * Нарезанные заготовки по длине и ФАКТИЧЕСКОМУ сорту. Тип берётся из пакета,
   * но сорт назначает работник: из пакета любого сорта могут выйти заготовки
   * и 1, и 2 сорта (см. МОДЕЛЬ СЕБЕСТОИМОСТИ — факт vs заявленное).
   */
  picks: { lengthM: number; sort: Sort; quantity: number }[];
  plausibilityAck?: TorcovkaPlausibilityAck;
  /** Worker-entered 4-digit admin code for EXTREME. Never logged. */
  approvalCode?: string;
}

function publicApprovalRequired(
  snapshot: TorcovkaApprovalSnapshot,
  expiresAt: Date,
): Extract<SubmitTorcovkaResult, { status: "APPROVAL_REQUIRED" }> {
  return {
    status: "APPROVAL_REQUIRED",
    band: "EXTREME",
    railsTaken: snapshot.railsTaken,
    takenM: snapshot.takenM,
    producedM: snapshot.producedM,
    wasteM: snapshot.wasteM,
    wastePct: snapshot.wastePct,
    expiresAt: expiresAt.toISOString(),
  };
}

async function finishApprovalGate(
  snapshot: TorcovkaApprovalSnapshot,
): Promise<SubmitTorcovkaResult> {
  const ensure = await ensurePendingApproval(snapshot);
  const opNow = await prisma.productionOperation.findUnique({
    where: { clientRequestId: snapshot.clientRequestId },
    select: { id: true },
  });
  if (opNow) {
    await prisma.$transaction(async (tx) => {
      await invalidateTorcovkaApprovalIfNotNeeded(
        tx,
        snapshot.clientRequestId,
        snapshot.employeeId,
        { committedOpExists: true },
      );
    });
    revalidatePath("/production");
    revalidatePath("/terminal");
    revalidatePath("/reports");
    revalidatePath("/", "layout");
    return { status: "CREATED" };
  }
  if (ensure.kind === "CONSUMED") {
    throw new Error(TORCOVKA_APPROVAL_CONSUMED_ORPHAN);
  }
  revalidatePath("/", "layout");
  return publicApprovalRequired(snapshot, ensure.expiresAt);
}

export async function submitTorcovka(input: TorcovkaInput): Promise<SubmitTorcovkaResult> {
  const employee = await requireTerminalEmployee(input?.employeeId);
  const actor = employeeMovementActor(employee);
  const clientRequestId = requireClientRequestId(input.clientRequestId);
  const { batchId, railLotId, railsTaken } = input;
  const employeeId = employee.id;
  const rawPicks = input.picks;
  const picks = canonicalizeTorcovkaPicks(rawPicks);
  if (!employeeId) throw new Error("Не выбран работник");
  if (!Number.isInteger(railsTaken) || railsTaken <= 0) {
    throw new Error("Укажите количество взятых реек");
  }
  if (picks.length === 0) throw new Error("Не выбраны длины заготовок");
  const code = parseApprovalCode(input.approvalCode);

  const txResult: TorcovkaTxResult = await prisma.$transaction(
    (tx) =>
      submitTorcovkaInTransaction(tx, {
        actor,
        employeeId,
        clientRequestId,
        batchId,
        railLotId,
        railsTaken,
        picks,
        plausibilityAck: input.plausibilityAck,
        code,
      }),
  ).catch((e) => {
    if (isDuplicateClientRequest(e)) return { status: "IDEMPOTENT_REPLAY" as const };
    if (isPrismaP2025(e)) {
      logTorcovkaP2025Forensic({
        clientRequestId,
        employeeId,
        railLotId,
        batchId,
        rawPicks,
        normalizedPicks: picks,
      });
    }
    throw e;
  });

  if (txResult.status === "ACK_REQUIRED") return txResult;
  if (txResult.status === "APPROVAL_NEEDED") {
    return finishApprovalGate(txResult.snapshot);
  }
  if (txResult.status === "WRONG_CODE") {
    if (txResult.failedAttempts < TORCOVKA_APPROVAL_MAX_ATTEMPTS) {
      throw new Error(TORCOVKA_WRONG_CODE_MESSAGE);
    }
    return finishApprovalGate(txResult.snapshot);
  }
  if (txResult.status === "EXPIRED" || txResult.status === "METRICS_CHANGED") {
    return finishApprovalGate(txResult.snapshot);
  }
  if (txResult.status === "CREATED_NEW") {
    await enqueueRecalcBatchCosts(batchId);
  }

  revalidatePath("/production");
  revalidatePath("/terminal");
  revalidatePath("/reports");
  revalidatePath("/", "layout");
  return { status: "CREATED" };
}

// ============================ ПРИСАДКА =====================================

export interface PrisadkaInput {
  employeeId: string;
  /** Ключ идемпотентности с клиента (A21). */
  clientRequestId: string;
  picks: { detailId: string; kind: "torcev" | "plosk"; quantity: number }[];
}

/**
 * Списывает `quantity` детали `detailId` для присадки типа `kind` и приходует
 * на результирующую комбинацию.
 * Источники (в порядке потребления):
 *  1. частично присаженные детали `DetailStock`, где `kind` ещё не выполнен
 *     (вторая присадка детали) — провенанс `source*Done`, `sourceIsBlank=false`;
 *  2. заготовки `BlankStock` спецификации детали (первая присадка: заготовка
 *     превращается в конкретную деталь) — провенанс `sourceIsBlank=true` +
 *     `blank*` спецификация для точного возврата.
 * На каждый источник — своя строка `OperationDetailLine` (для обратной разноски
 * при правке/удалении). Бросает при нехватке (нельзя в минус — cost-integrity).
 */
/* Implementation moved to server/internal/production-reversal.ts.
async function applyPrisadkaPick(
  tx: Prisma.TransactionClient,
  operationId: string,
  detailId: string,
  kind: "torcev" | "plosk",
  quantity: number,
): Promise<void> {
  const detail = await tx.detail.findUniqueOrThrow({ where: { id: detailId } });
  let left = quantity;

  // 1. Частично присаженные детали (вторая присадка).
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
    // Атомарное списание с защитой от гонки (нельзя в минус — cost-integrity).
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

  // 2. Заготовки спецификации детали (первая присадка). Материал заготовки =
  // материал детали (заготовки разных пород разделены на складе).
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
    left = 0;
  }
}
*/

/**
 * Обратная разноска одной строки ПРИСАДКИ: снимает результат (комбинация
 * после выполнения этого типа) и возвращает деталь в исходную комбинацию
 * (`sourceTorcevayaDone/PloskostDone`). Бросает, если деталь уже ушла дальше
 * (в другую присадку/упаковку) — правка/удаление в этом случае невозможны.
 */
/* Implementation moved to server/internal/production-reversal.ts.
async function movedReversePrisadkaLine(
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
  const kind: "torcev" | "plosk" = line.prisadkaTorcevaya ? "torcev" : "plosk";
  // Результирующая комбинация после этого типа присадки.
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
    // Первая присадка: возвращаем заготовку на склад заготовок.
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
*/

export async function submitPrisadka(input: PrisadkaInput): Promise<void> {
  const employee = await requireTerminalEmployee(input?.employeeId);
  const actor = employeeMovementActor(employee);
  const clientRequestId = requireClientRequestId(input.clientRequestId);
  const employeeId = employee.id;
  const picks = input.picks.filter((p) => p.quantity > 0);
  if (!employeeId) throw new Error("Не выбран работник");
  if (picks.length === 0) throw new Error("Не выбраны детали");

  await prisma
    .$transaction(async (tx) => {
      const shadowWriteActive = await isInventoryMovementShadowWriteActiveForWriter(tx);
      const existing = await tx.productionOperation.findUnique({
        where: { clientRequestId },
        select: { id: true },
      });
      if (existing) return;

      await lockDetails(
        tx,
        picks.map((p) => p.detailId),
      );
      const rateSnapshots = await lockAndReadRateSnapshots(tx, employeeId);
      const occurredAt = new Date();
      const op = await tx.productionOperation.create({
        data: {
          type: "PRISADKA",
          employeeId,
          clientRequestId,
          workDate: occurredAt,
          ...rateSnapshots,
        },
      });

      await applyPrisadkaPicks(tx, op.id, picks);

      const retained = await loadRetainedProductionOperation(tx, op.id);
      const plan = planProductionShadowMovements({ kind: "PRISADKA", operation: retained });
      await appendProductionShadowMovements(tx, {
        shadowWriteActive,
        actor,
        occurredAt,
        operationId: retained.id,
        plan,
      });

      await writeChangeLog(
        {
          entity: "ProductionOperation",
          entityId: op.id,
          newValues: { type: "PRISADKA", picks, ...snapshotFieldsForLog(rateSnapshots) },
        },
        tx,
      );
    }, { timeout: 20_000, maxWait: 20_000 })
    .catch((e) => {
      if (isDuplicateClientRequest(e)) return; // A21: повтор уже обработан
      throw e;
    });

  revalidatePath("/production");
  revalidatePath("/terminal");
}

// ============================ УПАКОВКА =====================================

export interface UpakovkaInput {
  employeeId: string;
  /** Ключ идемпотентности с клиента (A21). */
  clientRequestId: string;
  picks: { productId: string; quantity: number }[];
}

/**
 * Списывает готовые детали/крепёж/упаковку под `quantity` изделий `productId`
 * и приходует изделие. Фиксирует провенанс (какие именно комбинации
 * DetailStock и какие количества номенклатуры списаны) — состав изделия
 * может измениться позже, поэтому для обратной разноски нужен именно
 * фактически списанный набор, а не текущий состав.
 */
/* Implementation moved to server/internal/production-reversal.ts.
async function applyUpakovkaPick(
  tx: Prisma.TransactionClient,
  operationId: string,
  productId: string,
  quantity: number,
): Promise<void> {
  const product = await tx.product.findUnique({
    where: { id: productId },
    include: { details: true, fasteners: true, extras: true },
  });
  if (!product) throw new Error("Изделие не найдено");

  // Суммарная потребность по каждой детали изделия (одна деталь = одна строка
  // состава; агрегируем на случай будущих дублей — важна общая потребность).
  const neededByDetail = new Map<string, number>();
  for (const pd of product.details) {
    if (pd.quantity <= 0) continue;
    neededByDetail.set(pd.detailId, (neededByDetail.get(pd.detailId) ?? 0) + pd.quantity * quantity);
  }

  // Списываем готовые детали (все требуемые присадки выполнены). Деталь без
  // присадок годна из заготовки — списываем прямо со склада заготовок.
  for (const [detailId, needed] of neededByDetail) {
    if (needed <= 0) continue;
    const detail = await tx.detail.findUniqueOrThrow({ where: { id: detailId } });
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
    ); // бросит при нехватке готовых деталей
    for (let i = 0; i < rows.length; i++) {
      const take = takes[i];
      if (take <= 0) continue;
      // Условное списание: при гонке (остаток ушёл ниже) откат транзакции.
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

  // Списываем крепёж.
  for (const f of product.fasteners) {
    const needed = f.quantity * quantity;
    if (needed <= 0) continue;
    const dec = await tx.nomenclatureStock.updateMany({
      where: { nomenclatureId: f.nomenclatureId, quantity: { gte: needed } },
      data: { quantity: { decrement: needed } },
    });
    if (dec.count === 0) throw new Error("Недостаточно крепежа на складе");
    await tx.operationNomenclatureLine.create({
      data: { operationId, nomenclatureId: f.nomenclatureId, quantity: needed },
    });
  }

  // Списываем упаковку.
  if (product.packagingId) {
    const dec = await tx.nomenclatureStock.updateMany({
      where: { nomenclatureId: product.packagingId, quantity: { gte: quantity } },
      data: { quantity: { decrement: quantity } },
    });
    if (dec.count === 0) throw new Error("Недостаточно упаковки на складе");
    await tx.operationNomenclatureLine.create({
      data: { operationId, nomenclatureId: product.packagingId, quantity },
    });
  }

  // Списываем доп. комплектующие («Разное») — по 1 шт каждой позиции на изделие
  // (в себестоимости extra учтён как unitPrice×1, cost-report). A16: раньше
  // входили в себестоимость, но со склада не списывались → «посчитали» ≠ «есть».
  // Провенанс — та же OperationNomenclatureLine, поэтому reverse откатит их сам.
  for (const ex of product.extras) {
    const dec = await tx.nomenclatureStock.updateMany({
      where: { nomenclatureId: ex.nomenclatureId, quantity: { gte: quantity } },
      data: { quantity: { decrement: quantity } },
    });
    if (dec.count === 0) throw new Error("Недостаточно доп. комплектующих на складе");
    await tx.operationNomenclatureLine.create({
      data: { operationId, nomenclatureId: ex.nomenclatureId, quantity },
    });
  }

  // Приход готовой продукции.
  await tx.productStock.upsert({
    where: { productId },
    create: { productId, quantity },
    update: { quantity: { increment: quantity } },
  });
}
*/

/**
 * Обратная разноска операции УПАКОВКИ: возвращает детали в исходные комбинации
 * DetailStock, крепёж/упаковку — в NomenclatureStock, снимает изделие с
 * ProductStock. Бросает, если изделие уже отгружено/продано (остаток < qty).
 */
/* Implementation moved to server/internal/production-reversal.ts.
async function movedReverseUpakovkaOperation(
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
): Promise<void> {
  const dec = await tx.productStock.updateMany({
    where: { productId, quantity: { gte: productQty } },
    data: { quantity: { decrement: productQty } },
  });
  if (dec.count === 0) {
    throw new Error("Нельзя изменить/удалить: изделие уже отгружено/продано");
  }

  for (const l of detailLines) {
    if (l.sourceIsBlank) {
      // Беcприсадочная деталь — возврат на склад заготовок.
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
*/

export async function submitUpakovka(input: UpakovkaInput): Promise<void> {
  const employee = await requireTerminalEmployee(input?.employeeId);
  const actor = employeeMovementActor(employee);
  const clientRequestId = requireClientRequestId(input.clientRequestId);
  const employeeId = employee.id;
  const picks = input.picks.filter((p) => p.quantity > 0);
  if (!employeeId) throw new Error("Не выбран работник");
  if (picks.length === 0) throw new Error("Не выбраны изделия");
  const productIds = picks.map((p) => p.productId);
  if (new Set(productIds).size !== productIds.length) {
    throw new Error("В списке упаковки изделие указано дважды");
  }

  await prisma
    .$transaction(async (tx) => {
      const shadowWriteActive = await isInventoryMovementShadowWriteActiveForWriter(tx);
      const expectedIds = picks.map((p) => `${clientRequestId}:${p.productId}`);
      const existing = await tx.productionOperation.findMany({
        where: { clientRequestId: { in: expectedIds } },
        select: { clientRequestId: true },
      });
      const found = new Set(existing.map((row) => row.clientRequestId));
      const missing = expectedIds.filter((id) => !found.has(id));
      if (missing.length === 0) return;
      if (found.size > 0) {
        throw new Error("Несогласованный повтор упаковки");
      }

      const preparedRows = [];
      for (const pick of picks) {
        preparedRows.push({
          pick,
          prepared: await snapshotUpakovkaApply(tx, pick.productId),
        });
      }
      const costFlowActive = await isCostFlowActive(tx);
      await lockUpakovkaPhysicalWriteSet(tx, planUpakovkaPhysicalLockSet(preparedRows), {
        costFlowActive,
      });
      const rateSnapshots = await lockAndReadRateSnapshots(tx, employeeId);
      for (const { pick, prepared } of preparedRows) {
        const occurredAt = new Date();
        const op = await tx.productionOperation.create({
          data: {
            type: "UPAKOVKA",
            employeeId,
            clientRequestId: `${clientRequestId}:${pick.productId}`,
            workDate: occurredAt,
            productId: pick.productId,
            productQty: pick.quantity,
            ...rateSnapshots,
          },
        });
        await applyUpakovkaPrepared(tx, op.id, pick.quantity, prepared, { costFlowActive });
        const retained = await loadRetainedProductionOperation(tx, op.id);
        const plan = planProductionShadowMovements({ kind: "UPAKOVKA", operation: retained });
        await appendProductionShadowMovements(tx, {
          shadowWriteActive,
          actor,
          occurredAt,
          operationId: retained.id,
          plan,
        });
        await writeChangeLog(
          {
            entity: "ProductionOperation",
            entityId: op.id,
            newValues: {
              type: "UPAKOVKA",
              productId: pick.productId,
              quantity: pick.quantity,
              ...snapshotFieldsForLog(rateSnapshots),
            },
          },
          tx,
        );
      }
    }, { timeout: 20_000, maxWait: 20_000 })
    .catch((e) => {
      if (isDuplicateClientRequest(e)) return; // A21: повтор уже обработан
      throw e;
    });

  revalidatePath("/production");
  revalidatePath("/terminal");
}

// ============================ РАБОЧИЕ ЧАСЫ =================================

export async function submitHours(
  employeeId: string,
  hours: number,
  clientRequestId: string,
): Promise<void> {
  await requireTerminalEmployee(employeeId || undefined);
  const requestId = requireClientRequestId(clientRequestId);
  if (!employeeId) throw new Error("Не выбран работник");
  assertValidHours(hours);

  try {
    await prisma.$transaction(async (tx) => {
      const existing = await tx.productionOperation.findUnique({
        where: { clientRequestId: requestId },
        select: { id: true },
      });
      if (existing) return;
      const rateSnapshots = await lockAndReadRateSnapshots(tx, employeeId);
      if (isHourlyRateUnavailable(rateSnapshots.hourlyRateSnapshot)) {
        throw new Error(HOURS_NO_RATE_MESSAGE);
      }
      const created = await tx.productionOperation.create({
        data: {
          type: "HOURS",
          employeeId,
          clientRequestId: requestId,
          hours,
          workDate: new Date(),
          ...rateSnapshots,
        },
      });
      await writeChangeLog(
        {
          entity: "ProductionOperation",
          entityId: created.id,
          newValues: { type: "HOURS", hours, ...snapshotFieldsForLog(rateSnapshots) },
        },
        tx,
      );
    });
  } catch (e) {
    if (isDuplicateClientRequest(e)) return; // A21: повтор уже обработан
    throw e;
  }

  revalidatePath("/production");
  revalidatePath("/terminal");
}

// ============================ ЖУРНАЛ РАБОТНИКА =============================

type OpWithLines = Prisma.ProductionOperationGetPayload<{ include: { lines: true } }>;

function entryFromOperation(op: OpWithLines): TerminalEntry {
  const { quantity, amount } = operationEarning({
    type: op.type,
    rates: operationRatesFromSnapshots(op),
    hours: num(op.hours),
    productQty: op.productQty ?? 0,
    lines: op.lines.map((l) => ({
      quantity: l.quantity,
      sort: l.blankSort ?? undefined,
      prisadkaTorcevaya: l.prisadkaTorcevaya,
      prisadkaPloskost: l.prisadkaPloskost,
    })),
  });

  return {
    id: op.id,
    employeeId: op.employeeId,
    type: op.type,
    occurredAt: op.createdAt.toISOString(),
    quantity,
    amount,
  };
}

export async function getEmployeeEntries(employeeId: string): Promise<TerminalEntry[]> {
  await requireTerminalEmployee(employeeId); // A14: только свой журнал по своей сессии
  const [emp, ops] = await Promise.all([
    prisma.employee.findUnique({ where: { id: employeeId } }),
    prisma.productionOperation.findMany({
      where: { employeeId },
      include: { lines: true },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  if (!emp) return [];

  return ops.map((op) => entryFromOperation(op));
}
