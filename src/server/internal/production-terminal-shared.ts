import type { Prisma } from "@prisma/client";
import { lockEmployees } from "@/server/internal/finance-operations";
import { operationRateSnapshotWrite } from "@/lib/payroll";

function snapshotNumber(value: Prisma.Decimal | number | null): number | null {
  if (value == null) return null;
  return typeof value === "object" && "toNumber" in value ? value.toNumber() : Number(value);
}

export function snapshotFieldsForLog(s: ReturnType<typeof operationRateSnapshotWrite>) {
  return {
    hourlyRateSnapshot: snapshotNumber(s.hourlyRateSnapshot as Prisma.Decimal | number | null),
    rateTorcovkaSort1Snapshot: snapshotNumber(
      s.rateTorcovkaSort1Snapshot as Prisma.Decimal | number | null,
    ),
    rateTorcovkaSort2Snapshot: snapshotNumber(
      s.rateTorcovkaSort2Snapshot as Prisma.Decimal | number | null,
    ),
    ratePrisadkaTorcevSnapshot: snapshotNumber(
      s.ratePrisadkaTorcevSnapshot as Prisma.Decimal | number | null,
    ),
    ratePrisadkaPlosktSnapshot: snapshotNumber(
      s.ratePrisadkaPlosktSnapshot as Prisma.Decimal | number | null,
    ),
    rateUpakovkaSnapshot: snapshotNumber(s.rateUpakovkaSnapshot as Prisma.Decimal | number | null),
    rateSnapshotVersion: s.rateSnapshotVersion,
  };
}

export async function lockAndReadRateSnapshots(tx: Prisma.TransactionClient, employeeId: string) {
  await lockEmployees(tx, [employeeId]);
  const emp = await tx.employee.findUnique({ where: { id: employeeId } });
  if (!emp) throw new Error("Сотрудник не найден");
  return operationRateSnapshotWrite(emp);
}

export async function loadRetainedProductionOperation(tx: Prisma.TransactionClient, id: string) {
  return tx.productionOperation.findUniqueOrThrow({
    where: { id },
    include: { lines: true, nomenclatureLines: true },
  });
}
