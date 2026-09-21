/**
 * PSR-P2 SHADOW activation control policy.
 *
 * Pure decision logic for the production control workflow. It does not open a
 * database, mutate settings, or reset InventoryMovement rows.
 *
 * Gate activation is not dual-write start. This module never reports
 * PSR-P2 dual-write as started.
 */

export const PINNED_PRODUCTION_APPLICATION_SHA =
  "2d2cbcbdc01ee83cb9103ad8fdaa43ebf8488dcf";

export const SHADOW_ACTIVATION_ACTIONS = ["activate", "deactivate"] as const;

export type ShadowActivationAction = (typeof SHADOW_ACTIVATION_ACTIONS)[number];

export const REQUIRED_WRITER_MIGRATIONS = [
  "20260917150000_psr_p1_inventory_movement_shadow",
  "20260917180000_psr_p2_inventory_movement_recorded_at_timestamptz",
  "20260917200000_psr_p2_r04_supply_stock_accounting_cycle",
  "20260918120000_psr_p2_r05_production_operation_correction",
  "20260918130000_psr_p2_r06_inventory_line_identity",
  "20260920120000_psr_p2_raw_identity_prerequisite",
  "20260920180000_psr_p2_production_quantity_edit_identity",
] as const;

const SETTING_STATES = ["ABSENT", "INACTIVE", "ACTIVE", "MALFORMED"] as const;
type SettingState = (typeof SETTING_STATES)[number];

export type ShadowControlSnapshot = {
  productionAppSha: string;
  shaPin: string;
  setterTree: string;
  setterScriptMatch: string;
  setterSource: string;
  shadowSetting: string;
  costFlowSetting: string;
  authoritativeCount: number;
  shadowCount: number;
  nonemptyEpochCount: number;
  authoritativeNonemptyEpochCount: number;
  inventoryMovementCount: number;
  recordedAtType: string;
  authorityEpochConstraint: string;
  supplyGenerationColumn: string;
  r05Table: string;
  r06Index: string;
  rawTables: string;
  inventoryMovementTable: string;
  p2Table: string;
  p2FkCount: number;
  p2RequestIdUnique: string;
  migrations: Record<string, string>;
};

export type PolicyRefusal = { ok: false; code: string };

export type PrecheckDecision =
  | {
      ok: true;
      cliState: "on" | "off";
      expectedPrior: "ABSENT_OR_INACTIVE" | "ACTIVE";
      dualWriteStarted: "NO";
    }
  | PolicyRefusal;

export type PostDecision =
  | { ok: true; dualWriteStarted: "NO"; shadowGate: "ACTIVATED" | "DEACTIVATED" }
  | PolicyRefusal;

export type VerifyActiveDecision =
  | {
      ok: true;
      shadowGateActivated: "YES";
      dualWriteStarted: "NO";
      shadowRowEvidence: "ABSENT" | "PRESENT";
      shadowCount: number;
      authoritativeCount: number;
      nonemptyEpochCount: number;
      costFlowSetting: string;
      productionAppSha: string;
    }
  | PolicyRefusal;

const SHA_RE = /^[0-9a-f]{40}$/;
const MARKER_RE = /^SHADOW_CTRL ([A-Za-z0-9_]+)=([A-Za-z0-9_]+)$/;

function migrationKey(name: string): string {
  return `MIGRATION_${name}`;
}

function parseCount(value: string | undefined, code: string): number | PolicyRefusal {
  if (value === undefined || !/^[0-9]+$/.test(value)) return { ok: false, code };
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return { ok: false, code };
  return parsed;
}

function isRefusal(value: number | PolicyRefusal): value is PolicyRefusal {
  return typeof value !== "number";
}

