import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function sliceExport(rel: string, name: string): string {
  const src = readFileSync(path.join(root, rel), "utf8");
  const start = src.indexOf(`export async function ${name}`);
  expect(start).toBeGreaterThan(-1);
  const next = src.indexOf("\nexport ", start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

describe("torcovka row-lock order", () => {
  it("locks the rail lot before the batch in submit, correction, and cancellation", () => {
    const submit = sliceExport("src/server/internal/submit-torcovka-tx.ts", "submitTorcovkaInTransaction");
    const correct = sliceExport(
      "src/server/internal/correct-torcovka-rails-taken-tx.ts",
      "correctTorcovkaRailsTakenInTransaction",
    );
    const cancel = sliceExport(
      "src/server/internal/cancel-production-operation-tx.ts",
      "cancelProductionOperationInTransaction",
    );
    for (const body of [submit, correct, cancel]) {
      const lot = body.indexOf("lockRailLots");
      const batch = body.indexOf("lockBatches");
      expect(lot).toBeGreaterThan(-1);
      expect(batch).toBeGreaterThan(lot);
    }
    expect(submit.indexOf("Партия в архиве — торцовка недоступна")).toBeGreaterThan(
      submit.indexOf("lockBatches"),
    );
  });
});
