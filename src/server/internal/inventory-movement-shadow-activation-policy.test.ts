import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  PINNED_PRODUCTION_APPLICATION_SHA,
  REQUIRED_WRITER_MIGRATIONS,
  assertApplySuccessToken,
  assertSnapshotComplete,
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
  const body = Object.entries(markers)
    .map(([key, value]) => `SHADOW_CTRL ${key}=${value}`)
    .join("\n");
  return `${body}\nSHADOW_CTRL SNAPSHOT_MODE=READ_ONLY`;
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

  it("post-activate allows legitimate SHADOW growth and refuses loss or other drift", () => {
    const pin = PINNED_PRODUCTION_APPLICATION_SHA;
    expect(
      evaluateShadowPostActivate({
        expectedApplicationSha: pin,
        before: parsed(),
        after: parsed({ SHADOW_SETTING: "ACTIVE", SHADOW_COUNT: "1", INVENTORY_MOVEMENT_COUNT: "1" }),
      }),
    ).toEqual({ ok: true, dualWriteStarted: "NO", shadowGate: "ACTIVATED" });
    expect(
      evaluateShadowPostActivate({
        expectedApplicationSha: pin,
        before: parsed({
          SHADOW_SETTING: "INACTIVE",
          SHADOW_COUNT: "4",
          INVENTORY_MOVEMENT_COUNT: "4",
        }),
        after: parsed({ SHADOW_SETTING: "ACTIVE", SHADOW_COUNT: "7", INVENTORY_MOVEMENT_COUNT: "7" }),
      }),
    ).toEqual({ ok: true, dualWriteStarted: "NO", shadowGate: "ACTIVATED" });
    expect(
      evaluateShadowPostActivate({
        expectedApplicationSha: pin,
        before: parsed({ SHADOW_COUNT: "2", INVENTORY_MOVEMENT_COUNT: "2" }),
        after: parsed({ SHADOW_SETTING: "ACTIVE", SHADOW_COUNT: "1", INVENTORY_MOVEMENT_COUNT: "1" }),
      }),
    ).toMatchObject({ code: "SHADOW_ROWS_CHANGED" });
    expect(
      evaluateShadowPostActivate({
        expectedApplicationSha: pin,
        before: parsed(),
        after: parsed({
          SHADOW_SETTING: "ACTIVE",
          AUTHORITATIVE_COUNT: "1",
          INVENTORY_MOVEMENT_COUNT: "1",
        }),
      }),
    ).toMatchObject({ code: "AUTHORITATIVE_CHANGED" });
    expect(
      evaluateShadowPostActivate({
        expectedApplicationSha: pin,
        before: parsed(),
        after: parsed({ SHADOW_SETTING: "ACTIVE", NONEMPTY_EPOCH_COUNT: "1" }),
      }),
    ).toMatchObject({ code: "EPOCH_CHANGED" });
    expect(
      evaluateShadowPostActivate({
        expectedApplicationSha: pin,
        before: parsed(),
        after: parsed({
          SHADOW_SETTING: "ACTIVE",
          SHADOW_COUNT: "1",
          AUTHORITATIVE_COUNT: "0",
          INVENTORY_MOVEMENT_COUNT: "2",
        }),
      }),
    ).toMatchObject({ code: "COUNT_INCONSISTENT" });
    expect(
      evaluateShadowPostActivate({
        expectedApplicationSha: pin,
        before: parsed(),
        after: parsed({ SHADOW_SETTING: "ACTIVE", COST_FLOW_SETTING: "ACTIVE" }),
      }),
    ).toMatchObject({ code: "COST_FLOW_CHANGED" });
    expect(
      evaluateShadowPostActivate({
        expectedApplicationSha: pin,
        before: parsed({ PRODUCTION_APP_SHA: GITHUB_MAIN_AT_PACKAGE_START }),
        after: parsed({ SHADOW_SETTING: "ACTIVE" }),
      }),
    ).toMatchObject({ code: "SHA_CHANGED" });
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
        before: parsed({
          SHADOW_SETTING: "ACTIVE",
          SHADOW_COUNT: "5",
          INVENTORY_MOVEMENT_COUNT: "5",
        }),
        after: parsed({
          SHADOW_SETTING: "INACTIVE",
          SHADOW_COUNT: "6",
          INVENTORY_MOVEMENT_COUNT: "6",
        }),
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
    expect(
      evaluateShadowPostDeactivate({
        expectedApplicationSha: PINNED_PRODUCTION_APPLICATION_SHA,
        before: parsed({
          SHADOW_SETTING: "ACTIVE",
          SHADOW_COUNT: "5",
          INVENTORY_MOVEMENT_COUNT: "5",
        }),
        after: parsed({
          SHADOW_SETTING: "INACTIVE",
          SHADOW_COUNT: "5",
          AUTHORITATIVE_COUNT: "1",
          INVENTORY_MOVEMENT_COUNT: "6",
        }),
      }),
    ).toMatchObject({ code: "AUTHORITATIVE_CHANGED" });
    expect(
      evaluateShadowPostDeactivate({
        expectedApplicationSha: PINNED_PRODUCTION_APPLICATION_SHA,
        before: parsed({ SHADOW_SETTING: "ACTIVE", COST_FLOW_SETTING: "INACTIVE" }),
        after: parsed({ SHADOW_SETTING: "INACTIVE", COST_FLOW_SETTING: "ACTIVE" }),
      }),
    ).toMatchObject({ code: "COST_FLOW_CHANGED" });
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
    const noisy = parseShadowControlSnapshot(`noise\n${snapshotText()}\ntrailing log`);
    expect("ok" in noisy).toBe(false);
    const duplicate = parseShadowControlSnapshot(
      `${snapshotText()}\nSHADOW_CTRL SHADOW_SETTING=ACTIVE`,
    );
    expect(duplicate).toMatchObject({ code: "SNAPSHOT_INVALID" });
  });
});