export function parseShadowControlSnapshot(text: string): ShadowControlSnapshot | PolicyRefusal {
  const values = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || !line.startsWith("SHADOW_CTRL ")) continue;
    const match = MARKER_RE.exec(line);
    if (!match) return { ok: false, code: "SNAPSHOT_INVALID" };
    const key = match[1];
    const value = match[2];
    if (key === undefined || value === undefined) return { ok: false, code: "SNAPSHOT_INVALID" };
    if (values.has(key)) return { ok: false, code: "SNAPSHOT_INVALID" };
    values.set(key, value);
  }

  const need = (key: string): string | PolicyRefusal => {
    const value = values.get(key);
    if (value === undefined) return { ok: false, code: "SNAPSHOT_INVALID" };
    return value;
  };

  const productionAppSha = need("PRODUCTION_APP_SHA");
  const shaPin = need("SHA_PIN");
  const setterTree = need("SETTER_TREE");
  const setterScriptMatch = need("SETTER_SCRIPT_MATCH");
  const setterSource = need("SETTER_SOURCE");
  const shadowSetting = need("SHADOW_SETTING");
  const costFlowSetting = need("COST_FLOW_SETTING");
  const recordedAtType = need("RECORDED_AT_TYPE");
  const authorityEpochConstraint = need("AUTHORITY_EPOCH_CONSTRAINT");
  const supplyGenerationColumn = need("SUPPLY_GENERATION_COLUMN");
  const r05Table = need("R05_TABLE");
  const r06Index = need("R06_INDEX");
  const rawTables = need("RAW_TABLES");
  const inventoryMovementTable = need("INVENTORY_MOVEMENT_TABLE");
  const p2Table = need("P2_TABLE");
  const p2RequestIdUnique = need("P2_REQUEST_ID_UNIQUE");
  if (
    typeof productionAppSha !== "string" ||
    typeof shaPin !== "string" ||
    typeof setterTree !== "string" ||
    typeof setterScriptMatch !== "string" ||
    typeof setterSource !== "string" ||
    typeof shadowSetting !== "string" ||
    typeof costFlowSetting !== "string" ||
    typeof recordedAtType !== "string" ||
    typeof authorityEpochConstraint !== "string" ||
    typeof supplyGenerationColumn !== "string" ||
    typeof r05Table !== "string" ||
    typeof r06Index !== "string" ||
    typeof rawTables !== "string" ||
    typeof inventoryMovementTable !== "string" ||
    typeof p2Table !== "string" ||
    typeof p2RequestIdUnique !== "string"
  ) {
    return { ok: false, code: "SNAPSHOT_INVALID" };
  }

  const authoritativeCount = parseCount(values.get("AUTHORITATIVE_COUNT"), "SNAPSHOT_INVALID");
  const shadowCount = parseCount(values.get("SHADOW_COUNT"), "SNAPSHOT_INVALID");
  const nonemptyEpochCount = parseCount(values.get("NONEMPTY_EPOCH_COUNT"), "SNAPSHOT_INVALID");
  const authoritativeNonemptyEpochCount = parseCount(
    values.get("AUTHORITATIVE_NONEMPTY_EPOCH_COUNT"),
    "SNAPSHOT_INVALID",
  );
  const inventoryMovementCount = parseCount(
    values.get("INVENTORY_MOVEMENT_COUNT"),
    "SNAPSHOT_INVALID",
  );
  const p2FkCount = parseCount(values.get("P2_FK_COUNT"), "SNAPSHOT_INVALID");
  if (
    isRefusal(authoritativeCount) ||
    isRefusal(shadowCount) ||
    isRefusal(nonemptyEpochCount) ||
    isRefusal(authoritativeNonemptyEpochCount) ||
    isRefusal(inventoryMovementCount) ||
    isRefusal(p2FkCount)
  ) {
    return { ok: false, code: "SNAPSHOT_INVALID" };
  }

  const migrations: Record<string, string> = {};
  for (const name of REQUIRED_WRITER_MIGRATIONS) {
    const value = values.get(migrationKey(name));
    if (value === undefined) return { ok: false, code: "SNAPSHOT_INVALID" };
    migrations[name] = value;
  }

  return {
    productionAppSha,
    shaPin,
    setterTree,
    setterScriptMatch,
    setterSource,
    shadowSetting,
    costFlowSetting,
    authoritativeCount,
    shadowCount,
    nonemptyEpochCount,
    authoritativeNonemptyEpochCount,
    inventoryMovementCount,
    recordedAtType,
    authorityEpochConstraint,
    supplyGenerationColumn,
    r05Table,
    r06Index,
    rawTables,
    inventoryMovementTable,
    p2Table,
    p2FkCount,
    p2RequestIdUnique,
    migrations,
  };
}

