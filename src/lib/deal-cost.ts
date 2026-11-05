// Расчёт доставки/доп. расходов сделки и их доли в «Стоимости общей» партии.
// Чистые функции (Decimal) — тестируются отдельно, используются в server/finance.

import { Decimal } from "decimal.js";

export interface DealCashFlowLite {
  flowType: string;
  amount: Decimal.Value;
  /** Счёт операции подтверждён (не в карантине импорта выписки). */
  accountConfirmed: boolean;
  /**
   * Перевод между своими счетами. Флаг важнее статьи и сделки: историческая
   * строка с isTransfer и заполненным articleId/dealId в расход не входит.
   */
  isTransfer?: boolean;
}

/**
 * Сумма расходных операций сделки только по ПОДТВЕРЖДЁННЫМ счетам (A13).
 * Операции с авто-созданного неподтверждённого счёта (карантин импорта выписки)
 * не должны менять себестоимость партии / сумму сделки до подтверждения счёта в
 * Настройках — то же правило, что уже действует в ДДС/KPI/накладных.
 * Перевод (isTransfer) не расход, даже если на строке остались статья или сделка.
 */
export function sumConfirmedExpense(flows: DealCashFlowLite[]): Decimal {
  return flows.reduce(
    (sum, f) =>
      f.flowType === "EXPENSE" && f.accountConfirmed && f.isTransfer !== true
        ? sum.plus(new Decimal(f.amount))
        : sum,
    new Decimal(0),
  );
}

/**
 * Доставка/доп. расходы сделки = расходные операции ДДС сверх суммы
 * закупочных стоимостей привязанных партий. Не может быть отрицательной.
 */
export function dealDeliveryExtra(
  expenseTotal: Decimal.Value,
  purchaseTotal: Decimal.Value,
): Decimal {
  return Decimal.max(0, new Decimal(expenseTotal).minus(purchaseTotal));
}

/**
 * Доля доставки сделки, приходящаяся на одну партию: пропорционально её
 * закупочной стоимости; при нулевой сумме закупок — поровну между партиями.
 */
export function batchExtraShare(
  dealExtra: Decimal.Value,
  batchPurchase: Decimal.Value,
  purchaseTotal: Decimal.Value,
  batchCount: number,
): Decimal {
  const pt = new Decimal(purchaseTotal);
  const weight = pt.gt(0)
    ? new Decimal(batchPurchase).div(pt)
    : new Decimal(1).div(batchCount > 0 ? batchCount : 1);
  return new Decimal(dealExtra).times(weight);
}

/** «Стоимость общая» партии = закупочная + сумма долей доставки из её сделок. */
export function batchTotalCost(
  batchPurchase: Decimal.Value,
  totalExtra: Decimal.Value,
): Decimal {
  return new Decimal(batchPurchase).plus(totalExtra);
}
