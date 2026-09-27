import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { PINNED_PRODUCTION_APPLICATION_SHA } from "@/server/internal/inventory-movement-shadow-activation-policy";
import { evaluateShadowSoakEvidence } from "@/server/internal/inventory-movement-shadow-soak-evidence";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const PIN = PINNED_PRODUCTION_APPLICATION_SHA;

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

function readRepo(rel: string): string {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function extractSoakSql(script: string): string {
  const match = script.match(/<<'SQL'\r?\n([\s\S]*?)\r?\nSQL/);
  if (!match?.[1]) throw new Error("soak SQL heredoc missing");
  return match[1];
}

function causationLines(counts: Partial<Record<(typeof CAUSATION_KINDS)[number], number>>): string[] {
  return CAUSATION_KINDS.map(
    (kind) => `SHADOW_SOAK CAUSATION_${kind}=${counts[kind] ?? 0}`,
  );
}

function bucketLines(prefix: "SHADOW_DAY" | "SHADOW_HOUR", buckets: Record<string, number>): string[] {
  return Object.entries(buckets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, count]) => `SHADOW_SOAK ${prefix}_${key}=${count}`);
}

function snapshot(body: string[]): string {
  return [...body, "SHADOW_SOAK SNAPSHOT_MODE=READ_ONLY", ""].join("\n");
}

function header(extra: string[]): string[] {
  return [
    `SHADOW_SOAK PRODUCTION_APP_SHA=${PIN}`,
    "SHADOW_SOAK SHA_PIN=MATCH",
    "SHADOW_SOAK SHADOW_SETTING=ACTIVE",
    "SHADOW_SOAK COST_FLOW_SETTING=ABSENT",
    "SHADOW_SOAK AUTHORITATIVE_COUNT=0",
    "SHADOW_SOAK NONEMPTY_EPOCH_COUNT=0",
    "SHADOW_SOAK OTHER_AUTHORITY_COUNT=0",
    "SHADOW_SOAK MOVEMENT_TABLE=EXISTS",
    "SHADOW_SOAK PRODUCTION_OPERATION_TABLE=EXISTS",
    "SHADOW_SOAK CORRECTION_TABLE=EXISTS",
    "SHADOW_SOAK QUANTITY_EDIT_TABLE=EXISTS",
    "SHADOW_SOAK RECORDED_AT_TYPE=TIMESTAMPTZ",
    "SHADOW_SOAK EFFECTIVE_AT_TYPE=TIMESTAMP",
    ...extra,
  ];
}

function markerMap(markers: string[]): Map<string, string> {
  return new Map(markers.map((line) => {
    const idx = line.indexOf("=");
    return [line.slice(0, idx), line.slice(idx + 1)];
  }));
}

