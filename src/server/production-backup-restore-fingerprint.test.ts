import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  COLUMN_SQL,
  CONSTRAINT_SQL,
  FingerprintSyntaxError,
  canonicalizeConstraintDefinition,
  columnFingerprint,
  constraintFingerprint,
} from "../../scripts/production-backup-restore-fingerprint.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const UNIT = "\u001f";

const productionIdentity = String.raw`CHECK ((((char_length(btrim("causationId")) >= 1) AND (char_length(btrim("causationId")) <= 200)) AND ((char_length(btrim("effectKey")) >= 1) AND (char_length(btrim("effectKey")) <= 200)) AND (("epochId" IS NULL) OR ((char_length(btrim("epochId")) >= 1) AND (char_length(btrim("epochId")) <= 200)))))`;
const restoredIdentity = String.raw`CHECK (((char_length(btrim("causationId")) >= 1) AND (char_length(btrim("causationId")) <= 200) AND ((char_length(btrim("effectKey")) >= 1) AND (char_length(btrim("effectKey")) <= 200)) AND (("epochId" IS NULL) OR ((char_length(btrim("epochId")) >= 1) AND (char_length(btrim("epochId")) <= 200)))))`;

function columnRow(fields: readonly string[]): string {
  return fields.join(UNIT);
}

function constraintRow(definition: string, validated = "validated"): string {
  return ["public", "InventoryMovement", "InventoryMovement_identity_length", "c", validated, "not-deferrable", "not-initially-deferred", definition].join(UNIT);
}

describe("production backup fingerprints", () => {
  it("ignores attnum holes and redundant AND grouping from the 2026-10-15 restore", () => {
    expect(canonicalizeConstraintDefinition(productionIdentity)).toBe(
      canonicalizeConstraintDefinition(restoredIdentity),
    );
    expect(constraintFingerprint(`${constraintRow(productionIdentity)}\n`)).toBe(
      constraintFingerprint(`${constraintRow(restoredIdentity)}\n`),
    );

    const holed = columnFingerprint(
      `${columnRow(["public", "Product", "id", "text", "NO", "0", "", "0", "", "0", "", "1", "default"])}\n${columnRow(["public", "Product", "name", "text", "NO", "0", "", "0", "", "0", "", "1", "default"])}\n`,
    );
    const closed = columnFingerprint(
      `${columnRow(["public", "Product", "name", "text", "NO", "0", "", "0", "", "0", "", "1", "default"])}\n${columnRow(["public", "Product", "id", "text", "NO", "0", "", "0", "", "0", "", "1", "default"])}\n`,
    );
    expect(holed).toBe(closed);
    expect(COLUMN_SQL).toContain("NOT a.attisdropped");
    expect(COLUMN_SQL).not.toContain("a.attnum,");
    expect(COLUMN_SQL).not.toContain("ordinal_position");
    expect(CONSTRAINT_SQL).toContain("pg_get_constraintdef");
  });

  it("keeps parentheses that change boolean meaning", () => {
    const grouped = canonicalizeConstraintDefinition("CHECK ((a = 1 OR b = 2) AND c = 3)");
    const regrouped = canonicalizeConstraintDefinition("CHECK (a = 1 OR (b = 2 AND c = 3))");
    expect(grouped).toBe("CHECK ((a = 1 OR b = 2) AND c = 3)");
    expect(regrouped).toBe("CHECK (a = 1 OR b = 2 AND c = 3)");
    expect(grouped).not.toBe(regrouped);

    const notGrouped = canonicalizeConstraintDefinition("CHECK (NOT (a = 1 AND b = 2))");
    const notDistributed = canonicalizeConstraintDefinition("CHECK ((NOT a = 1) AND b = 2)");
    expect(notGrouped).toBe("CHECK (NOT (a = 1 AND b = 2))");
    expect(notDistributed).toBe("CHECK (NOT a = 1 AND b = 2)");
    expect(notGrouped).not.toBe(notDistributed);

    expect(canonicalizeConstraintDefinition("CHECK (a - (b - c) > 0)")).not.toBe(
      canonicalizeConstraintDefinition("CHECK ((a - b) - c > 0)"),
    );
    expect(canonicalizeConstraintDefinition("CHECK (a = 'b  c')")).not.toBe(
      canonicalizeConstraintDefinition("CHECK (a = 'b c')"),
    );
    expect(canonicalizeConstraintDefinition("PRIMARY KEY  (id)")).toBe("PRIMARY KEY (id)");
  });

  it("changes the digest when a logical property changes and rejects a broken expression", () => {
    const base = columnFingerprint(
      `${columnRow(["public", "Product", "id", "text", "NO", "0", "", "0", "", "0", "", "0", ""])}\n`,
    );
    expect(
      columnFingerprint(
        `${columnRow(["public", "Product", "id", "text", "YES", "0", "", "0", "", "0", "", "0", ""])}\n`,
      ),
    ).not.toBe(base);
    expect(
      columnFingerprint(
        `${columnRow(["public", "Product", "id", "text", "NO", "1", "0", "0", "", "0", "", "0", ""])}\n`,
      ),
    ).not.toBe(base);
    expect(constraintFingerprint(`${constraintRow(productionIdentity, "not-validated")}\n`)).not.toBe(
      constraintFingerprint(`${constraintRow(productionIdentity)}\n`),
    );
    expect(() => canonicalizeConstraintDefinition("CHECK (a = )")).toThrow(FingerprintSyntaxError);
  });

  it("is the fingerprint the restore script asks PostgreSQL to compute", () => {
    const script = readFileSync(path.join(repoRoot, "scripts", "production-backup-restore.sh"), "utf8");
    expect(script).toContain("production-backup-restore-fingerprint.mjs");
    expect(script).toContain("column_fingerprint");
    expect(script).toContain("constraint_fingerprint");
    expect(script).not.toContain("ordinal_position");
  });
});
