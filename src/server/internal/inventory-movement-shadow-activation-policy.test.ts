import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  PINNED_PRODUCTION_APPLICATION_SHA,
  REQUIRED_WRITER_MIGRATIONS,
  assertSuppliedApplicationPin,
  evaluateShadowActiveVerify,
  evaluateShadowControlPrecheck,
  evaluateShadowPostActivate,
  evaluateShadowPostDeactivate,
  parseShadowControlSnapshot,
  type ShadowControlSnapshot,
} from "./inventory-movement-shadow-activation-policy";

const GITHUB_MAIN_AT_PACKAGE_START = "693a9f12fe52b7b6babecdf4f8b6d05e1082f7b6";

function snapshotText(overrides: Record<string, string> = {}): string {
  const markers: Record<string, string> = {
    PRODUCTION_APP_SHA: PINNED_PRODUCTION_APPLICATION_SHA,
    SHA_PIN: "MATCH",
    SETTER_TREE: "CLEAN",
    SETTER_SCRIPT_MATCH: "YES",
    SETTER_SOURCE: "PRESENT",
    SHADOW_SETTING: "ABSENT",
    COST_FLOW_SETTING: "ABSENT",
    AUTHORITATIVE_COUNT: "0",
    SHADOW_COUNT: "0",
    NONEMPTY_EPOCH_COUNT: "0",
    AUTHORITATIVE_NONEMPTY_EPOCH_COUNT: "0",
    INVENTORY_MOVEMENT_COUNT: "0",
    RECORDED_AT_TYPE: "TIMESTAMPTZ",
    AUTHORITY_EPOCH_CONSTRAINT: "YES",
    SUPPLY_GENERATION_COLUMN: "YES",
    R05_TABLE: "EXISTS",
    R06_INDEX: "YES",
    RAW_TABLES: "YES",
    INVENTORY_MOVEMENT_TABLE: "EXISTS",
    P2_TABLE: "EXISTS",
    P2_FK_COUNT: "0",
    P2_REQUEST_ID_UNIQUE: "YES",
  };
  for (const name of REQUIRED_WRITER_MIGRATIONS) {
    markers[`MIGRATION_${name}`] = "APPLIED";
  }
  Object.assign(markers, overrides);
  return Object.entries(markers)
    .map(([key, value]) => `SHADOW_CTRL ${key}=${value}`)
    .join("\n");
}

function parsed(overrides: Record<string, string> = {}): ShadowControlSnapshot {
  const result = parseShadowControlSnapshot(snapshotText(overrides));
  if ("ok" in result) throw new Error(result.code);
  return result;
}

describe("SHADOW activation pin", () => {
  it("accepts only the pinned production application SHA", () => {
    expect(assertSuppliedApplicationPin(PINNED_PRODUCTION_APPLICATION_SHA)).toEqual({ ok: true });
  });

  it("refuses GitHub main and malformed SHAs", () => {
    expect(assertSuppliedApplicationPin(GITHUB_MAIN_AT_PACKAGE_START).ok).toBe(false);
    expect(assertSuppliedApplicationPin("main").ok).toBe(false);
    expect(assertSuppliedApplicationPin(PINNED_PRODUCTION_APPLICATION_SHA.toUpperCase()).ok).toBe(
      false,
    );
  });
});

