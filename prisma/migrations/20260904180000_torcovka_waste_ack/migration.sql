-- DI-020: submit-time TORCOVKA waste acknowledgement (nullable, no backfill).

CREATE TYPE "TorcovkaAckBand" AS ENUM ('SUSPICIOUS', 'HIGH_WASTE');
CREATE TYPE "TorcovkaWasteReason" AS ENUM (
  'CURVATURE', 'CRACKS', 'KNOTS', 'MATERIAL_DEFECT',
  'COLOR_TEXTURE', 'WRONG_SIZE', 'OTHER'
);

ALTER TABLE "ProductionOperation"
  ADD COLUMN "torcovkaSubmitAckBand" "TorcovkaAckBand",
  ADD COLUMN "torcovkaSubmitWasteReason" "TorcovkaWasteReason",
  ADD COLUMN "torcovkaSubmitWasteNote" TEXT;