export function assertSuppliedApplicationPin(supplied: string): { ok: true } | PolicyRefusal {
  if (!SHA_RE.test(supplied)) return { ok: false, code: "SHA_MALFORMED" };
  if (supplied !== PINNED_PRODUCTION_APPLICATION_SHA) return { ok: false, code: "SHA_NOT_PINNED" };
  return { ok: true };
}

function isSettingState(value: string): value is SettingState {
  return (SETTING_STATES as readonly string[]).includes(value);
}

function countsConsistent(snapshot: ShadowControlSnapshot): boolean {
  return snapshot.inventoryMovementCount === snapshot.shadowCount + snapshot.authoritativeCount;
}

function setterPathVerified(snapshot: ShadowControlSnapshot): boolean {
  return (
    snapshot.shaPin === "MATCH" &&
    snapshot.setterTree === "CLEAN" &&
    snapshot.setterScriptMatch === "YES" &&
    snapshot.setterSource === "PRESENT" &&
    snapshot.productionAppSha === PINNED_PRODUCTION_APPLICATION_SHA
  );
}

function schemaReady(snapshot: ShadowControlSnapshot): boolean {
  if (snapshot.recordedAtType !== "TIMESTAMPTZ") return false;
  if (snapshot.authorityEpochConstraint !== "YES") return false;
  if (snapshot.supplyGenerationColumn !== "YES") return false;
  if (snapshot.r05Table !== "EXISTS") return false;
  if (snapshot.r06Index !== "YES") return false;
  if (snapshot.rawTables !== "YES") return false;
  if (snapshot.inventoryMovementTable !== "EXISTS") return false;
  if (snapshot.p2Table !== "EXISTS") return false;
  if (snapshot.p2FkCount !== 0) return false;
  if (snapshot.p2RequestIdUnique !== "YES") return false;
  return REQUIRED_WRITER_MIGRATIONS.every((name) => snapshot.migrations[name] === "APPLIED");
}

function pinMatches(snapshot: ShadowControlSnapshot, expectedSha: string): PolicyRefusal | null {
  const supplied = assertSuppliedApplicationPin(expectedSha);
  if (!supplied.ok) return supplied;
  if (!SHA_RE.test(snapshot.productionAppSha)) return { ok: false, code: "SHA_MALFORMED" };
  if (snapshot.productionAppSha !== expectedSha) return { ok: false, code: "SHA_MISMATCH" };
  if (snapshot.shaPin !== "MATCH") return { ok: false, code: "SHA_MISMATCH" };
  return null;
}

