export const INVENTORY_MOVEMENT_EFFECTIVE_AT_INVALID =
  "effectiveAt must be a valid server occurrence Date.";

/**
 * Normalize a server occurrence instant for InventoryMovement.effectiveAt.
 *
 * The column is TIMESTAMP(3) without time zone. Stell22 stores the UTC
 * calendar fields of the instant and interprets the stored naive timestamp
 * as UTC. Do not use client-local time or depend on PostgreSQL TimeZone.
 */
export function toUtcNaiveDate(instant: Date): Date {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
    throw new Error(INVENTORY_MOVEMENT_EFFECTIVE_AT_INVALID);
  }
  return new Date(instant.getTime());
}

/** UTC calendar fields as `YYYY-MM-DDTHH:mm:ss.sss` without a timezone suffix. */
export function utcNaiveTimestampString(instant: Date): string {
  return toUtcNaiveDate(instant).toISOString().replace("Z", "");
}
