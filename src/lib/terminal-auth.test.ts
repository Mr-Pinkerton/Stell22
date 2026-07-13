import { describe, expect, it } from "vitest";
import { verifyEmployeePin } from "./terminal-auth";

const active = { pin: "1234", status: "ACTIVE" };

describe("verifyEmployeePin (A14)", () => {
  it("пропускает активного сотрудника с верным PIN", () => {
    expect(verifyEmployeePin(active, "1234")).toBe(true);
  });

  it("отклоняет неверный PIN", () => {
    expect(verifyEmployeePin(active, "0000")).toBe(false);
  });

  it("отклоняет архивного сотрудника даже с верным PIN", () => {
    expect(verifyEmployeePin({ pin: "1234", status: "ARCHIVED" }, "1234")).toBe(false);
  });

  it("отклоняет пустой/короткий/нечисловой PIN", () => {
    expect(verifyEmployeePin(active, "")).toBe(false);
    expect(verifyEmployeePin(active, "123")).toBe(false);
    expect(verifyEmployeePin(active, "12a4")).toBe(false);
  });

  it("отклоняет отсутствующего сотрудника", () => {
    expect(verifyEmployeePin(null, "1234")).toBe(false);
  });
});