describe("SHADOW soak evidence policy", () => {
  it("keeps the diagnostic SQL read-only and free of production mutations", () => {
    const script = readRepo("scripts/shadow-soak-evidence-readonly-snapshot.sh");
    const ssh = readRepo("scripts/shadow-soak-evidence-ssh.sh");
    const sql = extractSoakSql(script);
    const forbidden = /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT|COPY|CALL|DO)\b/i;
    expect(sql).toMatch(/BEGIN TRANSACTION READ ONLY;/);
    expect(sql).toMatch(/\nCOMMIT;/);
    expect(forbidden.test(sql)).toBe(false);
    expect(script).not.toMatch(/set-inventory-movement-shadow-write\.ts/);
    expect(script).not.toMatch(/reset-inventory-movement-shadow/);
    expect(script).not.toMatch(/shadow-activation-ssh\.sh/);
    expect(script).not.toMatch(/shadow-activation-apply-deployed-cli/);
    expect(ssh).not.toMatch(/\bapply\b/);
    expect(ssh).not.toMatch(/set-inventory-movement-shadow-write/);
    expect(ssh).not.toMatch(/reset-inventory-movement-shadow/);
    expect(sql).not.toMatch(/employeeId|userId|fullName|actorDisplaySnapshot/);
    expect(sql).toMatch(/"recordedAt"/);
    expect(sql).toMatch(/"effectiveAt"/);
    expect(sql).toMatch(/"createdAt"/);
    expect(sql).toMatch(/"workDate"/);
    expect(sql).toMatch(/PRODUCTION_OPERATION_MUTATION/);
    expect(sql).toMatch(/ProductionOperationCorrection/);
    expect(sql).toMatch(/ProductionOperationQuantityEdit/);
  });

  it("does not start the workflow automatically and pins the application SHA", () => {
    const workflow = readRepo(".github/workflows/shadow-soak-evidence.yml");
    const onBlock = workflow.slice(workflow.indexOf("\non:"), workflow.indexOf("\npermissions:"));
    expect(onBlock).toMatch(/workflow_dispatch:/);
    expect(onBlock).not.toMatch(/\n\s+push:/);
    expect(onBlock).not.toMatch(/\n\s+pull_request:/);
    expect(onBlock).not.toMatch(/\n\s+schedule:/);
    expect(onBlock).not.toMatch(/\n\s+workflow_run:/);
    expect(onBlock).not.toMatch(/\n\s+workflow_call:/);
    expect(workflow).toContain(`PINNED_PRODUCTION_APPLICATION_SHA: ${PIN}`);
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain("scripts/shadow-activation-assert-canonical-main.sh");
    expect(workflow).toContain("scripts/shadow-soak-evidence-ssh.sh");
    expect(workflow).toContain("scripts/shadow-soak-evidence-policy.ts assert-pin");
    expect(workflow).not.toMatch(/shadow-activation-ssh\.sh/);
    expect(workflow).not.toMatch(/set-inventory-movement-shadow-write/);
    expect(workflow).not.toMatch(/reset-inventory-movement-shadow/);
    expect(workflow).not.toMatch(/deploy-production/);
    expect(readRepo(".github/workflows/ci.yml")).toContain("security:shadow-soak-evidence");
  });

  it("reports a fictional full shift without declaring soak complete", () => {
    const days = { "20260923": 11 };
    const hours: Record<string, number> = {
      "20260923T07": 1,
      "20260923T18": 1,
    };
    for (let hour = 8; hour <= 15; hour += 1) {
      hours[`20260923T${String(hour).padStart(2, "0")}`] = hour === 13 ? 2 : 1;
    }
    const result = evaluateShadowSoakEvidence({
      expectedApplicationSha: PIN,
      snapshot: snapshot([
        ...header([
          "SHADOW_SOAK INVENTORY_MOVEMENT_COUNT=11",
          "SHADOW_SOAK SHADOW_COUNT=11",
          "SHADOW_SOAK SHADOW_RECORDED_AT_MIN=20260923T070000000Z",
          "SHADOW_SOAK SHADOW_RECORDED_AT_MAX=20260923T180000000Z",
          "SHADOW_SOAK SHADOW_EFFECTIVE_AT_MIN=20260923T065000000Z",
          "SHADOW_SOAK SHADOW_EFFECTIVE_AT_MAX=20260923T180000000Z",
          "SHADOW_SOAK RECORDED_EFFECTIVE_EQUAL_COUNT=10",
          "SHADOW_SOAK RECORDED_EFFECTIVE_DIFFER_COUNT=1",
          "SHADOW_SOAK RECORDED_MINUS_EFFECTIVE_MIN_MS=0",
          "SHADOW_SOAK RECORDED_MINUS_EFFECTIVE_MAX_MS=600000",
          ...causationLines({
            PRODUCTION_OPERATION: 8,
            BATCH: 1,
            SUPPLY: 1,
            SYSTEM: 1,
          }),
          "SHADOW_SOAK CAUSATION_UNKNOWN=0",
          "SHADOW_SOAK PRODUCTION_OPS_DIRECT=2",
          "SHADOW_SOAK PRODUCTION_OPS_VIA_CORRECTION=0",
          "SHADOW_SOAK PRODUCTION_OPS_VIA_QUANTITY_EDIT=0",
          "SHADOW_SOAK PRODUCTION_OPS_DISTINCT=2",
          "SHADOW_SOAK PRODUCTION_DIRECT_UNMATCHED=0",
          "SHADOW_SOAK PRODUCTION_MUTATION_UNMATCHED=0",
          "SHADOW_SOAK PRODUCTION_MUTATION_AMBIGUOUS=0",
          "SHADOW_SOAK PRODUCTION_CORRECTION_DANGLING=0",
          "SHADOW_SOAK PRODUCTION_QUANTITY_EDIT_DANGLING=0",
          "SHADOW_SOAK SHADOW_DAY_SUM=11",
          "SHADOW_SOAK SHADOW_HOUR_SUM=11",
          "SHADOW_SOAK SHADOW_DAY_BUCKETS=1",
          "SHADOW_SOAK SHADOW_HOUR_BUCKETS=10",
          ...bucketLines("SHADOW_DAY", days),
          ...bucketLines("SHADOW_HOUR", hours),
          "SHADOW_SOAK SHIFT_INTERVAL=PRESENT",
          "SHADOW_SOAK SHIFT_START=20260923T080000Z",
          "SHADOW_SOAK SHIFT_END=20260923T155959Z",
          "SHADOW_SOAK SHIFT_SHADOW_ROWS=9",
          "SHADOW_SOAK SHIFT_SHADOW_OUTSIDE_ROWS=2",
          "SHADOW_SOAK SHIFT_HOURS=8",
          "SHADOW_SOAK SHIFT_HOURS_WITH_SHADOW=8",
          "SHADOW_SOAK SHIFT_HOURS_WITHOUT_SHADOW=0",
          "SHADOW_SOAK SHIFT_PRODUCTION_CREATED_OPS=2",
          "SHADOW_SOAK SHIFT_WORKDATE_OPS=2",
        ]),
      ]),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const markers = markerMap(result.markers);
    expect(markers.get("SOAK_COMPLETE")).toBe("NO");
    expect(markers.get("SHIFT_COVERAGE")).toBe("FULL");
    expect(markers.get("FAMILY_PRODUCTION")).toBe("8");
    expect(markers.get("FAMILY_SUPPLY")).toBe("1");
    expect(markers.get("FAMILY_INVENTORY")).toBe("0");
    expect(markers.get("FAMILY_OTHER")).toBe("2");
    expect(markers.get("PRODUCTION_OPS_DISTINCT")).toBe("2");
    expect(markers.get("SHADOW_RECORDED_AT_MIN")).toBe("20260923T070000000Z");
    expect(markers.get("SHADOW_EFFECTIVE_AT_MIN")).toBe("20260923T065000000Z");
    expect(markers.get("EFFECTIVE_AT_IS_NOT_WRITE_TIME")).toBe("YES");
    expect(result.markers.join("\n")).not.toContain("SOAK_COMPLETE=YES");
    expect(result.markers.join("\n")).not.toContain("op-");
  });

  it("reports a fictional partial shift and rows outside it", () => {
    const result = evaluateShadowSoakEvidence({
      expectedApplicationSha: PIN,
      snapshot: snapshot([
        ...header([
          "SHADOW_SOAK INVENTORY_MOVEMENT_COUNT=3",
          "SHADOW_SOAK SHADOW_COUNT=3",
          "SHADOW_SOAK SHADOW_RECORDED_AT_MIN=20260923T070000000Z",
          "SHADOW_SOAK SHADOW_RECORDED_AT_MAX=20260923T100000000Z",
          "SHADOW_SOAK SHADOW_EFFECTIVE_AT_MIN=20260923T070000000Z",
          "SHADOW_SOAK SHADOW_EFFECTIVE_AT_MAX=20260923T100000000Z",
          "SHADOW_SOAK RECORDED_EFFECTIVE_EQUAL_COUNT=3",
          "SHADOW_SOAK RECORDED_EFFECTIVE_DIFFER_COUNT=0",
          "SHADOW_SOAK RECORDED_MINUS_EFFECTIVE_MIN_MS=0",
          "SHADOW_SOAK RECORDED_MINUS_EFFECTIVE_MAX_MS=0",
          ...causationLines({ PRODUCTION_OPERATION: 2, SUPPLY: 1 }),
          "SHADOW_SOAK CAUSATION_UNKNOWN=0",
          "SHADOW_SOAK PRODUCTION_OPS_DIRECT=1",
          "SHADOW_SOAK PRODUCTION_OPS_VIA_CORRECTION=0",
          "SHADOW_SOAK PRODUCTION_OPS_VIA_QUANTITY_EDIT=0",
          "SHADOW_SOAK PRODUCTION_OPS_DISTINCT=1",
          "SHADOW_SOAK PRODUCTION_DIRECT_UNMATCHED=0",
          "SHADOW_SOAK PRODUCTION_MUTATION_UNMATCHED=0",
          "SHADOW_SOAK PRODUCTION_MUTATION_AMBIGUOUS=0",
          "SHADOW_SOAK PRODUCTION_CORRECTION_DANGLING=0",
          "SHADOW_SOAK PRODUCTION_QUANTITY_EDIT_DANGLING=0",
          "SHADOW_SOAK SHADOW_DAY_SUM=3",
          "SHADOW_SOAK SHADOW_HOUR_SUM=3",
          "SHADOW_SOAK SHADOW_DAY_BUCKETS=1",
          "SHADOW_SOAK SHADOW_HOUR_BUCKETS=3",
          ...bucketLines("SHADOW_DAY", { "20260923": 3 }),
          ...bucketLines("SHADOW_HOUR", {
            "20260923T07": 1,
            "20260923T09": 1,
            "20260923T10": 1,
          }),
          "SHADOW_SOAK SHIFT_INTERVAL=PRESENT",
          "SHADOW_SOAK SHIFT_START=20260923T080000Z",
          "SHADOW_SOAK SHIFT_END=20260923T155959Z",
          "SHADOW_SOAK SHIFT_SHADOW_ROWS=2",
          "SHADOW_SOAK SHIFT_SHADOW_OUTSIDE_ROWS=1",
          "SHADOW_SOAK SHIFT_HOURS=8",
          "SHADOW_SOAK SHIFT_HOURS_WITH_SHADOW=2",
          "SHADOW_SOAK SHIFT_HOURS_WITHOUT_SHADOW=6",
          "SHADOW_SOAK SHIFT_PRODUCTION_CREATED_OPS=1",
          "SHADOW_SOAK SHIFT_WORKDATE_OPS=1",
        ]),
      ]),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const markers = markerMap(result.markers);
    expect(markers.get("SHIFT_COVERAGE")).toBe("PARTIAL");
    expect(markers.get("SHIFT_SHADOW_OUTSIDE_ROWS")).toBe("1");
    expect(markers.get("FAMILY_PRODUCTION")).toBe("2");
    expect(markers.get("FAMILY_SUPPLY")).toBe("1");
    expect(markers.get("SOAK_COMPLETE")).toBe("NO");
  });

  it("keeps an empty period and a missing shift interval closed", () => {
    const empty = evaluateShadowSoakEvidence({
      expectedApplicationSha: PIN,
      snapshot: snapshot([
        ...header([
          "SHADOW_SOAK INVENTORY_MOVEMENT_COUNT=0",
          "SHADOW_SOAK SHADOW_COUNT=0",
          "SHADOW_SOAK SHADOW_RECORDED_AT_MIN=NONE",
          "SHADOW_SOAK SHADOW_RECORDED_AT_MAX=NONE",
          "SHADOW_SOAK SHADOW_EFFECTIVE_AT_MIN=NONE",
          "SHADOW_SOAK SHADOW_EFFECTIVE_AT_MAX=NONE",
          "SHADOW_SOAK RECORDED_EFFECTIVE_EQUAL_COUNT=0",
          "SHADOW_SOAK RECORDED_EFFECTIVE_DIFFER_COUNT=0",
          "SHADOW_SOAK RECORDED_MINUS_EFFECTIVE_MIN_MS=NONE",
          "SHADOW_SOAK RECORDED_MINUS_EFFECTIVE_MAX_MS=NONE",
          ...causationLines({}),
          "SHADOW_SOAK CAUSATION_UNKNOWN=0",
          "SHADOW_SOAK PRODUCTION_OPS_DIRECT=0",
          "SHADOW_SOAK PRODUCTION_OPS_VIA_CORRECTION=0",
          "SHADOW_SOAK PRODUCTION_OPS_VIA_QUANTITY_EDIT=0",
          "SHADOW_SOAK PRODUCTION_OPS_DISTINCT=0",
          "SHADOW_SOAK PRODUCTION_DIRECT_UNMATCHED=0",
          "SHADOW_SOAK PRODUCTION_MUTATION_UNMATCHED=0",
          "SHADOW_SOAK PRODUCTION_MUTATION_AMBIGUOUS=0",
          "SHADOW_SOAK PRODUCTION_CORRECTION_DANGLING=0",
          "SHADOW_SOAK PRODUCTION_QUANTITY_EDIT_DANGLING=0",
          "SHADOW_SOAK SHADOW_DAY_SUM=0",
          "SHADOW_SOAK SHADOW_HOUR_SUM=0",
          "SHADOW_SOAK SHADOW_DAY_BUCKETS=0",
          "SHADOW_SOAK SHADOW_HOUR_BUCKETS=0",
          "SHADOW_SOAK SHIFT_INTERVAL=ABSENT",
          "SHADOW_SOAK SHIFT_START=NONE",
          "SHADOW_SOAK SHIFT_END=NONE",
          "SHADOW_SOAK SHIFT_SHADOW_ROWS=NONE",
          "SHADOW_SOAK SHIFT_SHADOW_OUTSIDE_ROWS=NONE",
          "SHADOW_SOAK SHIFT_HOURS=NONE",
          "SHADOW_SOAK SHIFT_HOURS_WITH_SHADOW=NONE",
          "SHADOW_SOAK SHIFT_HOURS_WITHOUT_SHADOW=NONE",
          "SHADOW_SOAK SHIFT_PRODUCTION_CREATED_OPS=NONE",
          "SHADOW_SOAK SHIFT_WORKDATE_OPS=NONE",
        ]),
      ]),
    });
    expect(empty.ok).toBe(true);
    if (!empty.ok) return;
    const markers = markerMap(empty.markers);
    expect(markers.get("SHADOW_COUNT")).toBe("0");
    expect(markers.get("SHADOW_RECORDED_AT_MIN")).toBe("NONE");
    expect(markers.get("SHIFT_COVERAGE")).toBe("NOT_EVALUATED");
    expect(markers.get("SOAK_COMPLETE")).toBe("NO");

    const emptyShift = evaluateShadowSoakEvidence({
      expectedApplicationSha: PIN,
      snapshot: snapshot([
        ...header([
          "SHADOW_SOAK INVENTORY_MOVEMENT_COUNT=0",
          "SHADOW_SOAK SHADOW_COUNT=0",
          "SHADOW_SOAK SHADOW_RECORDED_AT_MIN=NONE",
          "SHADOW_SOAK SHADOW_RECORDED_AT_MAX=NONE",
          "SHADOW_SOAK SHADOW_EFFECTIVE_AT_MIN=NONE",
          "SHADOW_SOAK SHADOW_EFFECTIVE_AT_MAX=NONE",
          "SHADOW_SOAK RECORDED_EFFECTIVE_EQUAL_COUNT=0",
          "SHADOW_SOAK RECORDED_EFFECTIVE_DIFFER_COUNT=0",
          "SHADOW_SOAK RECORDED_MINUS_EFFECTIVE_MIN_MS=NONE",
          "SHADOW_SOAK RECORDED_MINUS_EFFECTIVE_MAX_MS=NONE",
          ...causationLines({}),
          "SHADOW_SOAK CAUSATION_UNKNOWN=0",
          "SHADOW_SOAK PRODUCTION_OPS_DIRECT=0",
          "SHADOW_SOAK PRODUCTION_OPS_VIA_CORRECTION=0",
          "SHADOW_SOAK PRODUCTION_OPS_VIA_QUANTITY_EDIT=0",
          "SHADOW_SOAK PRODUCTION_OPS_DISTINCT=0",
          "SHADOW_SOAK PRODUCTION_DIRECT_UNMATCHED=0",
          "SHADOW_SOAK PRODUCTION_MUTATION_UNMATCHED=0",
          "SHADOW_SOAK PRODUCTION_MUTATION_AMBIGUOUS=0",
          "SHADOW_SOAK PRODUCTION_CORRECTION_DANGLING=0",
          "SHADOW_SOAK PRODUCTION_QUANTITY_EDIT_DANGLING=0",
          "SHADOW_SOAK SHADOW_DAY_SUM=0",
          "SHADOW_SOAK SHADOW_HOUR_SUM=0",
          "SHADOW_SOAK SHADOW_DAY_BUCKETS=0",
          "SHADOW_SOAK SHADOW_HOUR_BUCKETS=0",
          "SHADOW_SOAK SHIFT_INTERVAL=PRESENT",
          "SHADOW_SOAK SHIFT_START=20260923T080000Z",
          "SHADOW_SOAK SHIFT_END=20260923T155959Z",
          "SHADOW_SOAK SHIFT_SHADOW_ROWS=0",
          "SHADOW_SOAK SHIFT_SHADOW_OUTSIDE_ROWS=0",
          "SHADOW_SOAK SHIFT_HOURS=8",
          "SHADOW_SOAK SHIFT_HOURS_WITH_SHADOW=0",
          "SHADOW_SOAK SHIFT_HOURS_WITHOUT_SHADOW=8",
          "SHADOW_SOAK SHIFT_PRODUCTION_CREATED_OPS=0",
          "SHADOW_SOAK SHIFT_WORKDATE_OPS=0",
        ]),
      ]),
    });
    expect(emptyShift.ok).toBe(true);
    if (!emptyShift.ok) return;
    expect(markerMap(emptyShift.markers).get("SHIFT_COVERAGE")).toBe("EMPTY");
  });

  it("fails closed on invalid output, mixed sums, and a bypassed application SHA", () => {
    const validBody = header([
      "SHADOW_SOAK INVENTORY_MOVEMENT_COUNT=0",
      "SHADOW_SOAK SHADOW_COUNT=0",
      "SHADOW_SOAK SHADOW_RECORDED_AT_MIN=NONE",
      "SHADOW_SOAK SHADOW_RECORDED_AT_MAX=NONE",
      "SHADOW_SOAK SHADOW_EFFECTIVE_AT_MIN=NONE",
      "SHADOW_SOAK SHADOW_EFFECTIVE_AT_MAX=NONE",
      "SHADOW_SOAK RECORDED_EFFECTIVE_EQUAL_COUNT=0",
      "SHADOW_SOAK RECORDED_EFFECTIVE_DIFFER_COUNT=0",
      "SHADOW_SOAK RECORDED_MINUS_EFFECTIVE_MIN_MS=NONE",
      "SHADOW_SOAK RECORDED_MINUS_EFFECTIVE_MAX_MS=NONE",
      ...causationLines({}),
      "SHADOW_SOAK CAUSATION_UNKNOWN=0",
      "SHADOW_SOAK PRODUCTION_OPS_DIRECT=0",
      "SHADOW_SOAK PRODUCTION_OPS_VIA_CORRECTION=0",
      "SHADOW_SOAK PRODUCTION_OPS_VIA_QUANTITY_EDIT=0",
      "SHADOW_SOAK PRODUCTION_OPS_DISTINCT=0",
      "SHADOW_SOAK PRODUCTION_DIRECT_UNMATCHED=0",
      "SHADOW_SOAK PRODUCTION_MUTATION_UNMATCHED=0",
      "SHADOW_SOAK PRODUCTION_MUTATION_AMBIGUOUS=0",
      "SHADOW_SOAK PRODUCTION_CORRECTION_DANGLING=0",
      "SHADOW_SOAK PRODUCTION_QUANTITY_EDIT_DANGLING=0",
      "SHADOW_SOAK SHADOW_DAY_SUM=0",
      "SHADOW_SOAK SHADOW_HOUR_SUM=0",
      "SHADOW_SOAK SHADOW_DAY_BUCKETS=0",
      "SHADOW_SOAK SHADOW_HOUR_BUCKETS=0",
      "SHADOW_SOAK SHIFT_INTERVAL=ABSENT",
      "SHADOW_SOAK SHIFT_START=NONE",
      "SHADOW_SOAK SHIFT_END=NONE",
      "SHADOW_SOAK SHIFT_SHADOW_ROWS=NONE",
      "SHADOW_SOAK SHIFT_SHADOW_OUTSIDE_ROWS=NONE",
      "SHADOW_SOAK SHIFT_HOURS=NONE",
      "SHADOW_SOAK SHIFT_HOURS_WITH_SHADOW=NONE",
      "SHADOW_SOAK SHIFT_HOURS_WITHOUT_SHADOW=NONE",
      "SHADOW_SOAK SHIFT_PRODUCTION_CREATED_OPS=NONE",
      "SHADOW_SOAK SHIFT_WORKDATE_OPS=NONE",
    ]);

    expect(evaluateShadowSoakEvidence({
      expectedApplicationSha: PIN,
      snapshot: `${snapshot(validBody)}\nBEGIN\n`,
    }).ok).toBe(false);

    expect(evaluateShadowSoakEvidence({
      expectedApplicationSha: PIN,
      snapshot: snapshot([...validBody, "SHADOW_SOAK SHADOW_DAY_SUM=1"]),
    }).ok).toBe(false);

    expect(evaluateShadowSoakEvidence({
      expectedApplicationSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      snapshot: snapshot(validBody),
    })).toEqual({ ok: false, code: "SHA_NOT_PINNED" });

    const forged = snapshot(validBody).replace(PIN, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(evaluateShadowSoakEvidence({
      expectedApplicationSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      snapshot: forged,
    })).toEqual({ ok: false, code: "SHA_NOT_PINNED" });

    const mixed = snapshot(validBody.map((line) => (
      line === "SHADOW_SOAK CAUSATION_SUPPLY=0" ? "SHADOW_SOAK CAUSATION_SUPPLY=4" : line
    )).map((line) => (
      line === "SHADOW_SOAK SHADOW_COUNT=0" ? "SHADOW_SOAK SHADOW_COUNT=4" : line
    )).map((line) => (
      line === "SHADOW_SOAK INVENTORY_MOVEMENT_COUNT=0"
        ? "SHADOW_SOAK INVENTORY_MOVEMENT_COUNT=4"
        : line
    )).map((line) => (
      line === "SHADOW_SOAK PRODUCTION_OPS_DISTINCT=0"
        ? "SHADOW_SOAK PRODUCTION_OPS_DISTINCT=4"
        : line
    )));
    const mixedResult = evaluateShadowSoakEvidence({
      expectedApplicationSha: PIN,
      snapshot: mixed,
    });
    expect(mixedResult.ok).toBe(false);
  });

  it("rejects a UTC day bucket that does not match the recorded instant", () => {
    const result = evaluateShadowSoakEvidence({
      expectedApplicationSha: PIN,
      snapshot: snapshot([
        ...header([
          "SHADOW_SOAK INVENTORY_MOVEMENT_COUNT=1",
          "SHADOW_SOAK SHADOW_COUNT=1",
          "SHADOW_SOAK SHADOW_RECORDED_AT_MIN=20260923T233000000Z",
          "SHADOW_SOAK SHADOW_RECORDED_AT_MAX=20260923T233000000Z",
          "SHADOW_SOAK SHADOW_EFFECTIVE_AT_MIN=20260924T083000000Z",
          "SHADOW_SOAK SHADOW_EFFECTIVE_AT_MAX=20260924T083000000Z",
          "SHADOW_SOAK RECORDED_EFFECTIVE_EQUAL_COUNT=0",
          "SHADOW_SOAK RECORDED_EFFECTIVE_DIFFER_COUNT=1",
          "SHADOW_SOAK RECORDED_MINUS_EFFECTIVE_MIN_MS=M32400000",
          "SHADOW_SOAK RECORDED_MINUS_EFFECTIVE_MAX_MS=M32400000",
          ...causationLines({ PRODUCTION_OPERATION: 1 }),
          "SHADOW_SOAK CAUSATION_UNKNOWN=0",
          "SHADOW_SOAK PRODUCTION_OPS_DIRECT=1",
          "SHADOW_SOAK PRODUCTION_OPS_VIA_CORRECTION=0",
          "SHADOW_SOAK PRODUCTION_OPS_VIA_QUANTITY_EDIT=0",
          "SHADOW_SOAK PRODUCTION_OPS_DISTINCT=1",
          "SHADOW_SOAK PRODUCTION_DIRECT_UNMATCHED=0",
          "SHADOW_SOAK PRODUCTION_MUTATION_UNMATCHED=0",
          "SHADOW_SOAK PRODUCTION_MUTATION_AMBIGUOUS=0",
          "SHADOW_SOAK PRODUCTION_CORRECTION_DANGLING=0",
          "SHADOW_SOAK PRODUCTION_QUANTITY_EDIT_DANGLING=0",
          "SHADOW_SOAK SHADOW_DAY_SUM=1",
          "SHADOW_SOAK SHADOW_HOUR_SUM=1",
          "SHADOW_SOAK SHADOW_DAY_BUCKETS=1",
          "SHADOW_SOAK SHADOW_HOUR_BUCKETS=1",
          "SHADOW_SOAK SHADOW_DAY_20260924=1",
          "SHADOW_SOAK SHADOW_HOUR_20260924T08=1",
          "SHADOW_SOAK SHIFT_INTERVAL=ABSENT",
          "SHADOW_SOAK SHIFT_START=NONE",
          "SHADOW_SOAK SHIFT_END=NONE",
          "SHADOW_SOAK SHIFT_SHADOW_ROWS=NONE",
          "SHADOW_SOAK SHIFT_SHADOW_OUTSIDE_ROWS=NONE",
          "SHADOW_SOAK SHIFT_HOURS=NONE",
          "SHADOW_SOAK SHIFT_HOURS_WITH_SHADOW=NONE",
          "SHADOW_SOAK SHIFT_HOURS_WITHOUT_SHADOW=NONE",
          "SHADOW_SOAK SHIFT_PRODUCTION_CREATED_OPS=NONE",
          "SHADOW_SOAK SHIFT_WORKDATE_OPS=NONE",
        ]),
      ]),
    });
    expect(result).toEqual({ ok: false, code: "TIMESTAMP_BUCKET_MISMATCH" });
  });
});