export function evaluateShadowControlPrecheck(input: {
  action: string;
  expectedApplicationSha: string;
  snapshot: ShadowControlSnapshot;
}): PrecheckDecision {
  if (!SHADOW_ACTIVATION_ACTIONS.includes(input.action as ShadowActivationAction)) {
    return { ok: false, code: "UNSUPPORTED_ACTION" };
  }
  const action = input.action as ShadowActivationAction;
  const pin = pinMatches(input.snapshot, input.expectedApplicationSha);
  if (pin) return pin;
  if (!setterPathVerified(input.snapshot)) return { ok: false, code: "SETTER_PATH_UNVERIFIED" };
  if (!countsConsistent(input.snapshot)) return { ok: false, code: "COUNT_INCONSISTENT" };
  if (!isSettingState(input.snapshot.shadowSetting)) return { ok: false, code: "SHADOW_MALFORMED" };
  if (!isSettingState(input.snapshot.costFlowSetting)) {
    return { ok: false, code: "COST_FLOW_MALFORMED" };
  }
  if (input.snapshot.shadowSetting === "MALFORMED") return { ok: false, code: "SHADOW_MALFORMED" };
  if (input.snapshot.costFlowSetting === "MALFORMED") {
    return { ok: false, code: "COST_FLOW_MALFORMED" };
  }

  if (action === "activate") {
    if (!schemaReady(input.snapshot)) return { ok: false, code: "SCHEMA_PREREQUISITE_INVALID" };
    if (input.snapshot.shadowSetting === "ACTIVE") {
      return { ok: false, code: "SHADOW_ALREADY_ACTIVE" };
    }
    if (input.snapshot.costFlowSetting === "ACTIVE") return { ok: false, code: "COST_FLOW_ACTIVE" };
    if (input.snapshot.authoritativeCount !== 0) {
      return { ok: false, code: "AUTHORITATIVE_PRESENT" };
    }
    if (input.snapshot.authoritativeNonemptyEpochCount !== 0) {
      return { ok: false, code: "AUTHORITATIVE_EPOCH_PRESENT" };
    }
    if (input.snapshot.nonemptyEpochCount !== 0) {
      return { ok: false, code: "NONEMPTY_EPOCH_PRESENT" };
    }
    return {
      ok: true,
      cliState: "on",
      expectedPrior: "ABSENT_OR_INACTIVE",
      dualWriteStarted: "NO",
    };
  }

  if (input.snapshot.shadowSetting !== "ACTIVE") return { ok: false, code: "SHADOW_NOT_ACTIVE" };
  return {
    ok: true,
    cliState: "off",
    expectedPrior: "ACTIVE",
    dualWriteStarted: "NO",
  };
}

/**
 * SHADOW rows may increase after the gate is ACTIVE and before this snapshot.
 * A decrease is row loss. Any total-count delta must be exactly the SHADOW delta.
 */
function retainedShadowMovement(
  before: ShadowControlSnapshot,
  after: ShadowControlSnapshot,
): PolicyRefusal | null {
  if (after.productionAppSha !== before.productionAppSha) return { ok: false, code: "SHA_CHANGED" };
  if (after.shadowCount < before.shadowCount) return { ok: false, code: "SHADOW_ROWS_CHANGED" };
  if (after.authoritativeCount !== before.authoritativeCount) {
    return { ok: false, code: "AUTHORITATIVE_CHANGED" };
  }
  if (after.nonemptyEpochCount !== before.nonemptyEpochCount) {
    return { ok: false, code: "EPOCH_CHANGED" };
  }
  if (after.authoritativeNonemptyEpochCount !== before.authoritativeNonemptyEpochCount) {
    return { ok: false, code: "EPOCH_CHANGED" };
  }
  if (after.costFlowSetting !== before.costFlowSetting) {
    return { ok: false, code: "COST_FLOW_CHANGED" };
  }
  if (!countsConsistent(before) || !countsConsistent(after)) {
    return { ok: false, code: "COUNT_INCONSISTENT" };
  }
  const shadowDelta = after.shadowCount - before.shadowCount;
  const totalDelta = after.inventoryMovementCount - before.inventoryMovementCount;
  if (shadowDelta < 0 || totalDelta !== shadowDelta) {
    return { ok: false, code: "COUNT_INCONSISTENT" };
  }
  return null;
}

