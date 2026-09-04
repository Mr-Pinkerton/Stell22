import { describe, expect, it } from "vitest";
import {
  ACCOUNT_NUMBER_BIND_TAKEN,
  ACCOUNT_NUMBER_TAKEN,
  isDuplicateAccountNumber,
  isDuplicateImportKey,
  isRetryableStatementImportConflict,
  prismaUniqueDiscriminator,
  retryOnceOnImportUnique,
  throwFriendlyAccountNumberBindConflict,
  throwFriendlyAccountNumberConflict,
} from "./prisma-unique-conflict";

function p2002(meta: { target?: unknown; constraint?: unknown; modelName?: unknown }, message = "Unique constraint failed"): { code: string; meta: typeof meta; message: string } {
  return { code: "P2002", meta, message };
}

describe("prisma unique discriminators (measured-shape matchers)", () => {
  it("matches Account.accountNumber via field target", () => {
    const err = p2002({ target: ["accountNumber"], modelName: "Account" });
    expect(isDuplicateAccountNumber(err)).toBe(true);
    expect(isDuplicateImportKey(err)).toBe(false);
    expect(isRetryableStatementImportConflict(err)).toBe(true);
  });

  it("matches Account_accountNumber_key index name", () => {
    const err = p2002({ target: "Account_accountNumber_key" });
    expect(isDuplicateAccountNumber(err)).toBe(true);
    expect(prismaUniqueDiscriminator(err)).toContain("Account_accountNumber_key");
  });

  it("matches CashFlow importKey via fields and index name", () => {
    expect(
      isDuplicateImportKey(p2002({ target: ["accountId", "importKey"] })),
    ).toBe(true);
    expect(isDuplicateImportKey(p2002({ constraint: "CashFlow_accountId_importKey_key" }))).toBe(
      true,
    );
    expect(isDuplicateAccountNumber(p2002({ target: ["accountId", "importKey"] }))).toBe(false);
  });

  it("does not retry unrelated P2002 (e.g. clientRequestId)", () => {
    const err = p2002({ target: ["clientRequestId"] });
    expect(isRetryableStatementImportConflict(err)).toBe(false);
  });

  it("maps Account P2002 to a readable error for UI/admin writers", () => {
    expect(() => throwFriendlyAccountNumberConflict(p2002({ target: ["accountNumber"] }))).toThrow(
      ACCOUNT_NUMBER_TAKEN,
    );
    expect(() =>
      throwFriendlyAccountNumberBindConflict(p2002({ target: "Account_accountNumber_key" })),
    ).toThrow(ACCOUNT_NUMBER_BIND_TAKEN);
    expect(() => throwFriendlyAccountNumberConflict(new Error("nope"))).not.toThrow();
  });

  it("retries the whole run once on import unique conflict, on a fresh attempt", async () => {
    let n = 0;
    const result = await retryOnceOnImportUnique(async () => {
      n += 1;
      if (n === 1) throw p2002({ target: ["accountNumber"] });
      return "ok";
    });
    expect(result).toBe("ok");
    expect(n).toBe(2);
  });

  it("does not retry a bind-style friendly error (no auto-merge)", async () => {
    await expect(
      retryOnceOnImportUnique(async () => {
        throw new Error(ACCOUNT_NUMBER_BIND_TAKEN);
      }),
    ).rejects.toThrow(ACCOUNT_NUMBER_BIND_TAKEN);
  });
});
