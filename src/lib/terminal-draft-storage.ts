import type { Sort } from "@/types/domain";

export const TERMINAL_DRAFT_VERSION = 1 as const;
export const TERMINAL_DRAFT_KEY_PREFIX = "stell22:terminal:draft:";
export const TERMINAL_DRAFT_STALE_AGE_MS = 24 * 60 * 60 * 1000;

export type TerminalDraftOperation = "TORCOVKA" | "PRISADKA" | "UPAKOVKA" | "HOURS";

export type TorcovkaAckUiPhase = "none" | "suspicious" | "approval";

export interface TorcovkaDraftPayload {
  batchId: string | null;
  lotId: string | null;
  railsTaken: number;
  picks: { lengthM: number; sort: Sort; quantity: number }[];
  activeSort: Sort;
  ackUi: {
    phase: TorcovkaAckUiPhase;
    approvalCode: string;
  };
}

export interface PrisadkaDraftPayload {
  picks: { detailId: string; kind: "torcev" | "plosk"; quantity: number }[];
}

export interface UpakovkaDraftPayload {
  picks: { productId: string; quantity: number }[];
}

export interface HoursDraftPayload {
  hoursInput: string;
}

export type TerminalDraftPayload =
  | { operationType: "TORCOVKA"; payload: TorcovkaDraftPayload }
  | { operationType: "PRISADKA"; payload: PrisadkaDraftPayload }
  | { operationType: "UPAKOVKA"; payload: UpakovkaDraftPayload }
  | { operationType: "HOURS"; payload: HoursDraftPayload };

export type TerminalDraftV1 = {
  version: 1;
  employeeId: string;
  clientRequestId: string;
  createdAt: string;
  updatedAt: string;
} & TerminalDraftPayload;

export type DraftParseFailReason = "malformed" | "unsupported_version";

export type DraftParseResult =
  | { ok: true; draft: TerminalDraftV1 }
  | { ok: false; reason: DraftParseFailReason };

export type DraftReadResult =
  | { status: "none" }
  | { status: "ok"; draft: TerminalDraftV1 }
  | { status: "error"; reason: DraftParseFailReason };

const OPERATIONS: readonly TerminalDraftOperation[] = [
  "TORCOVKA",
  "PRISADKA",
  "UPAKOVKA",
  "HOURS",
];
const SORTS: readonly Sort[] = ["SORT1", "SORT2"];
const ACK_PHASES: readonly TorcovkaAckUiPhase[] = ["none", "suspicious", "approval"];
const PRISADKA_KINDS = ["torcev", "plosk"] as const;

export const OPERATION_LABEL: Record<TerminalDraftOperation, string> = {
  TORCOVKA: "Торцовка",
  PRISADKA: "Присадка",
  UPAKOVKA: "Упаковка",
  HOURS: "Рабочие часы",
};

export function draftStorageKey(employeeId: string): string {
  return `${TERMINAL_DRAFT_KEY_PREFIX}${employeeId}`;
}

export function parseTerminalDraft(raw: unknown): DraftParseResult {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "malformed" };
  }
  const rec = raw as Record<string, unknown>;
  if (rec.version !== 1) {
    if (typeof rec.version === "number" && rec.version !== 1) {
      return { ok: false, reason: "unsupported_version" };
    }
    return { ok: false, reason: "malformed" };
  }
  if (!isNonEmptyString(rec.employeeId)) return { ok: false, reason: "malformed" };
  if (!isNonEmptyString(rec.clientRequestId)) return { ok: false, reason: "malformed" };
  if (!isNonEmptyString(rec.createdAt)) return { ok: false, reason: "malformed" };
  if (!isNonEmptyString(rec.updatedAt)) return { ok: false, reason: "malformed" };
  if (!isOperation(rec.operationType)) return { ok: false, reason: "malformed" };

  const payload = parsePayload(rec.operationType, rec.payload);
  if (!payload) return { ok: false, reason: "malformed" };

  return {
    ok: true,
    draft: {
      version: 1,
      employeeId: rec.employeeId,
      clientRequestId: rec.clientRequestId,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      ...payload,
    },
  };
}

