/** Самая поздняя фактически сохранённая дата операции. Пустой список — null. */
export function latestRecordedCashFlowDate(dates: readonly string[]): string | null {
  let latest: string | null = null;
  for (const date of dates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (latest == null || date > latest) latest = date;
  }
  return latest;
}