describe("SHADOW activation transport and completion tokens", () => {
  function logicalDockerLines(src: string): string[] {
    return src
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n")
      .replace(/\\\r?\n/g, " ")
      .split("\n")
      .filter((line) => line.includes("docker compose"));
  }

  function assertStdinDetached(src: string): void {
    expect(src).not.toMatch(/(^|\n)\s*exec\s+</);
    for (const line of logicalDockerLines(src)) {
      const dockerAt = line.indexOf("docker compose");
      const piped = line.slice(0, dockerAt).includes("|");
      if (piped) {
        expect(line.slice(0, dockerAt)).toContain("printf");
        expect(line).toContain("psql");
        expect(line).not.toContain("</dev/null");
      } else {
        expect(line).toContain("</dev/null");
      }
    }
  }

  function psqlQueryFlags(line: string): { short: Set<string>; long: Set<string>; variables: string[] } {
    const psqlAt = line.indexOf("psql");
    const invocation = line.slice(psqlAt).split("|")[0] ?? "";
    const tokens = invocation.trim().split(/\s+/);
    const short = new Set<string>();
    const long = new Set<string>();
    const variables: string[] = [];
    for (let i = 1; i < tokens.length; i += 1) {
      const tok = tokens[i] ?? "";
      if (tok === "-v" || tok === "--set" || tok === "--variable") {
        variables.push(tokens[i + 1] ?? "");
        i += 1;
        continue;
      }
      if (tok.startsWith("--")) {
        long.add(tok);
        continue;
      }
      if (/^-[A-Za-z]+$/.test(tok)) {
        for (const ch of tok.slice(1)) short.add(ch);
      }
    }
    return { short, long, variables };
  }

  it("keeps snapshot psql quiet so command tags never reach the strict allowlist", () => {
    const snapshot = fs.readFileSync(
      path.join(process.cwd(), "scripts/shadow-activation-readonly-snapshot.sh"),
      "utf8",
    );
    const queries = logicalDockerLines(snapshot).filter(
      (line) => line.includes("printf") && line.includes("psql"),
    );
    expect(queries).toHaveLength(1);
    const flags = psqlQueryFlags(queries[0] ?? "");
    expect(flags.short.has("X") || flags.long.has("--no-psqlrc")).toBe(true);
    expect(flags.short.has("q") || flags.long.has("--quiet")).toBe(true);
    expect(flags.short.has("A") || flags.long.has("--no-align")).toBe(true);
    expect(flags.short.has("t") || flags.long.has("--tuples-only")).toBe(true);
    expect(flags.variables).toContain("ON_ERROR_STOP=1");
    expect(snapshot).toContain("BEGIN TRANSACTION READ ONLY;");
    expect(snapshot).toContain("\nCOMMIT;");

    const parserAt = snapshot.indexOf("while IFS= read -r line");
    expect(parserAt).toBeGreaterThan(0);
    const parser = snapshot.slice(parserAt);
    const pattern = "^[A-Za-z0-9_]+=[A-Za-z0-9_]+$";
    expect(parser).toContain(pattern);
    expect(parser).toContain("SNAPSHOT_LINE_REJECTED");
    expect(parser).toContain("exit 1");
    for (const tag of ["BEGIN", "COMMIT", "ROLLBACK", "NOTICE", "WARNING"]) {
      expect(parser).not.toContain(tag);
    }
    const allowlist = new RegExp(pattern);
    for (const rejected of ["BEGIN", "COMMIT", "ROLLBACK", "NOTICE: x", "WARNING: y", "SET"]) {
      expect(allowlist.test(rejected)).toBe(false);
    }
    for (const accepted of [
      "SHADOW_SETTING=ABSENT",
      "COST_FLOW_SETTING=INACTIVE",
      "AUTHORITATIVE_COUNT=0",
    ]) {
      expect(allowlist.test(accepted)).toBe(true);
    }
  });

  it("detaches stdin from non-piped Docker commands and keeps the SQL pipe", () => {
    const snapshot = fs.readFileSync(
      path.join(process.cwd(), "scripts/shadow-activation-readonly-snapshot.sh"),
      "utf8",
    );
    const apply = fs.readFileSync(
      path.join(process.cwd(), "scripts/shadow-activation-apply-deployed-cli.sh"),
      "utf8",
    );
    assertStdinDetached(snapshot);
    assertStdinDetached(apply);
    expect(logicalDockerLines(snapshot)).toHaveLength(2);
    expect(logicalDockerLines(apply)).toHaveLength(4);
  });

  it("requires exactly one snapshot completion token before field parsing", () => {
    expect(assertSnapshotComplete(snapshotText())).toEqual({ ok: true });
    const truncated = snapshotText().replace("\nSHADOW_CTRL SNAPSHOT_MODE=READ_ONLY", "");
    expect(parseShadowControlSnapshot(truncated)).toEqual({
      ok: false,
      code: "SNAPSHOT_INCOMPLETE",
    });
    expect(parseShadowControlSnapshot(`${snapshotText()}\nSHADOW_CTRL SNAPSHOT_MODE=READ_ONLY`)).toEqual({
      ok: false,
      code: "SNAPSHOT_INCOMPLETE",
    });
    expect(parseShadowControlSnapshot("SHADOW_CTRL PRODUCTION_APP_SHA=abc")).toMatchObject({
      code: "SNAPSHOT_INCOMPLETE",
    });
  });

  it("requires exactly one apply success token for the requested state", () => {
    expect(assertApplySuccessToken("noise\nSHADOW_CONTROL_APPLY_OK state=on\n", "on")).toEqual({
      ok: true,
    });
    expect(assertApplySuccessToken("SHADOW_CONTROL_APPLY_OK state=off", "off")).toEqual({ ok: true });
    expect(assertApplySuccessToken("setter finished", "on")).toMatchObject({ code: "APPLY_NOT_PROVEN" });
    expect(assertApplySuccessToken("SHADOW_CONTROL_APPLY_OK state=off", "on")).toMatchObject({
      code: "APPLY_NOT_PROVEN",
    });
    expect(
      assertApplySuccessToken(
        "SHADOW_CONTROL_APPLY_OK state=on\nSHADOW_CONTROL_APPLY_OK state=on",
        "on",
      ),
    ).toMatchObject({ code: "APPLY_NOT_PROVEN" });
    expect(assertApplySuccessToken("SHADOW_CONTROL_APPLY_OK state=maybe", "on")).toMatchObject({
      code: "APPLY_NOT_PROVEN",
    });
  });

  it("exposes manual remediation and does not roll the gate back", () => {
    const control = fs.readFileSync(
      path.join(process.cwd(), ".github/workflows/shadow-activation-control.yml"),
      "utf8",
    );
    const verify = fs.readFileSync(
      path.join(process.cwd(), ".github/workflows/shadow-post-activation-verify.yml"),
      "utf8",
    );
    const deploy = fs.readFileSync(
      path.join(process.cwd(), ".github/workflows/deploy-production.yml"),
      "utf8",
    );
    expect(control.match(/assert-snapshot --snapshot=/g)).toHaveLength(2);
    expect(verify.match(/assert-snapshot --snapshot=/g)).toHaveLength(1);
    expect(control).toContain("assert-apply --output=apply-output.txt");
    const policy = fs.readFileSync(
      path.join(process.cwd(), "src/server/internal/inventory-movement-shadow-activation-policy.ts"),
      "utf8",
    );
    expect(policy).toContain("SHADOW_CONTROL_APPLY_OK state=${cliState}");
    expect(policy).toContain("SNAPSHOT_INCOMPLETE");
    expect(control).toContain("id: apply");
    expect(control).toContain(
      "failure() && (steps.apply.outcome == 'failure' || steps.apply.outcome == 'success')",
    );
    expect(control).toContain("ACTIVATION_STATE_UNCONFIRMED — gate may already be ACTIVE.");
    expect(control).toContain("DEACTIVATION_STATE_UNCONFIRMED — gate state may already have changed.");
    expect(control).toContain("do not retry activation blindly.");
    expect(control).toContain("do not re-activate automatically.");
    expect(control).toContain("NO_AUTOMATIC_ROLLBACK=YES");
    const remediation = control.slice(control.indexOf("Report unconfirmed gate"));
    expect(remediation).not.toContain("shadow-activation-ssh.sh");
    expect(remediation).not.toContain("set-inventory-movement-shadow-write");
    expect(verify).not.toContain("shadow-activation-ssh.sh apply");
    expect(verify).not.toContain("set-inventory-movement-shadow-write");
    expect(deploy).not.toContain("set-inventory-movement-shadow-write");
    expect(deploy).not.toContain("--state=on");
    expect(deploy).not.toContain("--state=off");
  });
});

