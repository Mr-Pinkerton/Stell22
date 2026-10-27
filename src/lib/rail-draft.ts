import { parseDecimalText, parsePositiveIntDraft } from "@/lib/decimal-input";

const LENGTH_SCALE = 4;

export type RailAddResult =
  | {
      ok: true;
      lengthM: number;
      quantity: number;
      rows?: number;
      layers?: number;
      fromGrid: boolean;
    }
  | { ok: false; message: string };

function positiveInt(text: string, label: string): { ok: true; value: number | null } | { ok: false; message: string } {
  const draft = parsePositiveIntDraft(text);
  if (draft.empty) return { ok: true, value: null };
  if (draft.error === "fraction") return { ok: false, message: `${label} — целое число` };
  if (draft.error || !draft.complete || draft.value == null || draft.value <= 0) {
    return { ok: false, message: `${label} — целое число больше нуля` };
  }
  return { ok: true, value: draft.value };
}

/** Commit check for a new rail. Does not mutate package codes. */
export function evaluateRailAdd(input: {
  lengthText: string;
  quantityText: string;
  rowsText: string;
  layersText: string;
}): RailAddResult {
  const length = parseDecimalText(input.lengthText, LENGTH_SCALE);
  if (length.empty || (!length.complete && !length.error)) {
    return { ok: false, message: "Укажите длину рейки" };
  }
  if (length.error === "precision") return { ok: false, message: "Длина — не больше 4 знаков после запятой" };
  if (length.error || length.value == null || length.value <= 0) {
    return { ok: false, message: "Укажите длину рейки больше нуля" };
  }

  const rows = positiveInt(input.rowsText, "Ряды");
  if (!rows.ok) return rows;
  const layers = positiveInt(input.layersText, "Слои");
  if (!layers.ok) return layers;

  if (rows.value != null && layers.value != null) {
    return {
      ok: true,
      lengthM: length.value,
      quantity: rows.value * layers.value,
      rows: rows.value,
      layers: layers.value,
      fromGrid: true,
    };
  }

  const quantity = positiveInt(input.quantityText, "Количество реек");
  if (!quantity.ok) return quantity;
  if (quantity.value == null) return { ok: false, message: "Укажите количество реек" };

  return {
    ok: true,
    lengthM: length.value,
    quantity: quantity.value,
    fromGrid: false,
  };
}
