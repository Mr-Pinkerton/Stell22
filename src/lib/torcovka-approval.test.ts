import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  approvalCodeMatches,
  formatTorcovkaApprovalMessage,
  generateApprovalCode,
  generateUnusedApprovalCode,
  hashApprovalCode,
  parseApprovalCode,
} from "./torcovka-approval";

const SECRET = "test-session-secret-for-hmac";

describe("generateApprovalCode", () => {
  it("always returns 4 digits, including leading zeros", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const code = generateApprovalCode();
      expect(code).toMatch(/^\d{4}$/);
      seen.add(code);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it("padStart 7 → 0007 is a valid 4-digit code", () => {
    expect(String(7).padStart(4, "0")).toBe("0007");
    expect(parseApprovalCode("0007")).toBe("0007");
    expect(parseApprovalCode("0000")).toBe("0000");
  });
});

describe("parseApprovalCode", () => {
  it("accepts exactly 4 digits and trims", () => {
    expect(parseApprovalCode("1234")).toBe("1234");
    expect(parseApprovalCode(" 4827 ")).toBe("4827");
  });

  it("rejects malformed values", () => {
    expect(parseApprovalCode("12")).toBeNull();
    expect(parseApprovalCode("12345")).toBeNull();
    expect(parseApprovalCode("12a3")).toBeNull();
    expect(parseApprovalCode(1234)).toBeNull();
    expect(parseApprovalCode(null)).toBeNull();
    expect(parseApprovalCode(undefined)).toBeNull();
    expect(parseApprovalCode("")).toBeNull();
  });
});

describe("hashApprovalCode / approvalCodeMatches", () => {
  it("HMAC matches the same code and secret", () => {
    const hash = hashApprovalCode("0007", SECRET);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(approvalCodeMatches("0007", hash, SECRET)).toBe(true);
  });

  it("HMAC mismatch for a different code or secret", () => {
    const hash = hashApprovalCode("0007", SECRET);
    expect(approvalCodeMatches("0008", hash, SECRET)).toBe(false);
    expect(approvalCodeMatches("0007", hash, "other-secret")).toBe(false);
  });

  it("timing-safe helper returns false for a malformed hash and does not throw", () => {
    expect(approvalCodeMatches("1234", "not-hex", SECRET)).toBe(false);
    expect(approvalCodeMatches("1234", "abc", SECRET)).toBe(false);
    expect(approvalCodeMatches("1234", "", SECRET)).toBe(false);
  });
});

describe("formatTorcovkaApprovalMessage", () => {
  it("includes expiry clock and the 4-digit code", () => {
    const expiresAt = new Date("2026-09-05T18:30:00.000Z");
    const message = formatTorcovkaApprovalMessage({
      employeeName: "Иван Петров",
      batchName: "Партия А",
      lotLabel: "L-1",
      railsTaken: 10,
      takenM: "100.0000",
      producedM: "27.0000",
      wasteM: "73.0000",
      wastePct: "73.00",
      code: "0007",
      expiresAt,
    });
    expect(message).toContain("Сотрудник: Иван Петров");
    expect(message).toContain("Код подтверждения: 0007");
    expect(message).toMatch(/Действует до \d{2}:\d{2}/);
    expect(message).not.toMatch(/(?:PIN|ПИН)\s*[:=]/i);
  });
});

describe("generateUnusedApprovalCode", () => {
  it("never returns a code whose HMAC matches the previous hash", () => {
    const previous = "4827";
    const previousHash = hashApprovalCode(previous, SECRET);
    for (let i = 0; i < 50; i++) {
      const code = generateUnusedApprovalCode(previousHash, SECRET);
      expect(code).toMatch(/^\d{4}$/);
      expect(code).not.toBe(previous);
      expect(approvalCodeMatches(code, previousHash, SECRET)).toBe(false);
    }
  });
});

describe("approval code / notification PIN properties", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const libSrc = readFileSync(path.join(here, "torcovka-approval.ts"), "utf8");
  const notifySrc = readFileSync(
    path.join(here, "../server/internal/torcovka-approval.ts"),
    "utf8",
  );

  it("code source is randomInt, not employee.pin", () => {
    expect(libSrc).toContain("randomInt(0, 10000)");
    expect(libSrc).not.toMatch(/employee\.pin/);
    expect(notifySrc).not.toMatch(/employee\.pin|\.pin\b/);
  });

  it("notifyApproval selects Employee.fullName only", () => {
    expect(notifySrc).toMatch(
      /employee\.findUnique\(\{\s*where: \{ id: snapshot\.employeeId \},\s*select: \{ fullName: true \}\s*\}\)/,
    );
    expect(notifySrc).not.toMatch(/select:\s*\{[^}]*pin/);
  });
});