describe("SHADOW activation precheck", () => {
  it("allows first activation from ABSENT without requiring total row count 0 as a special case", () => {
    const decision = evaluateShadowControlPrecheck({
      action: "activate",
      expectedApplicationSha: PINNED_PRODUCTION_APPLICATION_SHA,
      snapshot: parsed(),
    });
    expect(decision).toEqual({
      ok: true,
      cliState: "on",
      expectedPrior: "ABSENT_OR_INACTIVE",
      dualWriteStarted: "NO",
    });
  });

  it("allows later OFF to ON while retained SHADOW diagnostic rows stay", () => {
    const decision = evaluateShadowControlPrecheck({
      action: "activate",
      expectedApplicationSha: PINNED_PRODUCTION_APPLICATION_SHA,
      snapshot: parsed({
        SHADOW_SETTING: "INACTIVE",
        COST_FLOW_SETTING: "INACTIVE",
        SHADOW_COUNT: "4",
        INVENTORY_MOVEMENT_COUNT: "4",
      }),
    });
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.dualWriteStarted).toBe("NO");
  });

  it("fails closed on unsupported actions, active gate, cost flow, authoritative rows, and epoch state", () => {
    const base = {
      expectedApplicationSha: PINNED_PRODUCTION_APPLICATION_SHA,
      snapshot: parsed(),
    };
    expect(evaluateShadowControlPrecheck({ ...base, action: "reset" }).ok).toBe(false);
    expect(
      evaluateShadowControlPrecheck({
        ...base,
        action: "activate",
        snapshot: parsed({ SHADOW_SETTING: "ACTIVE" }),
      }),
    ).toMatchObject({ code: "SHADOW_ALREADY_ACTIVE" });
    expect(
      evaluateShadowControlPrecheck({
        ...base,
        action: "activate",
        snapshot: parsed({ SHADOW_SETTING: "MALFORMED" }),
      }),
    ).toMatchObject({ code: "SHADOW_MALFORMED" });
    expect(
      evaluateShadowControlPrecheck({
        ...base,
        action: "activate",
        snapshot: parsed({ COST_FLOW_SETTING: "ACTIVE" }),
      }),
    ).toMatchObject({ code: "COST_FLOW_ACTIVE" });
    expect(
      evaluateShadowControlPrecheck({
        ...base,
        action: "activate",
        snapshot: parsed({ AUTHORITATIVE_COUNT: "1", INVENTORY_MOVEMENT_COUNT: "1" }),
      }),
    ).toMatchObject({ code: "AUTHORITATIVE_PRESENT" });
    expect(
      evaluateShadowControlPrecheck({
        ...base,
        action: "activate",
        snapshot: parsed({
          SHADOW_COUNT: "1",
          NONEMPTY_EPOCH_COUNT: "1",
          INVENTORY_MOVEMENT_COUNT: "1",
        }),
      }),
    ).toMatchObject({ code: "NONEMPTY_EPOCH_PRESENT" });
    expect(
      evaluateShadowControlPrecheck({
        ...base,
        action: "activate",
        snapshot: parsed({
          PRODUCTION_APP_SHA: GITHUB_MAIN_AT_PACKAGE_START,
          SHA_PIN: "MISMATCH",
        }),
      }),
    ).toMatchObject({ code: "SHA_MISMATCH" });
  });

  it("refuses activation when a writer migration or quantity-edit identity prerequisite is missing", () => {
    expect(
      evaluateShadowControlPrecheck({
        action: "activate",
        expectedApplicationSha: PINNED_PRODUCTION_APPLICATION_SHA,
        snapshot: parsed({
          MIGRATION_20260920180000_psr_p2_production_quantity_edit_identity: "MISSING",
        }),
      }),
    ).toMatchObject({ code: "SCHEMA_PREREQUISITE_INVALID" });
    expect(
      evaluateShadowControlPrecheck({
        action: "activate",
        expectedApplicationSha: PINNED_PRODUCTION_APPLICATION_SHA,
        snapshot: parsed({ P2_REQUEST_ID_UNIQUE: "NO" }),
      }),
    ).toMatchObject({ code: "SCHEMA_PREREQUISITE_INVALID" });
  });

  it("deactivate requires ACTIVE and does not require an empty SHADOW history", () => {
    const decision = evaluateShadowControlPrecheck({
      action: "deactivate",
      expectedApplicationSha: PINNED_PRODUCTION_APPLICATION_SHA,
      snapshot: parsed({
        SHADOW_SETTING: "ACTIVE",
        COST_FLOW_SETTING: "ACTIVE",
        SHADOW_COUNT: "6",
        INVENTORY_MOVEMENT_COUNT: "6",
      }),
    });
    expect(decision).toEqual({
      ok: true,
      cliState: "off",
      expectedPrior: "ACTIVE",
      dualWriteStarted: "NO",
    });
    expect(
      evaluateShadowControlPrecheck({
        action: "deactivate",
        expectedApplicationSha: PINNED_PRODUCTION_APPLICATION_SHA,
        snapshot: parsed({ SHADOW_SETTING: "INACTIVE" }),
      }),
    ).toMatchObject({ code: "SHADOW_NOT_ACTIVE" });
  });
});

