import { describe, expect, it } from "vitest";
import {
  CLIENT_REQUEST_ID_MAX_LENGTH,
  CLIENT_REQUEST_ID_REQUIRED,
  CLIENT_REQUEST_ID_TOO_LONG,
  newRequestId,
  requireClientRequestId,
} from "./request-id";

describe("requireClientRequestId", () => {
  it("rejects undefined", () => {
    expect(() => requireClientRequestId(undefined)).toThrow(CLIENT_REQUEST_ID_REQUIRED);
  });

  it("rejects null", () => {
    expect(() => requireClientRequestId(null)).toThrow(CLIENT_REQUEST_ID_REQUIRED);
  });

  it("rejects number and object", () => {
    expect(() => requireClientRequestId(1)).toThrow(CLIENT_REQUEST_ID_REQUIRED);
    expect(() => requireClientRequestId({})).toThrow(CLIENT_REQUEST_ID_REQUIRED);
  });

  it("rejects empty string", () => {
    expect(() => requireClientRequestId("")).toThrow(CLIENT_REQUEST_ID_REQUIRED);
  });

  it("rejects whitespace", () => {
    expect(() => requireClientRequestId("   ")).toThrow(CLIENT_REQUEST_ID_REQUIRED);
    expect(() => requireClientRequestId("\t\n")).toThrow(CLIENT_REQUEST_ID_REQUIRED);
  });

  it("trims surrounding whitespace", () => {
    expect(requireClientRequestId("  abc-1  ")).toBe("abc-1");
  });

  it("accepts exactly 128 characters", () => {
    const id = "a".repeat(CLIENT_REQUEST_ID_MAX_LENGTH);
    expect(requireClientRequestId(id)).toBe(id);
  });

  it("rejects longer than 128", () => {
    expect(() => requireClientRequestId("a".repeat(CLIENT_REQUEST_ID_MAX_LENGTH + 1))).toThrow(
      CLIENT_REQUEST_ID_TOO_LONG,
    );
  });

  it("accepts a normal UUID", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    expect(requireClientRequestId(uuid)).toBe(uuid);
  });

  it("accepts seed: and test: style ids (UUID format not required)", () => {
    expect(requireClientRequestId("seed:hours:emp-1:2026-06-22:0")).toBe(
      "seed:hours:emp-1:2026-06-22:0",
    );
    expect(requireClientRequestId("test:di007:s1")).toBe("test:di007:s1");
  });
});

describe("newRequestId", () => {
  it("returns a non-empty id no longer than 128", () => {
    const id = newRequestId();
    expect(id.length).toBeGreaterThan(0);
    expect(id.length).toBeLessThanOrEqual(CLIENT_REQUEST_ID_MAX_LENGTH);
  });
});
