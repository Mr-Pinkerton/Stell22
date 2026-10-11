import { describe, it } from "vitest";
import { executeOldAppCompatibility } from "@/server/internal/p1-isolated-runner/old-app-compatibility";

describe.skip("NOT EXECUTED: historical application against a database after exact P1", () => {
  it("does not run in this candidate", () => {
    executeOldAppCompatibility();
  });
});