export function readDraft(storage: Storage | undefined, employeeId: string): DraftReadResult {
  if (!storage || !employeeId) return { status: "none" };
  let raw: string | null;
  try {
    raw = storage.getItem(draftStorageKey(employeeId));
  } catch {
    return { status: "none" };
  }
  if (raw == null || raw === "") return { status: "none" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "error", reason: "malformed" };
  }
  const result = parseTerminalDraft(parsed);
  if (!result.ok) return { status: "error", reason: result.reason };
  if (result.draft.employeeId !== employeeId) return { status: "none" };
  return { status: "ok", draft: result.draft };
}

export function writeDraft(storage: Storage | undefined, draft: TerminalDraftV1): void {
  if (!storage) return;
  try {
    storage.setItem(draftStorageKey(draft.employeeId), JSON.stringify(serializeDraft(draft)));
  } catch {
    // quota / private mode — терминал не падает
  }
}

export function clearDraft(storage: Storage | undefined, employeeId: string): void {
  if (!storage || !employeeId) return;
  try {
    storage.removeItem(draftStorageKey(employeeId));
  } catch {
    // ignore
  }
}

export function isMeaningful(draft: TerminalDraftV1): boolean {
  switch (draft.operationType) {
    case "TORCOVKA":
      return (
        draft.payload.batchId != null ||
        draft.payload.lotId != null ||
        draft.payload.railsTaken > 0 ||
        draft.payload.picks.some((p) => p.quantity > 0)
      );
    case "PRISADKA":
    case "UPAKOVKA":
      return draft.payload.picks.some((p) => p.quantity > 0);
    case "HOURS":
      return Number(draft.payload.hoursInput) > 0;
  }
}

/**
 * First draft: write only if meaningful.
 * After a draft already exists: write every valid snapshot, including empty.
 * Never auto-deletes. Returns whether Storage now holds this employee draft.
 */
export function shouldWriteDraft(pending: TerminalDraftV1, hasPersistedDraft: boolean): boolean {
  return isMeaningful(pending) || hasPersistedDraft;
}

export function persistPendingDraft(
  storage: Storage | undefined,
  pending: TerminalDraftV1 | null,
  hasPersistedDraft: boolean,
): boolean {
  if (!pending) return hasPersistedDraft;
  if (!shouldWriteDraft(pending, hasPersistedDraft)) return false;
  writeDraft(storage, pending);
  return true;
}

export function serializeDraft(draft: TerminalDraftV1): TerminalDraftV1 {
  const base = {
    version: 1 as const,
    employeeId: draft.employeeId,
    clientRequestId: draft.clientRequestId,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  };
  switch (draft.operationType) {
    case "TORCOVKA":
      return {
        ...base,
        operationType: "TORCOVKA",
        payload: {
          batchId: draft.payload.batchId,
          lotId: draft.payload.lotId,
          railsTaken: draft.payload.railsTaken,
          picks: draft.payload.picks.map((p) => ({
            lengthM: p.lengthM,
            sort: p.sort,
            quantity: p.quantity,
          })),
          activeSort: draft.payload.activeSort,
          ackUi: {
            phase: draft.payload.ackUi.phase,
            approvalCode: draft.payload.ackUi.approvalCode,
          },
        },
      };
    case "PRISADKA":
      return {
        ...base,
        operationType: "PRISADKA",
        payload: {
          picks: draft.payload.picks.map((p) => ({
            detailId: p.detailId,
            kind: p.kind,
            quantity: p.quantity,
          })),
        },
      };
    case "UPAKOVKA":
      return {
        ...base,
        operationType: "UPAKOVKA",
        payload: {
          picks: draft.payload.picks.map((p) => ({
            productId: p.productId,
            quantity: p.quantity,
          })),
        },
      };
    case "HOURS":
      return {
        ...base,
        operationType: "HOURS",
        payload: { hoursInput: draft.payload.hoursInput },
      };
  }
}

