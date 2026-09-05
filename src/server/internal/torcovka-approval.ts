import type { Prisma, PrismaClient, TorcovkaApproval } from "@prisma/client";
import { prisma } from "@/server/db";
import { isPrismaP2002 } from "@/lib/prisma-unique-conflict";
import {
  TORCOVKA_APPROVAL_CONSUMED_ORPHAN,
  TORCOVKA_APPROVAL_MAX_ATTEMPTS,
  TORCOVKA_APPROVAL_OWNER_MISMATCH,
  TORCOVKA_APPROVAL_TTL_MS,
  approvalHmacSecret,
  formatTorcovkaApprovalMessage,
  generateApprovalCode,
  generateUnusedApprovalCode,
  hashApprovalCode,
  torcovkaApprovalNotificationKey,
} from "@/lib/torcovka-approval";
import { notifyEvent, updateEventMessage } from "@/server/internal/notification-event";

type Db = PrismaClient | Prisma.TransactionClient;

export const TORCOVKA_APPROVAL_TITLE = "Требуется подтверждение высокого отхода";
export const TORCOVKA_APPROVAL_REDACT_USED = "Код использован.";
export const TORCOVKA_APPROVAL_REDACT_INVALIDATED =
  "Код больше не действует. Смотрите новое уведомление.";
export const TORCOVKA_APPROVAL_REDACT_NOT_REQUIRED =
  "Код больше не действует. Подтверждение больше не требуется.";

export type TorcovkaApprovalSnapshot = {
  clientRequestId: string;
  employeeId: string;
  batchId: string;
  railLotId: string;
  railsTaken: number;
  takenM: string;
  producedM: string;
  wasteM: string;
  wastePct: string;
};

export type EnsurePendingApprovalResult =
  | { kind: "PENDING"; expiresAt: Date; created: boolean }
  | { kind: "CONSUMED" };

class RetryEnsureError extends Error {
  constructor() {
    super("RETRY_ENSURE_APPROVAL");
    this.name = "RetryEnsureError";
  }
}

const ENSURE_RETRY_ATTEMPTS = 4;

export async function lockTorcovkaApprovalByClientRequestId(
  db: Db,
  clientRequestId: string,
): Promise<void> {
  await db.$queryRaw`
    SELECT id FROM "TorcovkaApproval"
    WHERE "clientRequestId" = ${clientRequestId}
    FOR UPDATE
  `;
}

/**
 * Expire an unconsumed approval after the same clientRequestId committed as
 * NORMAL/SUSPICIOUS. Caller must already hold RailLot when used from the stock
 * TX, or know a ProductionOperation already exists (no RailLot).
 * Never locks RailLot. Never rotates. Never changes employeeId.
 */
export async function invalidateTorcovkaApprovalIfNotNeeded(
  tx: Prisma.TransactionClient,
  clientRequestId: string,
  employeeId: string,
  opts?: { committedOpExists?: boolean },
): Promise<void> {
  await lockTorcovkaApprovalByClientRequestId(tx, clientRequestId);
  const existing = await tx.torcovkaApproval.findUnique({
    where: { clientRequestId },
  });
  if (!existing) return;
  if (existing.employeeId !== employeeId) {
    throw new Error(TORCOVKA_APPROVAL_OWNER_MISMATCH);
  }
  if (existing.consumedAt) {
    if (opts?.committedOpExists) return;
    throw new Error(TORCOVKA_APPROVAL_CONSUMED_ORPHAN);
  }
  const now = new Date();
  await tx.torcovkaApproval.update({
    where: { clientRequestId },
    data: { expiresAt: now },
  });
  await updateEventMessage(
    existing.notificationKey,
    TORCOVKA_APPROVAL_REDACT_NOT_REQUIRED,
    tx,
  );
}

export function approvalSnapshotDiffers(
  row: Pick<
    TorcovkaApproval,
    | "employeeId"
    | "batchId"
    | "railLotId"
    | "railsTaken"
    | "takenM"
    | "producedM"
    | "wasteM"
    | "wastePct"
  >,
  snapshot: TorcovkaApprovalSnapshot,
): boolean {
  return (
    row.employeeId !== snapshot.employeeId ||
    row.batchId !== snapshot.batchId ||
    row.railLotId !== snapshot.railLotId ||
    row.railsTaken !== snapshot.railsTaken ||
    row.takenM !== snapshot.takenM ||
    row.producedM !== snapshot.producedM ||
    row.wasteM !== snapshot.wasteM ||
    row.wastePct !== snapshot.wastePct
  );
}

export async function ensurePendingApproval(
  snapshot: TorcovkaApprovalSnapshot,
): Promise<EnsurePendingApprovalResult> {
  let last: unknown;
  for (let i = 0; i < ENSURE_RETRY_ATTEMPTS; i++) {
    try {
      return await ensurePendingApprovalOnce(snapshot);
    } catch (err) {
      last = err;
      if (!(err instanceof RetryEnsureError)) throw err;
    }
  }
  throw last;
}

