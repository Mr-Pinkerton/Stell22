import { describe, expect, it } from "vitest";
import { resolvePinLookup } from "./terminal-auth";

const active = (id: string, pin: string) => ({ id, pin, status: "ACTIVE" });

describe("resolvePinLookup (вход в терминал по PIN)", () => {
  it("один активный с этим PIN — пускаем", () => {
    expect(resolvePinLookup("1234", [active("a", "1234")])).toEqual({
      kind: "ok",
      employeeId: "a",
    });
  });

  it("PIN с ведущим нулём работает", () => {
    expect(resolvePinLookup("0123", [active("a", "0123")])).toEqual({
      kind: "ok",
      employeeId: "a",
    });
  });

  it("никого не нашли — отказ", () => {
    expect(resolvePinLookup("1234", [])).toEqual({ kind: "none" });
  });

  it("архивного не пускаем даже с верным PIN", () => {
    expect(resolvePinLookup("1234", [{ id: "a", pin: "1234", status: "ARCHIVED" }])).toEqual({
      kind: "none",
    });
  });

  it("несколько активных с одним PIN — коллизия, вход запрещён", () => {
    expect(resolvePinLookup("1234", [active("a", "1234"), active("b", "1234")])).toEqual({
      kind: "collision",
      employeeIds: ["a", "b"],
    });
  });

  it("неверный формат PIN — отказ, БД даже не важна", () => {
    expect(resolvePinLookup("123", [active("a", "123")])).toEqual({ kind: "none" });
    expect(resolvePinLookup("", [])).toEqual({ kind: "none" });
    expect(resolvePinLookup("12a4", [active("a", "12a4")])).toEqual({ kind: "none" });
  });

  it("чужой PIN среди кандидатов игнорируется", () => {
    expect(resolvePinLookup("1234", [active("a", "5678")])).toEqual({ kind: "none" });
  });
});
