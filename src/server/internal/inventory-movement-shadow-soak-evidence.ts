/**
 * Read-only SHADOW soak evidence evaluator.
 * It reads an already captured snapshot. It does not open a database,
 * change the gate, or declare soak complete.
 *
 * recordedAt is the write time. effectiveAt is the causal instant and is
 * never treated as the time the row was recorded.
 */
import { PINNED_PRODUCTION_APPLICATION_SHA } from "@/server/internal/inventory-movement-shadow-activation-policy";

export { PINNED_PRODUCTION_APPLICATION_SHA };

const SHA_RE = /^[0-9a-f]{40}$/;
const LINE_RE = /^SHADOW_SOAK ([A-Za-z0-9_]+)=([A-Za-z0-9_]+)$/;
const RECORDED_STAMP_RE = /^[0-9]{8}T[0-9]{9}Z$/;
const SHIFT_STAMP_RE = /^[0-9]{8}T[0-9]{6}Z$/;
const DAY_KEY_RE = /^SHADOW_DAY_([0-9]{8})$/;
const HOUR_KEY_RE = /^SHADOW_HOUR_([0-9]{8}T[0-9]{2})$/;

const CAUSATION_KINDS = [
  "PRODUCTION_OPERATION",
  "PRODUCTION_OPERATION_MUTATION",
  "INVENTORY",
  "SIMPLE_PURCHASE",
  "BATCH",
  "RAIL_LOT",
  "SUPPLY",
  "MANUAL",
  "SYSTEM",
] as const;

const SETTING_STATES = ["ABSENT", "INACTIVE", "ACTIVE", "MALFORMED"] as const;

const FIXED_KEYS = [
  "PRODUCTION_APP_SHA",
  "SHA_PIN",
  "SHADOW_SETTING",
  "COST_FLOW_SETTING",
  "AUTHORITATIVE_COUNT",
  "NONEMPTY_EPOCH_COUNT",
  "OTHER_AUTHORITY_COUNT",
  "INVENTORY_MOVEMENT_COUNT",
  "SHADOW_COUNT",
  "MOVEMENT_TABLE",
  "PRODUCTION_OPERATION_TABLE",
  "CORRECTION_TABLE",
  "QUANTITY_EDIT_TABLE",
  "RECORDED_AT_TYPE",
  "EFFECTIVE_AT_TYPE",
  "SHADOW_RECORDED_AT_MIN",
  "SHADOW_RECORDED_AT_MAX",
  "SHADOW_EFFECTIVE_AT_MIN",
  "SHADOW_EFFECTIVE_AT_MAX",
  "RECORDED_EFFECTIVE_EQUAL_COUNT",
  "RECORDED_EFFECTIVE_DIFFER_COUNT",
  "RECORDED_MINUS_EFFECTIVE_MIN_MS",
  "RECORDED_MINUS_EFFECTIVE_MAX_MS",
  ...CAUSATION_KINDS.map((kind) => `CAUSATION_${kind}`),
  "CAUSATION_UNKNOWN",
  "PRODUCTION_OPS_DIRECT",
  "PRODUCTION_OPS_VIA_CORRECTION",
  "PRODUCTION_OPS_VIA_QUANTITY_EDIT",
  "PRODUCTION_OPS_DISTINCT",
  "PRODUCTION_DIRECT_UNMATCHED",
  "PRODUCTION_MUTATION_UNMATCHED",
  "PRODUCTION_MUTATION_AMBIGUOUS",
  "PRODUCTION_CORRECTION_DANGLING",
  "PRODUCTION_QUANTITY_EDIT_DANGLING",
  "SHADOW_DAY_SUM",
  "SHADOW_HOUR_SUM",
  "SHADOW_DAY_BUCKETS",
  "SHADOW_HOUR_BUCKETS",
  "SHIFT_INTERVAL",
  "SHIFT_START",
  "SHIFT_END",
  "SHIFT_SHADOW_ROWS",
  "SHIFT_SHADOW_OUTSIDE_ROWS",
  "SHIFT_HOURS",
  "SHIFT_HOURS_WITH_SHADOW",
  "SHIFT_HOURS_WITHOUT_SHADOW",
  "SHIFT_PRODUCTION_CREATED_OPS",
  "SHIFT_WORKDATE_OPS",
  "SNAPSHOT_MODE",
] as const;

const FIXED_KEY_SET = new Set<string>(FIXED_KEYS);

