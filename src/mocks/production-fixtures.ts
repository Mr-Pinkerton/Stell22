import { dayKey } from "@/lib/entries";
import type { OperationType } from "@/types/domain";
import { batches, details, employees, products, terminalEntries } from "./fixtures";

export interface ProductionChangeLogEntry {
  id: string;
  changedAt: string;
  userName: string;
  field: string;
  oldValue: string;
  newValue: string;
}

export interface ProductionDetailLine {
  detailName: string;
  quantity: number;
  prisadkaTorcevaya?: boolean;
  prisadkaPloskost?: boolean;
}

/** Строка журнала производства для админки (расширенный снимок операции). */
export interface ProductionEntryRow {
  id: string;
  employeeId: string;
  employeeName: string;
  type: OperationType;
  workDate: string;
  createdAt: string;
  quantity: number;
  amount: number;
  unitRate: number;
  isPaid: boolean;
  batchName?: string;
  railsTaken?: number;
  railLengthM?: number;
  productName?: string;
  detailLines?: ProductionDetailLine[];
  changeLog: ProductionChangeLogEntry[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function buildProductionRows(): ProductionEntryRow[] {
  const empMap = new Map(employees.map((e) => [e.id, e.fullName]));
  const now = Date.now();

  return terminalEntries.map((e, i) => {
    const workDate = dayKey(e.occurredAt);
    const daysAgo = Math.floor((now - new Date(e.occurredAt).getTime()) / DAY_MS);
    const isPaid = daysAgo > 21;
    const batch = batches[i % batches.length]!;
    const detail = details[i % 5]!;

    const row: ProductionEntryRow = {
      id: e.id,
      employeeId: e.employeeId,
      employeeName: empMap.get(e.employeeId) ?? "—",
      type: e.type,
      workDate,
      createdAt: e.occurredAt,
      quantity: e.quantity,
      amount: e.amount,
      unitRate: e.quantity > 0 ? e.amount / e.quantity : 0,
      isPaid,
      changeLog: [],
    };

    if (e.type === "TORCOVKA") {
      row.batchName = batch.name;
      row.railsTaken = 2 + (i % 4);
      row.railLengthM = 2.4;
      row.detailLines = [{ detailName: detail.name, quantity: e.quantity }];
    } else if (e.type === "PRISADKA") {
      row.batchName = batch.name;
      row.detailLines = [
        {
          detailName: detail.name,
          quantity: e.quantity,
          prisadkaTorcevaya: true,
          prisadkaPloskost: i % 3 === 0,
        },
      ];
    } else if (e.type === "UPAKOVKA") {
      row.productName = products[i % products.length]!.name;
    }

    if (!isPaid && i % 17 === 0) {
      row.changeLog = [
        {
          id: `log-${e.id}`,
          changedAt: new Date(new Date(e.occurredAt).getTime() + 3_600_000).toISOString(),
          userName: "Админ",
          field: "Количество",
          oldValue: String(e.quantity - 5),
          newValue: String(e.quantity),
        },
      ];
    }

    return row;
  });
}

export const productionEntries: ProductionEntryRow[] = buildProductionRows();