describe("SHADOW post-control and active verify", () => {
  it("post-activate proves the gate is on and does not declare dual-write started", () => {
    const before = parsed({ SHADOW_COUNT: "2", INVENTORY_MOVEMENT_COUNT: "2", SHADOW_SETTING: "INACTIVE" });
    const after = parsed({ SHADOW_COUNT: "2", INVENTORY_MOVEMENT_COUNT: "2", SHADOW_SETTING: "ACTIVE" });
    const decision = evaluateShadowPostActivate({
      expectedApplicationSha: PINNED_PRODUCTION_APPLICATION_SHA,
      before,
      after,
    });
    expect(decision).toEqual({ ok: true, dualWriteStarted: "NO", shadowGate: "ACTIVATED" });
  });

  it("post-activate fails if rows, authoritative data, epoch, cost flow, or SHA change", () => {
    const before = parsed();
    expect(
      evaluateShadowPostActivate({
        expectedApplicationSha: PINNED_PRODUCTION_APPLICATION_SHA,
        before,
        after: parsed({ SHADOW_SETTING: "ACTIVE", SHADOW_COUNT: "1", INVENTORY_MOVEMENT_COUNT: "1" }),
      }),
    ).toMatchObject({ code: "SHADOW_ROWS_CHANGED" });
    expect(
      evaluateShadowPostActivate({
        expectedApplicationSha: PINNED_PRODUCTION_APPLICATION_SHA,
        before,
        after: parsed({ SHADOW_SETTING: "ACTIVE", COST_FLOW_SETTING: "ACTIVE" }),
      }),
    ).toMatchObject({ code: "COST_FLOW_CHANGED" });
  });

  it("post-deactivate keeps SHADOW rows and leaves cost flow and authoritative rows unchanged", () => {
    const before = parsed({
      SHADOW_SETTING: "ACTIVE",
      COST_FLOW_SETTING: "ABSENT",
      SHADOW_COUNT: "6",
      INVENTORY_MOVEMENT_COUNT: "6",
    });
    const after = parsed({
      SHADOW_SETTING: "INACTIVE",
      COST_FLOW_SETTING: "ABSENT",
      SHADOW_COUNT: "6",
      INVENTORY_MOVEMENT_COUNT: "6",
    });
    expect(
      evaluateShadowPostDeactivate({
        expectedApplicationSha: PINNED_PRODUCTION_APPLICATION_SHA,
        before,
        after,
      }),
    ).toEqual({ ok: true, dualWriteStarted: "NO", shadowGate: "DEACTIVATED" });
    expect(
      evaluateShadowPostDeactivate({
        expectedApplicationSha: PINNED_PRODUCTION_APPLICATION_SHA,
        before,
        after: parsed({
          SHADOW_SETTING: "INACTIVE",
          SHADOW_COUNT: "0",
          INVENTORY_MOVEMENT_COUNT: "0",
        }),
      }),
    ).toMatchObject({ code: "SHADOW_ROWS_CHANGED" });
  });

  it("active verifier accepts SHADOW count >= 0 and never declares dual-write started", () => {
    const empty = evaluateShadowActiveVerify({
      expectedApplicationSha: PINNED_PRODUCTION_APPLICATION_SHA,
      snapshot: parsed({ SHADOW_SETTING: "ACTIVE" }),
    });
    expect(empty).toMatchObject({
      ok: true,
      shadowGateActivated: "YES",
      dualWriteStarted: "NO",
      shadowRowEvidence: "ABSENT",
      shadowCount: 0,
      authoritativeCount: 0,
      nonemptyEpochCount: 0,
    });
    const retained = evaluateShadowActiveVerify({
      expectedApplicationSha: PINNED_PRODUCTION_APPLICATION_SHA,
      snapshot: parsed({
        SHADOW_SETTING: "ACTIVE",
        SHADOW_COUNT: "3",
        INVENTORY_MOVEMENT_COUNT: "3",
        COST_FLOW_SETTING: "INACTIVE",
      }),
    });
    expect(retained).toMatchObject({
      ok: true,
      dualWriteStarted: "NO",
      shadowRowEvidence: "PRESENT",
      shadowCount: 3,
      authoritativeCount: 0,
    });
    expect(
      evaluateShadowActiveVerify({
        expectedApplicationSha: PINNED_PRODUCTION_APPLICATION_SHA,
        snapshot: parsed({ SHADOW_SETTING: "ABSENT" }),
      }),
    ).toMatchObject({ code: "SHADOW_NOT_ACTIVE" });
  });

  it("ignores log noise and rejects duplicate markers", () => {
    const noisy = parseShadowControlSnapshot(`noise\n${snapshotText()}\nSHADOW_CTRL SNAPSHOT_MODE=READ_ONLY`);
    expect("ok" in noisy).toBe(false);
    const duplicate = parseShadowControlSnapshot(
      `${snapshotText()}\nSHADOW_CTRL SHADOW_SETTING=ACTIVE`,
    );
    expect(duplicate).toMatchObject({ code: "SNAPSHOT_INVALID" });
  });
});

describe("SHADOW activation static control files", () => {
  it("security checker passes", () => {
    execFileSync(process.execPath, ["scripts/security/check-shadow-activation-control.mjs"], {
      cwd: path.join(process.cwd()),
      stdio: "pipe",
    });
  });

  it("apply path is the deployed CLI and deactivate is not reset", () => {
    const apply = fs.readFileSync(
      path.join(process.cwd(), "scripts/shadow-activation-apply-deployed-cli.sh"),
      "utf8",
    );
    expect(apply).toContain("scripts/set-inventory-movement-shadow-write.ts");
    expect(apply).toContain("--confirm=INVENTORY_MOVEMENT_SHADOW_WRITE_CONTROL");
    expect(apply).toContain("--entrypoint ./node_modules/.bin/tsx");
    expect(apply).not.toContain("reset-inventory-movement-shadow");
    expect(apply).not.toContain("production_cost_flow");
  });
});
