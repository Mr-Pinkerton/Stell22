import { describe, expect, it } from "vitest";
import {
  DISPOSABLE_INTEGRATION_STATUS,
  executeOldAppCompatibility,
  OLD_APP_COMPATIBILITY_CASES,
} from "@/server/internal/p1-isolated-runner/old-app-compatibility";

const REQUIRED = [
  "old-checkpoint",
  "database-after-exact-p1",
  "bookkeeping-46",
  "create-batch",
  "request-id-replay",
  "update-batch",
  "provenance-sql-null",
  "business-records",
  "shadow-unchanged",
  "production-cost-flow-unchanged",
  "no-p2-p3-writer",
  "no-app-container-replacement",
  "no-docker-entrypoint",
];

describe("old application compatibility plan", () => {
  it("stays not executed and names every required disposable case", () => {
    expect(DISPOSABLE_INTEGRATION_STATUS).toBe("NOT_EXECUTED");
    expect(OLD_APP_COMPATIBILITY_CASES.map((item) => item.id)).toEqual(REQUIRED);
    expect(() => executeOldAppCompatibility()).toThrow(/NOT EXECUTED/);
  });
});
