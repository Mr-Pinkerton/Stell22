import { describe, expect, it } from "vitest";
import {
  PRISADKA_PHYSICAL_DELETE_BLOCKED,
  TORCOVKA_GENERIC_DELETE_BLOCKED,
  UPAKOVKA_PHYSICAL_DELETE_BLOCKED,
  assertPhysicalProductionDeleteAllowed,
  assertTorcovkaGenericDeleteAllowed,
  isPhysicalProductionOperationType,
  physicalProductionDeleteBlockedMessage,
} from "./production-physical-delete-policy";

describe("assertPhysicalProductionDeleteAllowed", () => {
  it("rejects TORCOVKA with the existing rails containment message", () => {
    expect(() => assertPhysicalProductionDeleteAllowed("TORCOVKA")).toThrow(
      TORCOVKA_GENERIC_DELETE_BLOCKED,
    );
    expect(() => assertTorcovkaGenericDeleteAllowed("TORCOVKA")).toThrow(
      TORCOVKA_GENERIC_DELETE_BLOCKED,
    );
  });

  it("rejects PRISADKA with a type-specific message, not the TORCOVKA rails text", () => {
    expect(() => assertPhysicalProductionDeleteAllowed("PRISADKA")).toThrow(
      PRISADKA_PHYSICAL_DELETE_BLOCKED,
    );
    expect(PRISADKA_PHYSICAL_DELETE_BLOCKED).not.toEqual(TORCOVKA_GENERIC_DELETE_BLOCKED);
    expect(() => assertTorcovkaGenericDeleteAllowed("PRISADKA")).not.toThrow();
  });

  it("rejects UPAKOVKA with a type-specific message, not the TORCOVKA rails text", () => {
    expect(() => assertPhysicalProductionDeleteAllowed("UPAKOVKA")).toThrow(
      UPAKOVKA_PHYSICAL_DELETE_BLOCKED,
    );
    expect(UPAKOVKA_PHYSICAL_DELETE_BLOCKED).not.toEqual(TORCOVKA_GENERIC_DELETE_BLOCKED);
    expect(() => assertTorcovkaGenericDeleteAllowed("UPAKOVKA")).not.toThrow();
  });

  it("allows HOURS", () => {
    expect(() => assertPhysicalProductionDeleteAllowed("HOURS")).not.toThrow();
    expect(physicalProductionDeleteBlockedMessage("HOURS")).toBeNull();
    expect(isPhysicalProductionOperationType("HOURS")).toBe(false);
  });

  it("marks TORCOVKA/PRISADKA/UPAKOVKA as physical", () => {
    expect(isPhysicalProductionOperationType("TORCOVKA")).toBe(true);
    expect(isPhysicalProductionOperationType("PRISADKA")).toBe(true);
    expect(isPhysicalProductionOperationType("UPAKOVKA")).toBe(true);
  });
});
