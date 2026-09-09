import { describe, expect, it } from "vitest";
import {
  TORCOVKA_GENERIC_DELETE_BLOCKED,
  assertTorcovkaGenericDeleteAllowed,
} from "./torcovka-delete-policy";

describe("assertTorcovkaGenericDeleteAllowed", () => {
  it("rejects generic TORCOVKA delete before any inventory mutation", () => {
    expect(() => assertTorcovkaGenericDeleteAllowed("TORCOVKA")).toThrow(
      TORCOVKA_GENERIC_DELETE_BLOCKED,
    );
  });

  it("allows generic delete of other production types", () => {
    expect(() => assertTorcovkaGenericDeleteAllowed("PRISADKA")).not.toThrow();
    expect(() => assertTorcovkaGenericDeleteAllowed("UPAKOVKA")).not.toThrow();
    expect(() => assertTorcovkaGenericDeleteAllowed("HOURS")).not.toThrow();
  });
});