describe("SHADOW activation static control files", () => {
  it("security checker passes", () => {
    execFileSync(process.execPath, ["scripts/security/check-shadow-activation-control.mjs"], {
      cwd: path.join(process.cwd()),
      stdio: "pipe",
    });
  });

  it("production workflows require canonical main and stay read-only except the deployed CLI", () => {
    const control = fs.readFileSync(
      path.join(process.cwd(), ".github/workflows/shadow-activation-control.yml"),
      "utf8",
    );
    const verify = fs.readFileSync(
      path.join(process.cwd(), ".github/workflows/shadow-post-activation-verify.yml"),
      "utf8",
    );
    const guard = fs.readFileSync(
      path.join(process.cwd(), "scripts/shadow-activation-assert-canonical-main.sh"),
      "utf8",
    );
    const boundary = "github.ref == 'refs/heads/main' && needs.contract.result == 'success'";
    expect(control).toContain(boundary);
    expect(verify).toContain(boundary);
    expect(control.match(/uses: actions\/checkout@v4/g)).toHaveLength(2);
    expect(verify.match(/uses: actions\/checkout@v4/g)).toHaveLength(2);
    expect(control.match(/ref: main/g)?.length).toBeGreaterThanOrEqual(2);
    expect(verify.match(/ref: main/g)?.length).toBeGreaterThanOrEqual(2);
    expect(guard).toContain("git fetch origin main");
    expect(guard).toContain("git rev-parse origin/main");
    expect(guard).toContain("CONTROL_PLANE_CHECKOUT_SHA=");
    expect(guard).toContain("ORIGIN_MAIN_SHA=");
    expect(verify).not.toContain("shadow-activation-ssh.sh apply");
    expect(verify).not.toContain("set-inventory-movement-shadow-write.ts");
    const deploy = fs.readFileSync(
      path.join(process.cwd(), ".github/workflows/deploy-production.yml"),
      "utf8",
    );
    expect(deploy).not.toContain("set-inventory-movement-shadow-write");
    expect(deploy).not.toContain("--state=on");
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