async function ensurePendingApprovalOnce(
  snapshot: TorcovkaApprovalSnapshot,
): Promise<EnsurePendingApprovalResult> {
  return prisma.$transaction(async (tx) => {
    await lockTorcovkaApprovalByClientRequestId(tx, snapshot.clientRequestId);
    const existing = await tx.torcovkaApproval.findUnique({
      where: { clientRequestId: snapshot.clientRequestId },
    });

    if (!existing) {
      try {
        return await insertFirstApproval(tx, snapshot);
      } catch (err) {
        if (!isPrismaP2002(err)) throw err;
        throw new RetryEnsureError();
      }
    }

    if (existing.employeeId !== snapshot.employeeId) {
      throw new Error(TORCOVKA_APPROVAL_OWNER_MISMATCH);
    }

    if (existing.consumedAt) {
      return { kind: "CONSUMED" };
    }

    const now = new Date();
    const pending =
      existing.expiresAt > now &&
      existing.failedAttempts < TORCOVKA_APPROVAL_MAX_ATTEMPTS &&
      !approvalSnapshotDiffers(existing, snapshot);

    if (pending) {
      return { kind: "PENDING", expiresAt: existing.expiresAt, created: false };
    }

    return rotateApproval(tx, existing, snapshot, now);
  });
}

async function insertFirstApproval(
  tx: Prisma.TransactionClient,
  snapshot: TorcovkaApprovalSnapshot,
): Promise<EnsurePendingApprovalResult> {
  const now = new Date();
  const code = generateApprovalCode();
  const expiresAt = new Date(now.getTime() + TORCOVKA_APPROVAL_TTL_MS);
  const generation = 1;
  const notificationKey = torcovkaApprovalNotificationKey(snapshot.clientRequestId, generation);
  const row = await tx.torcovkaApproval.create({
    data: {
      clientRequestId: snapshot.clientRequestId,
      generation,
      employeeId: snapshot.employeeId,
      batchId: snapshot.batchId,
      railLotId: snapshot.railLotId,
      railsTaken: snapshot.railsTaken,
      takenM: snapshot.takenM,
      producedM: snapshot.producedM,
      wasteM: snapshot.wasteM,
      wastePct: snapshot.wastePct,
      codeHash: hashApprovalCode(code, approvalHmacSecret()),
      failedAttempts: 0,
      createdAt: now,
      expiresAt,
      notificationKey,
    },
  });
  await notifyApproval(tx, snapshot, notificationKey, code, row.expiresAt);
  return { kind: "PENDING", expiresAt: row.expiresAt, created: true };
}

async function rotateApproval(
  tx: Prisma.TransactionClient,
  existing: TorcovkaApproval,
  snapshot: TorcovkaApprovalSnapshot,
  now: Date,
): Promise<EnsurePendingApprovalResult> {
  const secret = approvalHmacSecret();
  const code = generateUnusedApprovalCode(existing.codeHash, secret);
  const generation = existing.generation + 1;
  const notificationKey = torcovkaApprovalNotificationKey(snapshot.clientRequestId, generation);
  await updateEventMessage(existing.notificationKey, TORCOVKA_APPROVAL_REDACT_INVALIDATED, tx);
  const updated = await tx.torcovkaApproval.update({
    where: { clientRequestId: snapshot.clientRequestId },
    data: {
      generation,
      employeeId: existing.employeeId,
      batchId: snapshot.batchId,
      railLotId: snapshot.railLotId,
      railsTaken: snapshot.railsTaken,
      takenM: snapshot.takenM,
      producedM: snapshot.producedM,
      wasteM: snapshot.wasteM,
      wastePct: snapshot.wastePct,
      codeHash: hashApprovalCode(code, secret),
      failedAttempts: 0,
      createdAt: now,
      expiresAt: new Date(now.getTime() + TORCOVKA_APPROVAL_TTL_MS),
      consumedAt: null,
      notificationKey,
    },
  });
  await notifyApproval(tx, snapshot, notificationKey, code, updated.expiresAt);
  return { kind: "PENDING", expiresAt: updated.expiresAt, created: true };
}

async function notifyApproval(
  tx: Prisma.TransactionClient,
  snapshot: TorcovkaApprovalSnapshot,
  notificationKey: string,
  code: string,
  expiresAt: Date,
): Promise<void> {
  const [employee, batch, lot] = await Promise.all([
    tx.employee.findUnique({ where: { id: snapshot.employeeId }, select: { fullName: true } }),
    tx.batch.findUnique({ where: { id: snapshot.batchId }, select: { name: true } }),
    tx.railLot.findUnique({ where: { id: snapshot.railLotId }, select: { code: true } }),
  ]);
  await notifyEvent(
    {
      key: notificationKey,
      title: TORCOVKA_APPROVAL_TITLE,
      message: formatTorcovkaApprovalMessage({
        employeeName: employee?.fullName ?? snapshot.employeeId,
        batchName: batch?.name ?? snapshot.batchId,
        lotLabel: lot?.code ?? snapshot.railLotId,
        railsTaken: snapshot.railsTaken,
        takenM: snapshot.takenM,
        producedM: snapshot.producedM,
        wasteM: snapshot.wasteM,
        wastePct: snapshot.wastePct,
        code,
        expiresAt,
      }),
      tone: "ERROR",
      href: "/production",
    },
    tx,
  );
}
