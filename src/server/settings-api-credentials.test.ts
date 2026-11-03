import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "@/lib/password";

const state = vi.hoisted(() => ({
  admin: true,
  passwordHash: "",
  settingsReads: 0,
  transactions: 0,
  upserts: [] as string[],
  logs: [] as Array<{ newValues?: unknown }>,
}));

vi.mock("@/server/session", () => ({
  requireAdmin: async () => {
    if (!state.admin) throw new Error("Требуется сессия администратора");
    return { id: "admin-1", name: "Админ", email: "admin@example.invalid", role: "ADMIN" };
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/server/db", () => ({
  prisma: {
    user: {
      findUnique: async () => ({ passwordHash: state.passwordHash }),
    },
    setting: {
      findMany: async () => {
        state.settingsReads += 1;
        return [
          { key: "apiCred:wb.token", value: "stored-wb-secret" },
          { key: "apiCred:ozon.apiKey", value: "stored-ozon-secret" },
          { key: "apiCred:ozon.clientId", value: "stored-client" },
        ];
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      state.transactions += 1;
      return fn({
        setting: {
          upsert: async (args: { where: { key: string } }) => {
            state.upserts.push(args.where.key);
          },
        },
        changeLog: {
          create: async (args: { data: { newValues?: unknown } }) => {
            state.logs.push(args.data);
          },
        },
      });
    },
  },
}));

import { getApiCredentials, saveApiCredentials, verifyApiCredentialsPassword } from "@/server/settings";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const password = "correct-admin-password";
const wrongPassword = "wrong-admin-password";

beforeAll(async () => {
  state.passwordHash = await hashPassword(password);
});

beforeEach(() => {
  state.admin = true;
  state.settingsReads = 0;
  state.transactions = 0;
  state.upserts = [];
  state.logs = [];
});

describe("API credential authorization", () => {
  it("does not read stored keys when the password is missing", async () => {
    const result = await getApiCredentials();
    expect(result).toEqual({ ok: false, error: "Введите пароль" });
    expect(state.settingsReads).toBe(0);
    expect(JSON.stringify(result)).not.toContain("stored-wb-secret");
  });

  it("does not read stored keys for a wrong password", async () => {
    const result = await verifyApiCredentialsPassword(wrongPassword);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("Неверный пароль");
      expect(result.error).not.toContain(wrongPassword);
    }
    expect(state.settingsReads).toBe(0);
    expect(JSON.stringify(result)).not.toContain("stored-wb-secret");
  });

  it("returns stored keys only after the correct password", async () => {
    const result = await verifyApiCredentialsPassword(password);
    expect(result).toMatchObject({
      ok: true,
      values: {
        "wb.token": "stored-wb-secret",
        "ozon.apiKey": "stored-ozon-secret",
        "ozon.clientId": "stored-client",
      },
    });
    expect(state.settingsReads).toBe(1);
  });

  it("refuses a direct read for a non-admin before opening settings", async () => {
    state.admin = false;
    await expect(getApiCredentials(password)).rejects.toThrow("Требуется сессия администратора");
    expect(state.settingsReads).toBe(0);
  });

  it("does not write when the save password is missing or wrong", async () => {
    const missing = await saveApiCredentials("", { "wb.token": "next-secret" });
    const wrong = await saveApiCredentials(wrongPassword, { "wb.token": "next-secret" });
    expect(missing).toEqual({ ok: false, error: "Введите пароль" });
    expect(wrong).toEqual({ ok: false, error: "Неверный пароль" });
    expect(state.transactions).toBe(0);
    expect(state.upserts).toEqual([]);
    expect(JSON.stringify([missing, wrong])).not.toContain("next-secret");
    expect(JSON.stringify(wrong)).not.toContain(wrongPassword);
  });

  it("updates only the supplied field and logs its name", async () => {
    const result = await saveApiCredentials(password, { "wb.token": "next-wb-secret" });
    expect(result).toEqual({ ok: true });
    expect(state.upserts).toEqual(["apiCred:wb.token"]);
    expect(JSON.stringify(state.logs)).toContain("wb.token");
    expect(JSON.stringify(state.logs)).not.toContain("next-wb-secret");
    expect(JSON.stringify(state.logs)).not.toContain(password);
    expect(JSON.stringify(state.logs)).not.toContain("stored-ozon-secret");
  });

  it("refuses a non-admin save before any write", async () => {
    state.admin = false;
    await expect(saveApiCredentials(password, { "wb.token": "next-secret" })).rejects.toThrow(
      "Требуется сессия администратора",
    );
    expect(state.transactions).toBe(0);
  });
});

describe("settings page payload", () => {
  it("does not load API credential values while rendering settings", () => {
    const page = readFileSync(path.join(root, "src/app/(admin)/settings/page.tsx"), "utf8");
    const view = readFileSync(path.join(root, "src/components/settings/settings-view.tsx"), "utf8");
    expect(page).not.toContain("getApiCredentials");
    expect(page).not.toContain("apiCredentials");
    expect(view).not.toContain("apiCredentials");
    expect(view).toContain("SettingsApiTab");
  });
});