export type SoakEvidenceRefusal = { ok: false; code: string };

export type SoakEvidenceDecision =
  | { ok: true; markers: string[] }
  | SoakEvidenceRefusal;

function refuse(code: string): SoakEvidenceRefusal {
  return { ok: false, code };
}

function parseCount(value: string): number | null {
  if (!/^[0-9]+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return null;
  return parsed;
}

function parseMs(value: string): number | null {
  if (/^[0-9]+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  if (!/^M[1-9][0-9]*$/.test(value)) return null;
  const parsed = -Number(value.slice(1));
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function compactToUtcMs(stamp: string, plusMs = 0): number | null {
  const match = /^([0-9]{4})([0-9]{2})([0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})Z$/.exec(stamp);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  return Date.UTC(year, month - 1, day, hour, minute, second) + plusMs;
}

function recordedParts(stamp: string): { day: string; hour: string } | null {
  const match = /^([0-9]{8})T([0-9]{2})[0-9]{7}Z$/.exec(stamp);
  if (!match || !RECORDED_STAMP_RE.test(stamp)) return null;
  const hour = Number(match[2]);
  if (hour > 23) return null;
  return { day: match[1], hour: `${match[1]}T${match[2]}` };
}

function shiftHourCount(start: string, end: string): number | null {
  const startMs = compactToUtcMs(start);
  const endMs = compactToUtcMs(end, 999);
  if (startMs === null || endMs === null || endMs < startMs) return null;
  return Math.floor(endMs / 3_600_000) - Math.floor(startMs / 3_600_000) + 1;
}

function requireCount(map: Map<string, string>, key: string): number | SoakEvidenceRefusal {
  const value = map.get(key);
  if (value === undefined) return refuse("SNAPSHOT_INVALID");
  const parsed = parseCount(value);
  if (parsed === null) return refuse("SNAPSHOT_INVALID");
  return parsed;
}

function countOrRefusal(value: number | SoakEvidenceRefusal): value is number {
  return typeof value === "number";
}

export function evaluateShadowSoakEvidence(input: {
  expectedApplicationSha: string;
  snapshot: string;
}): SoakEvidenceDecision {
  if (!SHA_RE.test(input.expectedApplicationSha)) return refuse("SHA_MALFORMED");
  if (input.expectedApplicationSha !== PINNED_PRODUCTION_APPLICATION_SHA) {
    return refuse("SHA_NOT_PINNED");
  }

  const map = new Map<string, string>();
  const dayBuckets = new Map<string, number>();
  const hourBuckets = new Map<string, number>();
  let sawMode = false;

  for (const raw of input.snapshot.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = LINE_RE.exec(line);
    if (!match) return refuse("SNAPSHOT_INVALID");
    const key = match[1] ?? "";
    const value = match[2] ?? "";
    if (map.has(key)) return refuse("SNAPSHOT_INVALID");
    map.set(key, value);

    if (key === "SNAPSHOT_MODE") {
      sawMode = true;
      continue;
    }
    const day = DAY_KEY_RE.exec(key);
    if (day?.[1]) {
      const count = parseCount(value);
      if (count === null || count < 1) return refuse("SNAPSHOT_INVALID");
      dayBuckets.set(day[1], count);
      continue;
    }
    const hour = HOUR_KEY_RE.exec(key);
    if (hour?.[1]) {
      const hourOfDay = Number(hour[1].slice(-2));
      const count = parseCount(value);
      if (hourOfDay > 23 || count === null || count < 1) return refuse("TIMESTAMP_INVALID");
      hourBuckets.set(hour[1], count);
      continue;
    }
    if (!FIXED_KEY_SET.has(key)) return refuse("SNAPSHOT_INVALID");
  }

  if (!sawMode || map.get("SNAPSHOT_MODE") !== "READ_ONLY") return refuse("SNAPSHOT_INCOMPLETE");
  for (const key of FIXED_KEYS) {
    if (!map.has(key)) return refuse("SNAPSHOT_INVALID");
  }

  const productionAppSha = map.get("PRODUCTION_APP_SHA") ?? "";
  if (productionAppSha !== PINNED_PRODUCTION_APPLICATION_SHA) return refuse("SHA_NOT_PINNED");
  if (productionAppSha !== input.expectedApplicationSha) return refuse("SHA_PIN_MISMATCH");
  if (map.get("SHA_PIN") !== "MATCH") return refuse("SHA_PIN_MISMATCH");

  const shadowSetting = map.get("SHADOW_SETTING") ?? "";
  const costFlowSetting = map.get("COST_FLOW_SETTING") ?? "";
  if (!(SETTING_STATES as readonly string[]).includes(shadowSetting)) return refuse("SNAPSHOT_INVALID");
  if (!(SETTING_STATES as readonly string[]).includes(costFlowSetting)) return refuse("SNAPSHOT_INVALID");
  if (shadowSetting === "MALFORMED" || costFlowSetting === "MALFORMED") {
    return refuse("GATE_MALFORMED");
  }

  for (const key of [
    "MOVEMENT_TABLE",
    "PRODUCTION_OPERATION_TABLE",
    "CORRECTION_TABLE",
    "QUANTITY_EDIT_TABLE",
  ]) {
    if (map.get(key) !== "EXISTS") return refuse("SCHEMA_PREREQUISITE_INVALID");
  }
  if (map.get("RECORDED_AT_TYPE") !== "TIMESTAMPTZ") return refuse("SCHEMA_PREREQUISITE_INVALID");
  if (map.get("EFFECTIVE_AT_TYPE") !== "TIMESTAMP") return refuse("SCHEMA_PREREQUISITE_INVALID");

  const counts = new Map<string, number>();
  for (const key of [
    "AUTHORITATIVE_COUNT",
    "NONEMPTY_EPOCH_COUNT",
    "OTHER_AUTHORITY_COUNT",
    "INVENTORY_MOVEMENT_COUNT",
    "SHADOW_COUNT",
    "RECORDED_EFFECTIVE_EQUAL_COUNT",
    "RECORDED_EFFECTIVE_DIFFER_COUNT",
    "CAUSATION_UNKNOWN",
    "PRODUCTION_OPS_DIRECT",
    "PRODUCTION_OPS_VIA_CORRECTION",
    "PRODUCTION_OPS_VIA_QUANTITY_EDIT",
    "PRODUCTION_OPS_DISTINCT",
    "PRODUCTION_DIRECT_UNMATCHED",
    "PRODUCTION_MUTATION_UNMATCHED",
    "PRODUCTION_MUTATION_AMBIGUOUS",
    "PRODUCTION_CORRECTION_DANGLING",
    "PRODUCTION_QUANTITY_EDIT_DANGLING",
    "SHADOW_DAY_SUM",
    "SHADOW_HOUR_SUM",
    "SHADOW_DAY_BUCKETS",
    "SHADOW_HOUR_BUCKETS",
    ...CAUSATION_KINDS.map((kind) => `CAUSATION_${kind}`),
  ]) {
    const parsed = requireCount(map, key);
    if (!countOrRefusal(parsed)) return parsed;
    counts.set(key, parsed);
  }

  const shadowCount = counts.get("SHADOW_COUNT") ?? 0;
  const authoritativeCount = counts.get("AUTHORITATIVE_COUNT") ?? 0;
  const otherAuthority = counts.get("OTHER_AUTHORITY_COUNT") ?? 0;
  const movementCount = counts.get("INVENTORY_MOVEMENT_COUNT") ?? 0;
  if (otherAuthority !== 0) return refuse("COUNT_INCONSISTENT");
  if (authoritativeCount + shadowCount !== movementCount) return refuse("COUNT_INCONSISTENT");

  const causation = CAUSATION_KINDS.map((kind) => counts.get(`CAUSATION_${kind}`) ?? 0);
  const causationSum = causation.reduce((sum, value) => sum + value, 0);
  if ((counts.get("CAUSATION_UNKNOWN") ?? 0) !== 0) return refuse("CAUSATION_UNKNOWN");
  if (causationSum !== shadowCount) return refuse("COUNT_INCONSISTENT");

  const familyProduction =
    (counts.get("CAUSATION_PRODUCTION_OPERATION") ?? 0) +
    (counts.get("CAUSATION_PRODUCTION_OPERATION_MUTATION") ?? 0);
  const familyInventory = counts.get("CAUSATION_INVENTORY") ?? 0;
  const familySupply = counts.get("CAUSATION_SUPPLY") ?? 0;
  const familyOther =
    (counts.get("CAUSATION_SIMPLE_PURCHASE") ?? 0) +
    (counts.get("CAUSATION_BATCH") ?? 0) +
    (counts.get("CAUSATION_RAIL_LOT") ?? 0) +
    (counts.get("CAUSATION_MANUAL") ?? 0) +
    (counts.get("CAUSATION_SYSTEM") ?? 0);
  if (familyProduction + familyInventory + familySupply + familyOther !== shadowCount) {
    return refuse("COUNT_INCONSISTENT");
  }

  const directUnmatched = counts.get("PRODUCTION_DIRECT_UNMATCHED") ?? 0;
  const mutationUnmatched = counts.get("PRODUCTION_MUTATION_UNMATCHED") ?? 0;
  const ambiguous = counts.get("PRODUCTION_MUTATION_AMBIGUOUS") ?? 0;
  const correctionDangling = counts.get("PRODUCTION_CORRECTION_DANGLING") ?? 0;
  const quantityDangling = counts.get("PRODUCTION_QUANTITY_EDIT_DANGLING") ?? 0;
  if (directUnmatched !== 0 || mutationUnmatched !== 0) {
    return refuse("PRODUCTION_CAUSATION_UNMATCHED");
  }
  if (ambiguous !== 0) return refuse("MUTATION_IDENTITY_AMBIGUOUS");
  if (correctionDangling !== 0 || quantityDangling !== 0) {
    return refuse("PRODUCTION_CAUSATION_DANGLING");
  }

  const opsDirect = counts.get("PRODUCTION_OPS_DIRECT") ?? 0;
  const opsCorrection = counts.get("PRODUCTION_OPS_VIA_CORRECTION") ?? 0;
  const opsQuantity = counts.get("PRODUCTION_OPS_VIA_QUANTITY_EDIT") ?? 0;
  const opsDistinct = counts.get("PRODUCTION_OPS_DISTINCT") ?? 0;
  if (opsDistinct > opsDirect + opsCorrection + opsQuantity) return refuse("COUNT_INCONSISTENT");
  if (opsDistinct > familyProduction) return refuse("COUNT_INCONSISTENT");
  if (opsDirect > (counts.get("CAUSATION_PRODUCTION_OPERATION") ?? 0)) {
    return refuse("COUNT_INCONSISTENT");
  }
  if (opsCorrection + opsQuantity > (counts.get("CAUSATION_PRODUCTION_OPERATION_MUTATION") ?? 0)) {
    return refuse("COUNT_INCONSISTENT");
  }

  const daySum = [...dayBuckets.values()].reduce((sum, value) => sum + value, 0);
  const hourSum = [...hourBuckets.values()].reduce((sum, value) => sum + value, 0);
  if (daySum !== shadowCount || hourSum !== shadowCount) return refuse("COUNT_INCONSISTENT");
  if ((counts.get("SHADOW_DAY_SUM") ?? -1) !== shadowCount) return refuse("COUNT_INCONSISTENT");
  if ((counts.get("SHADOW_HOUR_SUM") ?? -1) !== shadowCount) return refuse("COUNT_INCONSISTENT");
  if ((counts.get("SHADOW_DAY_BUCKETS") ?? -1) !== dayBuckets.size) return refuse("COUNT_INCONSISTENT");
  if ((counts.get("SHADOW_HOUR_BUCKETS") ?? -1) !== hourBuckets.size) return refuse("COUNT_INCONSISTENT");

  const equalCount = counts.get("RECORDED_EFFECTIVE_EQUAL_COUNT") ?? 0;
  const differCount = counts.get("RECORDED_EFFECTIVE_DIFFER_COUNT") ?? 0;
  if (equalCount + differCount !== shadowCount) return refuse("COUNT_INCONSISTENT");

  const recordedMin = map.get("SHADOW_RECORDED_AT_MIN") ?? "";
  const recordedMax = map.get("SHADOW_RECORDED_AT_MAX") ?? "";
  const effectiveMin = map.get("SHADOW_EFFECTIVE_AT_MIN") ?? "";
  const effectiveMax = map.get("SHADOW_EFFECTIVE_AT_MAX") ?? "";
  const minMsRaw = map.get("RECORDED_MINUS_EFFECTIVE_MIN_MS") ?? "";
  const maxMsRaw = map.get("RECORDED_MINUS_EFFECTIVE_MAX_MS") ?? "";

  if (shadowCount === 0) {
    if (
      recordedMin !== "NONE" ||
      recordedMax !== "NONE" ||
      effectiveMin !== "NONE" ||
      effectiveMax !== "NONE" ||
      minMsRaw !== "NONE" ||
      maxMsRaw !== "NONE" ||
      dayBuckets.size !== 0 ||
      hourBuckets.size !== 0
    ) {
      return refuse("TIMESTAMP_INVALID");
    }
  } else {
    const minParts = recordedParts(recordedMin);
    const maxParts = recordedParts(recordedMax);
    if (!minParts || !maxParts || recordedMin > recordedMax) return refuse("TIMESTAMP_INVALID");
    if (!RECORDED_STAMP_RE.test(effectiveMin) || !RECORDED_STAMP_RE.test(effectiveMax)) {
      return refuse("TIMESTAMP_INVALID");
    }
    if (effectiveMin > effectiveMax) return refuse("TIMESTAMP_INVALID");
    if (!dayBuckets.has(minParts.day) || !dayBuckets.has(maxParts.day)) {
      return refuse("TIMESTAMP_BUCKET_MISMATCH");
    }
    if (!hourBuckets.has(minParts.hour) || !hourBuckets.has(maxParts.hour)) {
      return refuse("TIMESTAMP_BUCKET_MISMATCH");
    }
    for (const day of dayBuckets.keys()) {
      if (day < minParts.day || day > maxParts.day) return refuse("TIMESTAMP_BUCKET_MISMATCH");
    }
    for (const hour of hourBuckets.keys()) {
      if (hour < minParts.hour || hour > maxParts.hour) return refuse("TIMESTAMP_BUCKET_MISMATCH");
    }
    const minMs = parseMs(minMsRaw);
    const maxMs = parseMs(maxMsRaw);
    if (minMs === null || maxMs === null || minMs > maxMs) return refuse("TIMESTAMP_INVALID");
    if (equalCount === shadowCount && (minMs !== 0 || maxMs !== 0)) return refuse("TIMESTAMP_INVALID");
    if (equalCount > 0 && (minMs > 0 || maxMs < 0)) return refuse("TIMESTAMP_INVALID");
  }

  const shiftInterval = map.get("SHIFT_INTERVAL") ?? "";
  let shiftCoverage = "NOT_EVALUATED";
  if (shiftInterval === "ABSENT") {
    for (const key of [
      "SHIFT_START",
      "SHIFT_END",
      "SHIFT_SHADOW_ROWS",
      "SHIFT_SHADOW_OUTSIDE_ROWS",
      "SHIFT_HOURS",
      "SHIFT_HOURS_WITH_SHADOW",
      "SHIFT_HOURS_WITHOUT_SHADOW",
      "SHIFT_PRODUCTION_CREATED_OPS",
      "SHIFT_WORKDATE_OPS",
    ]) {
      if (map.get(key) !== "NONE") return refuse("SHIFT_INTERVAL_INVALID");
    }
  } else if (shiftInterval === "PRESENT") {
    const start = map.get("SHIFT_START") ?? "";
    const end = map.get("SHIFT_END") ?? "";
    if (!SHIFT_STAMP_RE.test(start) || !SHIFT_STAMP_RE.test(end) || start > end) {
      return refuse("SHIFT_INTERVAL_INVALID");
    }
    const expectedHours = shiftHourCount(start, end);
    const inside = parseCount(map.get("SHIFT_SHADOW_ROWS") ?? "");
    const outside = parseCount(map.get("SHIFT_SHADOW_OUTSIDE_ROWS") ?? "");
    const hours = parseCount(map.get("SHIFT_HOURS") ?? "");
    const hoursWith = parseCount(map.get("SHIFT_HOURS_WITH_SHADOW") ?? "");
    const hoursWithout = parseCount(map.get("SHIFT_HOURS_WITHOUT_SHADOW") ?? "");
    const createdOps = parseCount(map.get("SHIFT_PRODUCTION_CREATED_OPS") ?? "");
    const workDateOps = parseCount(map.get("SHIFT_WORKDATE_OPS") ?? "");
    if (
      expectedHours === null ||
      inside === null ||
      outside === null ||
      hours === null ||
      hoursWith === null ||
      hoursWithout === null ||
      createdOps === null ||
      workDateOps === null
    ) {
      return refuse("SHIFT_INTERVAL_INVALID");
    }
    if (inside + outside !== shadowCount) return refuse("COUNT_INCONSISTENT");
    if (hoursWith + hoursWithout !== hours || hours !== expectedHours) {
      return refuse("SHIFT_INTERVAL_INVALID");
    }
    if (inside > shadowCount || hoursWith > hours) return refuse("COUNT_INCONSISTENT");
    if (createdOps > opsDistinct || workDateOps > opsDistinct) return refuse("COUNT_INCONSISTENT");
    if (inside === 0) shiftCoverage = "EMPTY";
    else if (hours > 0 && hoursWithout === 0 && createdOps > 0) shiftCoverage = "FULL";
    else shiftCoverage = "PARTIAL";
  } else {
    return refuse("SHIFT_INTERVAL_INVALID");
  }

  const markers = [
    `PRODUCTION_APP_SHA=${productionAppSha}`,
    `SHADOW_SETTING=${shadowSetting}`,
    `SHADOW_GATE_ACTIVATED=${shadowSetting === "ACTIVE" ? "YES" : "NO"}`,
    `AUTHORITATIVE_COUNT=${authoritativeCount}`,
    `NONEMPTY_EPOCH_COUNT=${counts.get("NONEMPTY_EPOCH_COUNT")}`,
    `COST_FLOW_SETTING=${costFlowSetting}`,
    `SHADOW_COUNT=${shadowCount}`,
    `SHADOW_RECORDED_AT_MIN=${recordedMin}`,
    `SHADOW_RECORDED_AT_MAX=${recordedMax}`,
    `SHADOW_EFFECTIVE_AT_MIN=${effectiveMin}`,
    `SHADOW_EFFECTIVE_AT_MAX=${effectiveMax}`,
    "EFFECTIVE_AT_IS_NOT_WRITE_TIME=YES",
    `RECORDED_EFFECTIVE_EQUAL_COUNT=${equalCount}`,
    `RECORDED_EFFECTIVE_DIFFER_COUNT=${differCount}`,
    `RECORDED_MINUS_EFFECTIVE_MIN_MS=${minMsRaw}`,
    `RECORDED_MINUS_EFFECTIVE_MAX_MS=${maxMsRaw}`,
    ...CAUSATION_KINDS.map((kind) => `CAUSATION_${kind}=${counts.get(`CAUSATION_${kind}`)}`),
    `FAMILY_PRODUCTION=${familyProduction}`,
    `FAMILY_INVENTORY=${familyInventory}`,
    `FAMILY_SUPPLY=${familySupply}`,
    `FAMILY_OTHER=${familyOther}`,
    `PRODUCTION_OPS_DIRECT=${opsDirect}`,
    `PRODUCTION_OPS_VIA_CORRECTION=${opsCorrection}`,
    `PRODUCTION_OPS_VIA_QUANTITY_EDIT=${opsQuantity}`,
    `PRODUCTION_OPS_DISTINCT=${opsDistinct}`,
    `SHADOW_DAY_SUM=${shadowCount}`,
    `SHADOW_HOUR_SUM=${shadowCount}`,
    ...[...dayBuckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, count]) => `SHADOW_DAY_${day}=${count}`),
    ...[...hourBuckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([hour, count]) => `SHADOW_HOUR_${hour}=${count}`),
    `SHIFT_INTERVAL=${shiftInterval}`,
    `SHIFT_START=${map.get("SHIFT_START")}`,
    `SHIFT_END=${map.get("SHIFT_END")}`,
    `SHIFT_SHADOW_ROWS=${map.get("SHIFT_SHADOW_ROWS")}`,
    `SHIFT_SHADOW_OUTSIDE_ROWS=${map.get("SHIFT_SHADOW_OUTSIDE_ROWS")}`,
    `SHIFT_HOURS=${map.get("SHIFT_HOURS")}`,
    `SHIFT_HOURS_WITH_SHADOW=${map.get("SHIFT_HOURS_WITH_SHADOW")}`,
    `SHIFT_HOURS_WITHOUT_SHADOW=${map.get("SHIFT_HOURS_WITHOUT_SHADOW")}`,
    `SHIFT_PRODUCTION_CREATED_OPS=${map.get("SHIFT_PRODUCTION_CREATED_OPS")}`,
    `SHIFT_WORKDATE_OPS=${map.get("SHIFT_WORKDATE_OPS")}`,
    `SHIFT_COVERAGE=${shiftCoverage}`,
    "PSR_P2_DUAL_WRITE_STARTED=NO",
    "SOAK_COMPLETE=NO",
    "SHADOW_SOAK_EVIDENCE_OK",
  ];

  return { ok: true, markers };
}
