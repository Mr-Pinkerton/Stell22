-- DI-003: partial UNIQUE Account.accountNumber (canonical bank identity),
-- then partial UNIQUE CashFlow(accountId, importKey).
-- One explicit PostgreSQL transaction. Prisma 6 classic PostgreSQL
-- migration.sql is not wrapped in a transaction automatically.
-- No CREATE INDEX CONCURRENTLY.
-- Duplicate rows → RAISE (no auto-merge / auto-delete).

BEGIN;

LOCK TABLE "Account" IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  dup text;
BEGIN
  SELECT string_agg(format('%s (%s)', id, "accountNumber"), ', ')
  INTO dup
  FROM "Account"
  WHERE "accountNumber" IS NOT NULL
    AND "accountNumber" IN (
      SELECT "accountNumber" FROM "Account"
      WHERE "accountNumber" IS NOT NULL
      GROUP BY 1 HAVING COUNT(*) > 1
    );

  IF dup IS NOT NULL THEN
    RAISE EXCEPTION
      'DI-003: duplicate Account.accountNumber: %; resolve before migrate (no auto-merge)',
      dup;
  END IF;
END $$;

CREATE UNIQUE INDEX "Account_accountNumber_key"
  ON "Account" ("accountNumber")
  WHERE "accountNumber" IS NOT NULL;

LOCK TABLE "CashFlow" IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  dup text;
BEGIN
  SELECT string_agg(format('%s / %s', "accountId", "importKey"), ', ')
  INTO dup
  FROM (
    SELECT "accountId", "importKey"
    FROM "CashFlow"
    WHERE "importKey" IS NOT NULL
    GROUP BY "accountId", "importKey"
    HAVING COUNT(*) > 1
  ) d;

  IF dup IS NOT NULL THEN
    RAISE EXCEPTION
      'DI-003: duplicate CashFlow (accountId, importKey): %; resolve before migrate (no auto-fix)',
      dup;
  END IF;
END $$;

DROP INDEX IF EXISTS "CashFlow_accountId_importKey_idx";

CREATE UNIQUE INDEX "CashFlow_accountId_importKey_key"
  ON "CashFlow" ("accountId", "importKey")
  WHERE "importKey" IS NOT NULL;

COMMIT;
