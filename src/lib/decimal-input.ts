import { Decimal } from "decimal.js";

/** Draft while typing. `complete` is a finished number, including zero. */
export type DecimalDraft = {
  text: string;
  value: number | null;
  complete: boolean;
  empty: boolean;
  error: "precision" | "invalid" | "negative" | null;
};

export type IntegerDraft = {
  text: string;
  value: number | null;
  complete: boolean;
  empty: boolean;
  error: "fraction" | "invalid" | "negative" | null;
};

const WHITESPACE = /[\s\u00a0\u202f]/g;

function emptyDecimal(): DecimalDraft {
  return { text: "", value: null, complete: false, empty: true, error: null };
}

/**
 * Decimal draft. Comma and dot are the same separator.
 * "0," and "0." stay incomplete and are not a committed zero.
 * Extra fraction digits are an error: the text is kept and the value is not cut.
 */
export function parseDecimalText(raw: string, scale: number): DecimalDraft {
  const body = raw.replace(WHITESPACE, "").replace(/₽/g, "");
  if (body === "") return emptyDecimal();

  if (body.includes("-")) {
    return { text: body, value: null, complete: false, empty: false, error: "negative" };
  }
  if (/[^0-9.,]/.test(body)) {
    return { text: body, value: null, complete: false, empty: false, error: "invalid" };
  }
  if ((body.match(/[.,]/g)?.length ?? 0) > 1) {
    return { text: body, value: null, complete: false, empty: false, error: "invalid" };
  }

  const sepAt = body.search(/[.,]/);
  const sep = sepAt === -1 ? "" : body[sepAt]!;
  const intRaw = sepAt === -1 ? body : body.slice(0, sepAt);
  const fracRaw = sepAt === -1 ? "" : body.slice(sepAt + 1);
  const intNorm = intRaw.replace(/^0+(?=\d)/, "");
  const shownInt = intNorm === "" ? "0" : intNorm;
  const text = sep ? `${shownInt}${sep}${fracRaw}` : shownInt;

  if (sep && scale === 0) {
    return { text, value: null, complete: false, empty: false, error: "precision" };
  }
  if (fracRaw.length > scale) {
    return { text, value: null, complete: false, empty: false, error: "precision" };
  }
  if (sep && fracRaw === "") {
    return { text, value: null, complete: false, empty: false, error: null };
  }

  const numeric = new Decimal(`${shownInt}.${fracRaw === "" ? "0" : fracRaw}`);
  return {
    text,
    value: numeric.toNumber(),
    complete: true,
    empty: false,
    error: null,
  };
}

/** Display a stored number with a comma. Does not add trailing zeros. */
export function formatMeasured(value: number, scale: number): string {
  const [int, frac = ""] = new Decimal(value).toFixed(scale).split(".");
  const trimmed = frac.replace(/0+$/, "");
  return trimmed ? `${int},${trimmed}` : int!;
}

export function assertMaxFractionDigits(value: number, scale: number, message: string): void {
  const dec = new Decimal(value);
  if (!dec.isFinite() || dec.decimalPlaces() > scale) throw new Error(message);
}

/**
 * Money at scale 2 for storage. Pads to two places.
 * A third decimal digit throws. This does not round to a whole ruble.
 */
export function exactMoneyString(value: number): string {
  assertMaxFractionDigits(value, 2, precisionMessage(2));
  return new Decimal(value).toFixed(2);
}

/** Positive integer draft. A comma or dot is a fraction error, not a stripped digit. */
export function parsePositiveIntDraft(raw: string): IntegerDraft {
  const text = raw.replace(WHITESPACE, "");
  if (text === "") return { text: "", value: null, complete: false, empty: true, error: null };
  if (text.includes("-")) {
    return { text, value: null, complete: false, empty: false, error: "negative" };
  }
  if (/[.,]/.test(text)) {
    return { text, value: null, complete: false, empty: false, error: "fraction" };
  }
  if (!/^\d+$/.test(text)) {
    return { text, value: null, complete: false, empty: false, error: "invalid" };
  }
  const normalized = text.replace(/^0+(?=\d)/, "");
  return {
    text: normalized,
    value: Number(normalized),
    complete: true,
    empty: false,
    error: null,
  };
}

/** Incomplete text or an error must not be committed over a saved number. */
export function decimalDraftBlocksCommit(draft: DecimalDraft): boolean {
  return draft.error != null || (!draft.empty && !draft.complete);
}

export function precisionMessage(scale: number): string {
  if (scale <= 0) return "Только целое число";
  return `Не больше ${scale} знаков после запятой`;
}