export function isDraftStaleByAge(createdAt: string, nowMs = Date.now()): boolean {
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return false;
  return nowMs - t >= TERMINAL_DRAFT_STALE_AGE_MS;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isOperation(value: unknown): value is TerminalDraftOperation {
  return typeof value === "string" && (OPERATIONS as readonly string[]).includes(value);
}

function isSort(value: unknown): value is Sort {
  return typeof value === "string" && (SORTS as readonly string[]).includes(value);
}

function isIntGte0(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && Number.isFinite(value) && value >= 0;
}

function isPositiveLength(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function parsePayload(
  operationType: TerminalDraftOperation,
  payload: unknown,
): TerminalDraftPayload | null {
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const rec = payload as Record<string, unknown>;
  if (operationType === "TORCOVKA") {
    const picks = parseTorcovkaPicks(rec.picks);
    const ackUi = parseAckUi(rec.ackUi);
    if (!picks || !ackUi) return null;
    if (rec.batchId !== null && !isNonEmptyString(rec.batchId)) return null;
    if (rec.lotId !== null && !isNonEmptyString(rec.lotId)) return null;
    if (!isIntGte0(rec.railsTaken)) return null;
    if (!isSort(rec.activeSort)) return null;
    return {
      operationType: "TORCOVKA",
      payload: {
        batchId: rec.batchId,
        lotId: rec.lotId,
        railsTaken: rec.railsTaken,
        picks,
        activeSort: rec.activeSort,
        ackUi,
      },
    };
  }
  if (operationType === "PRISADKA") {
    const picks = parsePrisadkaPicks(rec.picks);
    if (!picks) return null;
    return { operationType: "PRISADKA", payload: { picks } };
  }
  if (operationType === "UPAKOVKA") {
    const picks = parseUpakovkaPicks(rec.picks);
    if (!picks) return null;
    return { operationType: "UPAKOVKA", payload: { picks } };
  }
  if (typeof rec.hoursInput !== "string") return null;
  return { operationType: "HOURS", payload: { hoursInput: rec.hoursInput } };
}

function parseTorcovkaPicks(
  value: unknown,
): TorcovkaDraftPayload["picks"] | null {
  if (!Array.isArray(value)) return null;
  const picks: TorcovkaDraftPayload["picks"] = [];
  for (const item of value) {
    if (item == null || typeof item !== "object" || Array.isArray(item)) return null;
    const rec = item as Record<string, unknown>;
    if (!isPositiveLength(rec.lengthM) || !isSort(rec.sort) || !isIntGte0(rec.quantity)) return null;
    picks.push({ lengthM: rec.lengthM, sort: rec.sort, quantity: rec.quantity });
  }
  return picks;
}

function parseAckUi(value: unknown): TorcovkaDraftPayload["ackUi"] | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  const phase = normalizeAckPhase(rec.phase);
  if (!phase) return null;
  return {
    phase,
    approvalCode: parseDraftApprovalCode(rec.approvalCode),
  };
}

function normalizeAckPhase(value: unknown): TorcovkaAckUiPhase | null {
  if (value === "extreme") return "none";
  if (typeof value === "string" && (ACK_PHASES as readonly string[]).includes(value)) {
    return value as TorcovkaAckUiPhase;
  }
  return null;
}

function parseDraftApprovalCode(value: unknown): string {
  if (typeof value !== "string") return "";
  return /^\d{0,4}$/.test(value) ? value : "";
}

function parsePrisadkaPicks(value: unknown): PrisadkaDraftPayload["picks"] | null {
  if (!Array.isArray(value)) return null;
  const picks: PrisadkaDraftPayload["picks"] = [];
  for (const item of value) {
    if (item == null || typeof item !== "object" || Array.isArray(item)) return null;
    const rec = item as Record<string, unknown>;
    if (!isNonEmptyString(rec.detailId) || !isIntGte0(rec.quantity)) return null;
    if (rec.kind !== "torcev" && rec.kind !== "plosk") return null;
    if (!(PRISADKA_KINDS as readonly string[]).includes(rec.kind)) return null;
    picks.push({ detailId: rec.detailId, kind: rec.kind, quantity: rec.quantity });
  }
  return picks;
}

function parseUpakovkaPicks(value: unknown): UpakovkaDraftPayload["picks"] | null {
  if (!Array.isArray(value)) return null;
  const picks: UpakovkaDraftPayload["picks"] = [];
  for (const item of value) {
    if (item == null || typeof item !== "object" || Array.isArray(item)) return null;
    const rec = item as Record<string, unknown>;
    if (!isNonEmptyString(rec.productId) || !isIntGte0(rec.quantity)) return null;
    picks.push({ productId: rec.productId, quantity: rec.quantity });
  }
  return picks;
}