export function evaluateShadowPostActivate(input: {
  expectedApplicationSha: string;
  before: ShadowControlSnapshot;
  after: ShadowControlSnapshot;
}): PostDecision {
  const pin = pinMatches(input.after, input.expectedApplicationSha);
  if (pin) return pin;
  if (!setterPathVerified(input.after)) return { ok: false, code: "SETTER_PATH_UNVERIFIED" };
  if (!schemaReady(input.after)) return { ok: false, code: "SCHEMA_PREREQUISITE_INVALID" };
  const same = retainedShadowMovement(input.before, input.after);
  if (same) return same;
  if (input.after.shadowSetting !== "ACTIVE") return { ok: false, code: "SHADOW_NOT_ACTIVE" };
  if (input.after.costFlowSetting !== "ABSENT" && input.after.costFlowSetting !== "INACTIVE") {
    return { ok: false, code: "COST_FLOW_CHANGED" };
  }
  if (input.after.authoritativeCount !== 0) return { ok: false, code: "AUTHORITATIVE_PRESENT" };
  if (input.after.authoritativeNonemptyEpochCount !== 0) {
    return { ok: false, code: "AUTHORITATIVE_EPOCH_PRESENT" };
  }
  if (input.after.nonemptyEpochCount !== 0) return { ok: false, code: "NONEMPTY_EPOCH_PRESENT" };
  return { ok: true, dualWriteStarted: "NO", shadowGate: "ACTIVATED" };
}

export function evaluateShadowPostDeactivate(input: {
  expectedApplicationSha: string;
  before: ShadowControlSnapshot;
  after: ShadowControlSnapshot;
}): PostDecision {
  const pin = pinMatches(input.after, input.expectedApplicationSha);
  if (pin) return pin;
  if (!setterPathVerified(input.after)) return { ok: false, code: "SETTER_PATH_UNVERIFIED" };
  if (input.before.shadowSetting !== "ACTIVE") return { ok: false, code: "SHADOW_NOT_ACTIVE" };
  const same = retainedShadowMovement(input.before, input.after);
  if (same) return same;
  if (input.after.shadowSetting !== "INACTIVE") return { ok: false, code: "SHADOW_NOT_INACTIVE" };
  return { ok: true, dualWriteStarted: "NO", shadowGate: "DEACTIVATED" };
}

export function evaluateShadowActiveVerify(input: {
  expectedApplicationSha: string;
  snapshot: ShadowControlSnapshot;
}): VerifyActiveDecision {
  const pin = pinMatches(input.snapshot, input.expectedApplicationSha);
  if (pin) return pin;
  if (!setterPathVerified(input.snapshot)) return { ok: false, code: "SETTER_PATH_UNVERIFIED" };
  if (!schemaReady(input.snapshot)) return { ok: false, code: "SCHEMA_PREREQUISITE_INVALID" };
  if (!countsConsistent(input.snapshot)) return { ok: false, code: "COUNT_INCONSISTENT" };
  if (input.snapshot.shadowSetting !== "ACTIVE") return { ok: false, code: "SHADOW_NOT_ACTIVE" };
  if (input.snapshot.costFlowSetting !== "ABSENT" && input.snapshot.costFlowSetting !== "INACTIVE") {
    return { ok: false, code: "COST_FLOW_NOT_INACTIVE" };
  }
  if (input.snapshot.authoritativeCount !== 0) return { ok: false, code: "AUTHORITATIVE_PRESENT" };
  if (input.snapshot.authoritativeNonemptyEpochCount !== 0) {
    return { ok: false, code: "AUTHORITATIVE_EPOCH_PRESENT" };
  }
  if (input.snapshot.nonemptyEpochCount !== 0) return { ok: false, code: "NONEMPTY_EPOCH_PRESENT" };
  if (input.snapshot.shadowCount < 0) return { ok: false, code: "SNAPSHOT_INVALID" };
  return {
    ok: true,
    shadowGateActivated: "YES",
    dualWriteStarted: "NO",
    shadowRowEvidence: input.snapshot.shadowCount > 0 ? "PRESENT" : "ABSENT",
    shadowCount: input.snapshot.shadowCount,
    authoritativeCount: input.snapshot.authoritativeCount,
    nonemptyEpochCount: input.snapshot.nonemptyEpochCount,
    costFlowSetting: input.snapshot.costFlowSetting,
    productionAppSha: input.snapshot.productionAppSha,
  };
}

export function cliStateForAction(action: string): "on" | "off" | PolicyRefusal {
  if (action === "activate") return "on";
  if (action === "deactivate") return "off";
  return { ok: false, code: "UNSUPPORTED_ACTION" };
}
