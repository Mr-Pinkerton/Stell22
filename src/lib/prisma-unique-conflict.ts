/**
 * Discriminators for Prisma P2002 unique conflicts.
 * Partial unique indexes may expose meta.target as fields, index name, or omit it —
 * match against the measured discriminator string, not a single assumed shape.
 */

const ACCOUNT_NUMBER_TAKEN = "Счёт с таким номером уже существует";
const ACCOUNT_NUMBER_BIND_TAKEN =
  "Нельзя привязать выписку: номер счёта уже занят другим счётом";

export function isPrismaP2002(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  return (err as { code?: string }).code === "P2002";
}

export function prismaUniqueDiscriminator(err: unknown): string {
  if (typeof err !== "object" || err === null) return "";
  const e = err as {
    message?: string;
    meta?: { target?: unknown; constraint?: unknown; modelName?: unknown };
  };
  const meta = e.meta ?? {};
  const parts: string[] = [];
  if (meta.target != null) {
    parts.push(Array.isArray(meta.target) ? meta.target.map(String).join(",") : String(meta.target));
  }
  if (meta.constraint != null) parts.push(String(meta.constraint));
  if (meta.modelName != null) parts.push(String(meta.modelName));
  if (e.message) parts.push(e.message);
  return parts.join(" ");
}

export function isDuplicateAccountNumber(err: unknown): boolean {
  if (!isPrismaP2002(err)) return false;
  const d = prismaUniqueDiscriminator(err);
  return /accountNumber|Account_accountNumber_key/i.test(d);
}

export function isDuplicateImportKey(err: unknown): boolean {
  if (!isPrismaP2002(err)) return false;
  const d = prismaUniqueDiscriminator(err);
  return /importKey|CashFlow_accountId_importKey_key/i.test(d);
}

/** Account.accountNumber or CashFlow importKey unique — retry whole import once. */
export function isRetryableStatementImportConflict(err: unknown): boolean {
  return isDuplicateAccountNumber(err) || isDuplicateImportKey(err);
}

export function throwFriendlyAccountNumberConflict(err: unknown): never | void {
  if (isDuplicateAccountNumber(err)) {
    throw new Error(ACCOUNT_NUMBER_TAKEN);
  }
}

export function throwFriendlyAccountNumberBindConflict(err: unknown): never | void {
  if (isDuplicateAccountNumber(err)) {
    throw new Error(ACCOUNT_NUMBER_BIND_TAKEN);
  }
}

export async function retryOnceOnImportUnique<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (isRetryableStatementImportConflict(err)) {
      return await run();
    }
    throw err;
  }
}

export { ACCOUNT_NUMBER_TAKEN, ACCOUNT_NUMBER_BIND_TAKEN };
