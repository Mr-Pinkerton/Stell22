"use server";

import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";
import type {
  Batch as PrismaBatch,
  Detail as PrismaDetail,
  Employee as PrismaEmployee,
  Material as PrismaMaterial,
  Prisma,
  RailLot as PrismaRailLot,
} from "@prisma/client";
import { prisma } from "@/server/db";
import { writeChangeLog } from "@/server/change-log";
import { enqueueRecalcBatchCosts } from "@/server/cost-queue";
import { archiveBatchIfDepleted } from "@/server/internal/cost";
import {
  applyPrisadkaPick,
  applyUpakovkaPick,
} from "@/server/internal/production-reversal";
import {
  buildStockSnapshot,
  type BlankStockRow,
  type DetailStockRow,
} from "@/lib/detail-stock";
import { D } from "@/lib/cost";
import { lockRailLots } from "@/server/internal/finance-operations";
import { blankSpecSortKey, lockDetails } from "@/server/internal/inventory-integrity";
import {
  approvalCodeMatches,
  approvalHmacSecret,
  parseApprovalCode,
  TORCOVKA_APPROVAL_CONSUMED_ORPHAN,
  TORCOVKA_APPROVAL_MAX_ATTEMPTS,
  TORCOVKA_WRONG_CODE_MESSAGE,
} from "@/lib/torcovka-approval";
import {
  computeTorcovkaWasteMetrics,
  decideTorcovkaSubmit,
  type SubmitTorcovkaResult,
  type TorcovkaPlausibilityAck,
} from "@/lib/torcovka-plausibility";
import { updateEventMessage } from "@/server/internal/notification-event";
import {
  approvalSnapshotDiffers,
  ensurePendingApproval,
  invalidateTorcovkaApprovalIfNotNeeded,
  lockTorcovkaApprovalByClientRequestId,
  TORCOVKA_APPROVAL_REDACT_USED,
  type TorcovkaApprovalSnapshot,
} from "@/server/internal/torcovka-approval";
import { requireClientRequestId } from "@/lib/request-id";
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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
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
    products: products.map(serProduct),
    stock: {
      prisadkaPending: stock.prisadkaPending,
      detailsReady: stock.detailsReady,
      nomenclature: stock.nomenclature,
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
export async function terminalLoginByPin(pin: string): Promise<TerminalIdentity> {
  const key = await clientKey();
  const gate = pinLimiter.check(key);
  if (gate.blocked) {
    const sec = retryAfterSeconds(gate.retryAfterMs);
    throw new Error(`Слишком много попыток. Повторите через ${sec} с.`);
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
    throw new Error(PIN_REJECTED);
  }

  const employee = await prisma.employee.findUnique({
    where: { id: lookup.employeeId },
    select: { id: true, fullName: true },
  });
  if (!employee) {
    pinLimiter.recordFailure(key);
    throw new Error(PIN_REJECTED);
  }

  pinLimiter.reset(key);
  const token = await encryptTerminalSession({ employeeId: employee.id });
  (await cookies()).set(TERMINAL_COOKIE, token, terminalCookieOptions);
  return employee;
}

/** Выход из терминала: снимает сессию (клиентский автовыход по бездействию). */
export async function terminalLogout(): Promise<void> {
  (await cookies()).delete(TERMINAL_COOKIE);
}

// ============================ ТОРЦОВКА =====================================

export type { SubmitTorcovkaResult, TorcovkaPlausibilityAck };

type TorcovkaTxResult =
  | { status: "CREATED_NEW" }
  | { status: "IDEMPOTENT_REPLAY" }
  | {
      status: "ACK_REQUIRED";
      band: "SUSPICIOUS";
      railsTaken: number;
      takenM: string;
      producedM: string;
      wastePct: string;
    }
  | { status: "APPROVAL_NEEDED"; snapshot: TorcovkaApprovalSnapshot }
  | { status: "WRONG_CODE"; failedAttempts: number; snapshot: TorcovkaApprovalSnapshot }
  | { status: "EXPIRED"; snapshot: TorcovkaApprovalSnapshot }
  | { status: "METRICS_CHANGED"; snapshot: TorcovkaApprovalSnapshot };

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

function approvalSnapshotFromMetrics(
  clientRequestId: string,
  employeeId: string,
  batchId: string,
  railLotId: string,
  railsTaken: number,
  metrics: ReturnType<typeof computeTorcovkaWasteMetrics>,
): TorcovkaApprovalSnapshot {
  return {
    clientRequestId,
    employeeId,
    batchId,
    railLotId,
    railsTaken,
    takenM: metrics.canon.takenM,
    producedM: metrics.canon.producedM,
    wasteM: metrics.canon.wasteM,
    wastePct: metrics.canon.wastePct,
  };
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
  await requireTerminalEmployee(input?.employeeId);
  const clientRequestId = requireClientRequestId(input.clientRequestId);
  const { employeeId, batchId, railLotId, railsTaken } = input;
  const picks = input.picks.filter((p) => p.quantity > 0);
  if (!employeeId) throw new Error("Не выбран работник");
  if (!Number.isInteger(railsTaken) || railsTaken <= 0) {
    throw new Error("Укажите количество взятых реек");
  }
  if (picks.length === 0) throw new Error("Не выбраны длины заготовок");
  const code = parseApprovalCode(input.approvalCode);

  const txResult: TorcovkaTxResult = await prisma.$transaction(async (tx): Promise<TorcovkaTxResult> => {
    const existingBeforeLock = await tx.productionOperation.findUnique({
      where: { clientRequestId },
      select: { id: true, employeeId: true },
    });
    if (existingBeforeLock) {
      await invalidateTorcovkaApprovalIfNotNeeded(tx, clientRequestId, existingBeforeLock.employeeId, {
        committedOpExists: true,
      });
      return { status: "IDEMPOTENT_REPLAY" as const };
    }

    await lockRailLots(tx, [railLotId]);
    const existingAfterLock = await tx.productionOperation.findUnique({
      where: { clientRequestId },
      select: { id: true, employeeId: true },
    });
    if (existingAfterLock) {
      await invalidateTorcovkaApprovalIfNotNeeded(tx, clientRequestId, existingAfterLock.employeeId, {
        committedOpExists: true,
      });
      return { status: "IDEMPOTENT_REPLAY" as const };
    }
    const lot = await tx.railLot.findUnique({ where: { id: railLotId } });
    if (!lot || lot.batchId !== batchId) throw new Error("Пакет реек не найден");
    const batch = await tx.batch.findUniqueOrThrow({ where: { id: batchId } });
    const materialId = batch.materialId;

    for (const p of picks) {
      if (D(p.lengthM).gt(D(lot.lengthM))) {
        throw new Error("Длина заготовки превышает длину рейки пакета");
      }
    }

    const metrics = computeTorcovkaWasteMetrics(railsTaken, lot.lengthM, picks);
    if (metrics.producedM.gt(metrics.takenM)) {
      throw new Error("Суммарная длина заготовок превышает длину взятых реек");
    }

    const snapshot = approvalSnapshotFromMetrics(
      clientRequestId,
      employeeId,
      batchId,
      railLotId,
      railsTaken,
      metrics,
    );

    const decision = decideTorcovkaSubmit({
      railsTaken,
      metrics,
      ack: input.plausibilityAck,
    });

    if (decision.status === "ACK_REQUIRED" && decision.band === "SUSPICIOUS") {
      return {
        status: "ACK_REQUIRED" as const,
        band: "SUSPICIOUS" as const,
        railsTaken: decision.railsTaken,
        takenM: decision.takenM,
        producedM: decision.producedM,
        wastePct: decision.wastePct,
      };
    }

    let persist = decision.status === "CREATED" ? decision.persist : null;
    let approvalMeta: {
      approvalId: string;
      generation: number;
      consumedAt: Date;
    } | null = null;

    if (decision.status === "ACK_REQUIRED" && decision.band === "EXTREME") {
      if (code === null) {
        return { status: "APPROVAL_NEEDED" as const, snapshot };
      }

      await lockTorcovkaApprovalByClientRequestId(tx, clientRequestId);
      const approval = await tx.torcovkaApproval.findUnique({
        where: { clientRequestId },
      });
      if (!approval) {
        return { status: "EXPIRED" as const, snapshot };
      }
      if (approval.consumedAt) {
        throw new Error(TORCOVKA_APPROVAL_CONSUMED_ORPHAN);
      }
      if (approval.employeeId !== employeeId) {
        throw new Error(TORCOVKA_WRONG_CODE_MESSAGE);
      }
      const now = new Date();
      if (approval.expiresAt <= now) {
        return { status: "EXPIRED" as const, snapshot };
      }
      if (approval.failedAttempts >= TORCOVKA_APPROVAL_MAX_ATTEMPTS) {
        return { status: "EXPIRED" as const, snapshot };
      }
      if (approvalSnapshotDiffers(approval, snapshot)) {
        return { status: "METRICS_CHANGED" as const, snapshot };
      }
      if (!approvalCodeMatches(code, approval.codeHash, approvalHmacSecret())) {
        const updated = await tx.torcovkaApproval.update({
          where: { clientRequestId },
          data: { failedAttempts: { increment: 1 } },
        });
        return {
          status: "WRONG_CODE" as const,
          failedAttempts: updated.failedAttempts,
          snapshot,
        };
      }

      const verified = decideTorcovkaSubmit({
        railsTaken,
        metrics,
        approvalVerified: true,
      });
      if (verified.status !== "CREATED") {
        throw new Error("Не удалось подтвердить высокий отход");
      }
      persist = verified.persist;
      const consumedAt = now;
      await tx.torcovkaApproval.update({
        where: { clientRequestId },
        data: { consumedAt },
      });
      await updateEventMessage(approval.notificationKey, TORCOVKA_APPROVAL_REDACT_USED, tx);
      approvalMeta = {
        approvalId: approval.id,
        generation: approval.generation,
        consumedAt,
      };
    }

    if (!persist) {
      throw new Error("Неверный тип подтверждения отхода");
    }

    if (!approvalMeta) {
      await invalidateTorcovkaApprovalIfNotNeeded(tx, clientRequestId, employeeId);
    }

    const dec = await tx.railLot.updateMany({
      where: { id: railLotId, batchId, remainingQuantity: { gte: railsTaken } },
      data: { remainingQuantity: { decrement: railsTaken } },
    });
    if (dec.count === 0) throw new Error("Недостаточно реек в пакете");

    const op = await tx.productionOperation.create({
      data: {
        type: "TORCOVKA",
        employeeId,
        clientRequestId,
        batchId,
        railLotId,
        railsTaken,
        torcovkaSubmitAckBand: persist.torcovkaSubmitAckBand,
        torcovkaSubmitWasteReason: persist.torcovkaSubmitWasteReason,
        torcovkaSubmitWasteNote: persist.torcovkaSubmitWasteNote,
        workDate: new Date(),
        lines: {
          create: picks.map((p) => ({
            quantity: p.quantity,
            blankLengthM: p.lengthM,
            blankType: lot.railType,
            blankSort: p.sort,
            blankMaterialId: materialId,
          })),
        },
      },
    });

    const sortedBlankPicks = [...picks].sort((a, b) =>
      blankSpecSortKey({
        materialId,
        lengthM: a.lengthM,
        detailType: lot.railType,
        sort: a.sort,
      }).localeCompare(
        blankSpecSortKey({
          materialId,
          lengthM: b.lengthM,
          detailType: lot.railType,
          sort: b.sort,
        }),
      ),
    );
    for (const p of sortedBlankPicks) {
      await tx.blankStock.upsert({
        where: {
          materialId_lengthM_detailType_sort: {
            materialId,
            lengthM: p.lengthM,
            detailType: lot.railType,
            sort: p.sort,
          },
        },
        create: {
          materialId,
          lengthM: p.lengthM,
          detailType: lot.railType,
          sort: p.sort,
          quantity: p.quantity,
        },
        update: { quantity: { increment: p.quantity } },
      });
    }

    const changeLogValues: Record<string, unknown> = {
      type: "TORCOVKA",
      batchId,
      railLotId,
      railsTaken,
      picks,
    };
    if (approvalMeta) {
      changeLogValues.approvalRequired = true;
      changeLogValues.approvalId = approvalMeta.approvalId;
      changeLogValues.generation = approvalMeta.generation;
      changeLogValues.consumedAt = approvalMeta.consumedAt.toISOString();
      changeLogValues.takenM = snapshot.takenM;
      changeLogValues.producedM = snapshot.producedM;
      changeLogValues.wasteM = snapshot.wasteM;
      changeLogValues.wastePct = snapshot.wastePct;
    }

    await writeChangeLog(
      {
        entity: "ProductionOperation",
        entityId: op.id,
        newValues: changeLogValues,
      },
      tx,
    );

    if (!approvalMeta) {
      await invalidateTorcovkaApprovalIfNotNeeded(tx, clientRequestId, employeeId);
    }

    await archiveBatchIfDepleted(tx, batchId);
    return { status: "CREATED_NEW" as const };
  }).catch((e) => {
    if (isDuplicateClientRequest(e)) return { status: "IDEMPOTENT_REPLAY" as const };
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
  await requireTerminalEmployee(input?.employeeId);
  const clientRequestId = requireClientRequestId(input.clientRequestId);
  const { employeeId } = input;
  const picks = input.picks.filter((p) => p.quantity > 0);
  if (!employeeId) throw new Error("Не выбран работник");
  if (picks.length === 0) throw new Error("Не выбраны детали");

  await prisma
    .$transaction(async (tx) => {
      await lockDetails(
        tx,
        picks.map((p) => p.detailId),
      );
      const op = await tx.productionOperation.create({
        data: {
          type: "PRISADKA",
          employeeId,
          clientRequestId,
          workDate: new Date(),
        },
      });

      for (const pick of picks) {
        await applyPrisadkaPick(tx, op.id, pick.detailId, pick.kind, pick.quantity);
      }

      await writeChangeLog(
        { entity: "ProductionOperation", entityId: op.id, newValues: { type: "PRISADKA", picks } },
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
  await requireTerminalEmployee(input?.employeeId);
  const clientRequestId = requireClientRequestId(input.clientRequestId);
  const { employeeId } = input;
  const picks = input.picks.filter((p) => p.quantity > 0);
  if (!employeeId) throw new Error("Не выбран работник");
  if (picks.length === 0) throw new Error("Не выбраны изделия");
  const productIds = picks.map((p) => p.productId);
  if (new Set(productIds).size !== productIds.length) {
    throw new Error("В списке упаковки изделие указано дважды");
  }

  await prisma
    .$transaction(async (tx) => {
      for (const pick of picks) {
        const op = await tx.productionOperation.create({
          data: {
            type: "UPAKOVKA",
            employeeId,
            // Одна операция на изделие → ключ на попытку уточняем изделием (A21).
            clientRequestId: `${clientRequestId}:${pick.productId}`,
            workDate: new Date(),
            productId: pick.productId,
            productQty: pick.quantity,
          },
        });
        await applyUpakovkaPick(tx, op.id, pick.productId, pick.quantity);
        await writeChangeLog(
          {
            entity: "ProductionOperation",
            entityId: op.id,
            newValues: { type: "UPAKOVKA", productId: pick.productId, quantity: pick.quantity },
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
  if (!(hours > 0)) throw new Error("Укажите количество часов");

  let op: { id: string } | null = null;
  try {
    op = await prisma.productionOperation.create({
      data: { type: "HOURS", employeeId, clientRequestId: requestId, hours, workDate: new Date() },
    });
  } catch (e) {
    if (isDuplicateClientRequest(e)) return; // A21: повтор уже обработан
    throw e;
  }
  await writeChangeLog({
    entity: "ProductionOperation",
    entityId: op.id,
    newValues: { type: "HOURS", hours },
  });

  revalidatePath("/production");
  revalidatePath("/terminal");
}

// ============================ ЖУРНАЛ РАБОТНИКА =============================

type OpWithLines = Prisma.ProductionOperationGetPayload<{ include: { lines: true } }>;

function entryFromOperation(op: OpWithLines, emp: PrismaEmployee): TerminalEntry {
  let quantity = 0;
  let amount = 0;

  if (op.type === "HOURS") {
    quantity = num(op.hours) ?? 0;
    amount = quantity * (num(emp.hourlyRate) ?? 0);
  } else if (op.type === "UPAKOVKA") {
    quantity = op.productQty ?? 0;
    amount = quantity * (num(emp.rateUpakovka) ?? 0);
  } else if (op.type === "TORCOVKA") {
    // ЗП торцовки — по сорту произведённой заготовки.
    const r1 = num(emp.rateTorcovkaSort1) ?? 0;
    const r2 = num(emp.rateTorcovkaSort2) ?? 0;
    for (const l of op.lines) {
      quantity += l.quantity;
      amount += l.quantity * (l.blankSort === "SORT2" ? r2 : r1);
    }
  } else {
    // PRISADKA
    const rt = num(emp.ratePrisadkaTorcev) ?? 0;
    const rp = num(emp.ratePrisadkaPloskt) ?? 0;
    for (const l of op.lines) {
      quantity += l.quantity;
      amount += l.quantity * ((l.prisadkaTorcevaya ? rt : 0) + (l.prisadkaPloskost ? rp : 0));
    }
  }

  return {
    id: op.id,
    employeeId: op.employeeId,
    type: op.type,
    occurredAt: op.createdAt.toISOString(),
    quantity,
    amount: round2(amount),
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

  return ops.map((op) => entryFromOperation(op, emp));
}
