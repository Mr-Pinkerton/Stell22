import { describe, expect, it } from "vitest";
import { isValidPin, validateActivePin } from "./employee-pin";

describe("isValidPin", () => {
  it("ровно 4 цифры — валиден", () => {
    expect(isValidPin("1234")).toBe(true);
  });

  it("ведущий ноль допустим", () => {
    expect(isValidPin("0123")).toBe(true);
    expect(isValidPin("0000")).toBe(true);
  });

  it("не 4 цифры / не цифры — невалиден", () => {
    expect(isValidPin("")).toBe(false);
    expect(isValidPin("123")).toBe(false);
    expect(isValidPin("12345")).toBe(false);
    expect(isValidPin("12a4")).toBe(false);
    expect(isValidPin(" 123")).toBe(false);
  });
});

describe("validateActivePin", () => {
  it("свободный корректный PIN — ок", () => {
    expect(
      validateActivePin({ pin: "1234", activeEmployees: [{ id: "b", pin: "5678" }] }),
    ).toBeNull();
  });

  it("пустой PIN — required", () => {
    expect(validateActivePin({ pin: "", activeEmployees: [] })).toBe("required");
    expect(validateActivePin({ pin: "   ", activeEmployees: [] })).toBe("required");
  });

  it("неполный/нечисловой PIN — format", () => {
    expect(validateActivePin({ pin: "123", activeEmployees: [] })).toBe("format");
    expect(validateActivePin({ pin: "12a4", activeEmployees: [] })).toBe("format");
  });

  it("PIN с ведущим нулём проходит", () => {
    expect(validateActivePin({ pin: "0123", activeEmployees: [] })).toBeNull();
  });

  it("PIN занят другим активным — duplicate", () => {
    expect(
      validateActivePin({ pin: "1234", activeEmployees: [{ id: "b", pin: "1234" }] }),
    ).toBe("duplicate");
  });

  it("свой же PIN при правке не считается занятым", () => {
    expect(
      validateActivePin({
        pin: "1234",
        selfId: "a",
        activeEmployees: [
          { id: "a", pin: "1234" },
          { id: "b", pin: "5678" },
        ],
      }),
    ).toBeNull();
  });

  it("архивные не мешают: их PIN не в списке активных", () => {
    // Список activeEmployees формирует вызывающий код (status=ACTIVE), поэтому
    // PIN архивного сотрудника не блокирует выдачу того же PIN активному.
    expect(validateActivePin({ pin: "1234", activeEmployees: [] })).toBeNull();
  });

  it("возврат из архива с занятым PIN — duplicate (повторная активация)", () => {
    // A был архивирован с PIN 1234, затем 1234 выдали активному B.
    // Возврат A в ACTIVE должен упереться в уникальность.
    const archivedA = { id: "a", pin: "1234" };
    const activeB = { id: "b", pin: "1234" };
    expect(
      validateActivePin({
        pin: archivedA.pin,
        selfId: archivedA.id,
        activeEmployees: [activeB],
      }),
    ).toBe("duplicate");
  });
});
