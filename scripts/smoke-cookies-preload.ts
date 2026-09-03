/**
 * Preload for CLI smoke scripts: mocks `next/headers` so terminal Server Actions
 * can read a synthetic terminal cookie outside a Next request.
 */
import Module from "node:module";
import type { TerminalSessionPayload } from "../src/lib/session";
import {
  SESSION_COOKIE,
  TERMINAL_COOKIE,
  encryptSession,
  encryptTerminalSession,
} from "../src/lib/session";

const cookieJar = new Map<string, string>();

export async function setSmokeTerminalEmployee(employeeId: string): Promise<void> {
  const token = await encryptTerminalSession({ employeeId } satisfies TerminalSessionPayload);
  cookieJar.set(TERMINAL_COOKIE, token);
}

export async function setSmokeAdminUser(userId: string): Promise<void> {
  const token = await encryptSession({ userId, role: "ADMIN" });
  cookieJar.set(SESSION_COOKIE, token);
}

const loader = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
};

const originalLoad = loader._load;

loader._load = function patchedLoad(
  this: unknown,
  request: string,
  parent: unknown,
  isMain: boolean,
) {
  if (request === "next/headers") {
    return {
      cookies: async () => ({
        get: (name: string) => {
          const value = cookieJar.get(name);
          return value ? { name, value } : undefined;
        },
        set: (name: string, value: string) => {
          cookieJar.set(name, value);
        },
        delete: (name: string) => {
          cookieJar.delete(name);
        },
      }),
      headers: async () => new Headers(),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
