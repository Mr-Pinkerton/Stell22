import type { PrismaClient } from "@prisma/client";
import { newRequestId } from "@/lib/request-id";
import { computeQuantityEditStateFingerprint } from "@/server/internal/production-quantity-edit";
import { editProductionOperationQuantity } from "@/server/production";

/** Test-only: resolve current id-ordered index, then call the retained A/B/C command. */
export async function editPhysicalQuantityByLineIndex(
  db: PrismaClient,
  operationId: string,
  lineIndex: number,
  newQuantity: number,
  requestId = newRequestId(),
) {
  const op = await db.productionOperation.findUniqueOrThrow({
    where: { id: operationId },
    include: {
      lines: { orderBy: { id: "asc" } },
      nomenclatureLines: { orderBy: { id: "asc" } },
    },
  });
  const line = op.type === "UPAKOVKA" ? null : (op.lines[lineIndex] ?? null);
  if (op.type !== "UPAKOVKA" && !line) throw new Error("Строка не найдена");
  return editProductionOperationQuantity({
    operationId,
    requestId,
    targetLineId: line?.id ?? null,
    expectedOldQuantity: op.type === "UPAKOVKA" ? (op.productQty ?? 0) : line!.quantity,
    newQuantity,
    expectedStateFingerprint: computeQuantityEditStateFingerprint({
      operationId: op.id,
      operationType: op.type as "TORCOVKA" | "PRISADKA" | "UPAKOVKA",
      productId: op.productId,
      productQty: op.productQty,
      line,
      lines: op.lines,
      nomenclatureLines: op.nomenclatureLines,
    }),
  });
}
