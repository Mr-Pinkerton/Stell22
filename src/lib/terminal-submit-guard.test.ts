import { describe, expect, it } from "vitest";
import { beginExclusiveSubmit, endExclusiveSubmit } from "./terminal-submit-guard";

describe("beginExclusiveSubmit", () => {
  it("locks the first tap and ignores a second tap before await", () => {
    const lock = { current: false };
    expect(beginExclusiveSubmit(lock)).toBe(true);
    expect(beginExclusiveSubmit(lock)).toBe(false);
    expect(lock.current).toBe(true);
  });

  it("allows a later attempt after the first path ends", () => {
    const lock = { current: false };
    expect(beginExclusiveSubmit(lock)).toBe(true);
    endExclusiveSubmit(lock);
    expect(beginExclusiveSubmit(lock)).toBe(true);
  });
});
