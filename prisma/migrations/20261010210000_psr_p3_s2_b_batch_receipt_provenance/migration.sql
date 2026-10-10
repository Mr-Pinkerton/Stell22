-- PSR-P3 Slice 2-B P1: nullable receipt provenance on BatchCreationCommand.
-- No backfill. No foreign keys. No ledger writes. No writer.
-- One explicit PostgreSQL transaction: Prisma 6 classic migration.sql
-- is not wrapped automatically.

BEGIN;

ALTER TABLE "BatchCreationCommand"
  ADD COLUMN "receiptProvenanceSnapshot" JSONB;

ALTER TABLE "BatchCreationCommand"
  ADD CONSTRAINT "BatchCreationCommand_receiptProvenanceSnapshot_shape"
  CHECK (
    "receiptProvenanceSnapshot" IS NULL
    OR jsonb_typeof("receiptProvenanceSnapshot") = 'object'
  );

CREATE FUNCTION "batch_creation_command_provenance_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."receiptProvenanceSnapshot" IS NOT NULL THEN
      RAISE EXCEPTION 'batch creation command provenance is retained';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."receiptProvenanceSnapshot" IS NULL THEN
    IF NEW."receiptProvenanceSnapshot" IS NOT NULL THEN
      RAISE EXCEPTION 'legacy batch creation command provenance cannot be filled';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."receiptProvenanceSnapshot" IS DISTINCT FROM OLD."receiptProvenanceSnapshot"
     OR NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."requestId" IS DISTINCT FROM OLD."requestId"
     OR NEW."batchId" IS DISTINCT FROM OLD."batchId" THEN
    RAISE EXCEPTION 'batch creation command provenance is immutable';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "batch_creation_command_provenance_guard"
  BEFORE UPDATE OR DELETE ON "BatchCreationCommand"
  FOR EACH ROW
  EXECUTE FUNCTION "batch_creation_command_provenance_guard"();

COMMIT;
