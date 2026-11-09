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

export interface DealExtraParticipant {
  id: string;
  purchaseCost: Decimal.Value;
  frozen: boolean;
}

/**
 * Доли доплаты в копейках. Все записываемые партии получают остаток на
 * последнюю в порядке id. Замороженная партия не переписывается и не
 * отдаёт свою уже сохранённую долю другой партии: для смешанного состава
 * записываемая доля округляется отдельно.
 */
export function allocateWritableDealExtras(
  dealExtra: Decimal.Value,
  batches: readonly DealExtraParticipant[],
): { id: string; extra: Decimal }[] {
  const ordered = [...batches].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const extra = new Decimal(dealExtra).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const purchaseTotal = ordered.reduce(
    (sum, batch) => sum.plus(batch.purchaseCost),
    new Decimal(0),
  );
  const count = ordered.length;
  if (ordered.some((batch) => batch.frozen)) {
    return ordered
      .filter((batch) => !batch.frozen)
      .map((batch) => ({
        id: batch.id,
        extra: batchExtraShare(extra, batch.purchaseCost, purchaseTotal, count).toDecimalPlaces(
          2,
          Decimal.ROUND_HALF_UP,
        ),
      }));
  }

  const shares: { id: string; extra: Decimal }[] = [];
  let allocated = new Decimal(0);
  for (let i = 0; i < ordered.length; i += 1) {
    const batch = ordered[i];
    if (i === ordered.length - 1) {
      const last = extra.minus(allocated);
      if (last.isNeg()) throw new Error("deal extra allocation residual is negative");
      shares.push({ id: batch.id, extra: last });
      break;
    }
    const weight = purchaseTotal.gt(0)
      ? new Decimal(batch.purchaseCost).div(purchaseTotal)
      : new Decimal(1).div(count);
    const share = extra.times(weight).toDecimalPlaces(2, Decimal.ROUND_DOWN);
    shares.push({ id: batch.id, extra: share });
    allocated = allocated.plus(share);
  }
  return shares;
}

/** «Стоимость общая» партии = закупочная + сумма долей доставки из её сделок. */
export function batchTotalCost(
  batchPurchase: Decimal.Value,
  totalExtra: Decimal.Value,
): Decimal {
  return new Decimal(batchPurchase).plus(totalExtra);
}
