import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userMovementActorFromAdmin } from "@/server/internal/inventory-movement-actor";

const PRODUCTION_FREEZE = "Синхронизация с маркетплейсами отключена: production freeze.";
const DISPOSABLE_URL = "postgresql://p1iso:secret@127.0.0.1:54321/p1iso_mpfreeze?schema=public";
const PRODUCTION_DATABASE_URL = "postgresql://stell22_app:secret@db:5432/stell22";

const state = vi.hoisted(() => ({
  settings: [] as Array<{ key: string; value: string }>,
  transactions: 0,
  saleWrites: 0,
  productStockTouches: 0,
  httpCalls: 0,
  credentialReads: 0,
  systemLogs: 0,
  productReads: 0,
  saleReads: 0,
  supplyReads: 0,
}));

const http = vi.hoisted(() => ({
  wbSales: vi.fn(),
  wbIncomes: vi.fn(),
  wbStocks: vi.fn(),
  wbOrders: vi.fn(),
  ozonPostings: vi.fn(),
  ozonSupplies: vi.fn(),
  ozonStocks: vi.fn(),
  ozonCancelled: vi.fn(),
}));

vi.mock("@/server/db", () => ({
  prisma: {
    setting: {
      findMany: async () => {
        state.credentialReads += 1;
        return state.settings;
      },
    },
    product: {
      findMany: async () => {
        state.productReads += 1;
        return [{ id: "product-1", skuOzon: "OZ-1", skuWb: "WB-1", status: "ACTIVE" }];
      },
    },
    sale: {
      findFirst: async () => {
        state.saleReads += 1;
        return null;
      },
    },
    supply: {
      findFirst: async () => {
        state.supplyReads += 1;
        return null;
      },
    },
    systemLog: {
      create: async () => {
        state.systemLogs += 1;
        return { id: "log-1" };
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      state.transactions += 1;
      return fn({
        $queryRaw: async () => [],
        setting: { findUnique: async () => null },
        sale: {
          upsert: async () => {
            state.saleWrites += 1;
            return {};
          },
        },
        supply: { findMany: async () => [] },
        mpStock: {
          deleteMany: async () => ({ count: 0 }),
          createMany: async () => ({ count: 0 }),
        },
        changeLog: { create: async () => ({}) },
        productStock: {
          update: async () => {
            state.productStockTouches += 1;
            return {};
          },
          createMany: async () => {
            state.productStockTouches += 1;
            return { count: 0 };
          },
        },
      });
    },
  },
}));

vi.mock("@/server/session", () => ({
  requireAdmin: async () => ({ id: "user-1", name: "Проверка", role: "ADMIN" }),
}));

vi.mock("next/cache", () => ({
  revalidatePath: () => undefined,
}));

vi.mock("@/lib/wb-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/wb-api")>();
  return {
    ...actual,
    fetchWbSalesWithMeta: (...args: unknown[]) => http.wbSales(...args),
    fetchWbIncomes: (...args: unknown[]) => http.wbIncomes(...args),
    fetchWbStocks: (...args: unknown[]) => http.wbStocks(...args),
    fetchWbNmIdMapFromOrders: (...args: unknown[]) => http.wbOrders(...args),
  };
});

vi.mock("@/lib/ozon-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ozon-api")>();
  return {
    ...actual,
    fetchOzonPostings: (...args: unknown[]) => http.ozonPostings(...args),
    fetchOzonSupplyOrders: (...args: unknown[]) => http.ozonSupplies(...args),
    fetchOzonStocks: (...args: unknown[]) => http.ozonStocks(...args),
    fetchOzonCancelledSupplyOrderIds: (...args: unknown[]) => http.ozonCancelled(...args),
  };
});

import { syncMarketplaces } from "@/server/marketplace";
import {
  persistMarketplaceSyncInTransaction,
  syncMarketplacesAsUserInternal,
} from "@/server/internal/marketplace-sync";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const actor = userMovementActorFromAdmin({ id: "user-1", name: "Проверка" });
const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  DATABASE_URL: process.env.DATABASE_URL,
  MARKETPLACE_SYNC_ALLOW: process.env.MARKETPLACE_SYNC_ALLOW,
};

function trackHttp<T>(fn: () => T): T {
  state.httpCalls += 1;
  return fn();
}

function configuredApis() {
  http.wbSales.mockImplementation(() =>
    trackHttp(async () => ({
      sales: [
        {
          date: "2026-01-02T00:00:00.000Z",
          supplierArticle: "WB-1",
          saleID: "API-WB-1",
          finishedPrice: 100,
        },
      ],
      nmIdToSku: new Map<number, string>(),
    })),
  );
  http.wbIncomes.mockImplementation(() => trackHttp(async () => ({ data: [], warnings: [] })));
  http.wbStocks.mockImplementation(() => trackHttp(async () => ({ data: [], warnings: [] })));
  http.wbOrders.mockImplementation(() => trackHttp(async () => new Map<number, string>()));
  http.ozonPostings.mockImplementation(() =>
    trackHttp(async () => [
      {
        posting_number: "API-OZ-1",
        status: "delivered",
        created_at: "2026-01-02T00:00:00.000Z",
        products: [{ offer_id: "OZ-1", quantity: 1, price: "50" }],
      },
    ]),
  );
  http.ozonSupplies.mockImplementation(() => trackHttp(async () => ({ data: [], warnings: [] })));
  http.ozonStocks.mockImplementation(() => trackHttp(async () => []));
  http.ozonCancelled.mockImplementation(() => trackHttp(async () => []));
}

function credentials(input: { wb: boolean; ozon: boolean }) {
  state.settings = [];
  if (input.wb) state.settings.push({ key: "apiCred:wb.token", value: "wb-test-token" });
  if (input.ozon) {
    state.settings.push({ key: "apiCred:ozon.clientId", value: "100" });
    state.settings.push({ key: "apiCred:ozon.apiKey", value: "ozon-test-key" });
  }
}

function mutableEnv(): {
  NODE_ENV?: string;
  DATABASE_URL?: string;
  MARKETPLACE_SYNC_ALLOW?: string;
} {
  return process.env;
}

function useEnv(input: { node: string | null; database: string | null }) {
  const env = mutableEnv();
  if (input.node === null) delete env.NODE_ENV;
  else env.NODE_ENV = input.node;
  if (input.database === null) delete env.DATABASE_URL;
  else env.DATABASE_URL = input.database;
}

function expectUntouched() {
  expect(state.httpCalls).toBe(0);
  expect(state.transactions).toBe(0);
  expect(state.saleWrites).toBe(0);
  expect(state.productStockTouches).toBe(0);
  expect(state.credentialReads).toBe(0);
  expect(state.systemLogs).toBe(0);
  expect(state.productReads).toBe(0);
  expect(state.saleReads).toBe(0);
  expect(state.supplyReads).toBe(0);
}

beforeEach(() => {
  state.settings = [];
  state.transactions = 0;
  state.saleWrites = 0;
  state.productStockTouches = 0;
  state.httpCalls = 0;
  state.credentialReads = 0;
  state.systemLogs = 0;
  state.productReads = 0;
  state.saleReads = 0;
  state.supplyReads = 0;
  delete mutableEnv().MARKETPLACE_SYNC_ALLOW;
  configuredApis();
});

afterEach(() => {
  const env = mutableEnv();
  if (originalEnv.NODE_ENV === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = originalEnv.NODE_ENV;
  if (originalEnv.DATABASE_URL === undefined) delete env.DATABASE_URL;
  else env.DATABASE_URL = originalEnv.DATABASE_URL;
  if (originalEnv.MARKETPLACE_SYNC_ALLOW === undefined) delete env.MARKETPLACE_SYNC_ALLOW;
  else env.MARKETPLACE_SYNC_ALLOW = originalEnv.MARKETPLACE_SYNC_ALLOW;
});

describe("marketplace sync production freeze", () => {
  it("refuses a production runtime before credentials, HTTP, or writes when keys are missing", async () => {
    useEnv({ node: "production", database: DISPOSABLE_URL });
    credentials({ wb: false, ozon: false });
    const result = await syncMarketplacesAsUserInternal(actor);
    expect(result.ok).toBe(false);
    expect(result.error).toBe(PRODUCTION_FREEZE);
    expect(result.salesAdded).toBe(0);
    expectUntouched();
  });

  it("refuses a production runtime when both marketplaces are fully configured", async () => {
    useEnv({ node: "production", database: DISPOSABLE_URL });
    credentials({ wb: true, ozon: true });
    const result = await syncMarketplacesAsUserInternal(actor);
    expect(result.ok).toBe(false);
    expect(result.error).toBe(PRODUCTION_FREEZE);
    expectUntouched();
  });

  it("refuses the production database when the runtime is not production", async () => {
    useEnv({ node: "development", database: PRODUCTION_DATABASE_URL });
    credentials({ wb: true, ozon: true });
    const result = await syncMarketplacesAsUserInternal(actor);
    expect(result.ok).toBe(false);
    expect(result.error).toBe(PRODUCTION_FREEZE);
    expectUntouched();
  });

  it("refuses a direct internal sync call and ignores an allow flag", async () => {
    useEnv({ node: "production", database: PRODUCTION_DATABASE_URL });
    mutableEnv().MARKETPLACE_SYNC_ALLOW = "1";
    credentials({ wb: true, ozon: true });
    const result = await syncMarketplacesAsUserInternal(actor);
    expect(result.ok).toBe(false);
    expect(result.error).toBe(PRODUCTION_FREEZE);
    expectUntouched();
  });

  it("refuses direct persistence on production before any transaction access", async () => {
    useEnv({ node: "test", database: "postgresql://stell22:secret@127.0.0.1:5432/Stell22" });
    let reads = 0;
    const tx = new Proxy(
      {},
      {
        get() {
          reads += 1;
          throw new Error("domain write");
        },
      },
    );
    await expect(
      persistMarketplaceSyncInTransaction(tx as never, {
        actor,
        sales: [
          {
            marketplace: "WB",
            externalId: "API-WB-1",
            sku: "WB-1",
            quantity: 1,
            revenue: 10,
            isReturn: false,
            date: new Date("2026-01-02T00:00:00.000Z"),
          },
        ],
        supplies: [],
        stocks: [],
        ozonCancelledExternalIds: [],
        productIdFor: () => "product-1",
        stockReplace: { wb: true, ozon: true },
        now: new Date("2026-01-02T00:00:00.000Z"),
        sources: { wb: "api", ozon: "api" },
      }),
    ).rejects.toThrow(PRODUCTION_FREEZE);
    expect(reads).toBe(0);
    expectUntouched();
  });

  it("refuses the authenticated sales action before marketplace work", async () => {
    useEnv({ node: "production", database: DISPOSABLE_URL });
    credentials({ wb: true, ozon: true });
    const result = await syncMarketplaces();
    expect(result.ok).toBe(false);
    expect(result.error).toBe(PRODUCTION_FREEZE);
    expectUntouched();
  });

  it("refuses when the runtime identity is missing", async () => {
    useEnv({ node: null, database: DISPOSABLE_URL });
    credentials({ wb: true, ozon: true });
    const result = await syncMarketplacesAsUserInternal(actor);
    expect(result.error).toBe(PRODUCTION_FREEZE);
    expectUntouched();
  });

  it("refuses when the database target is missing or malformed", async () => {
    useEnv({ node: "test", database: null });
    credentials({ wb: true, ozon: true });
    const missing = await syncMarketplacesAsUserInternal(actor);
    expect(missing.error).toBe(PRODUCTION_FREEZE);
    expectUntouched();

    useEnv({ node: "test", database: "not-a-database-url" });
    const malformed = await syncMarketplacesAsUserInternal(actor);
    expect(malformed.error).toBe(PRODUCTION_FREEZE);
    expectUntouched();
  });

  it("still persists a configured sync on a disposable test database", async () => {
    useEnv({ node: "test", database: DISPOSABLE_URL });
    credentials({ wb: true, ozon: true });
    const result = await syncMarketplacesAsUserInternal(actor);
    expect(result.ok).toBe(true);
    expect(result.sources).toEqual({ wb: "api", ozon: "api" });
    expect(state.transactions).toBe(1);
    expect(state.saleWrites).toBe(2);
    expect(state.httpCalls).toBeGreaterThan(0);
  });

  it("keeps the sales screen and the CLI from offering another sync path", () => {
    const page = readFileSync(path.join(root, "src/app/(admin)/sales/page.tsx"), "utf8");
    const view = readFileSync(path.join(root, "src/components/sales/sales-view.tsx"), "utf8");
    const policy = readFileSync(path.join(root, "src/lib/marketplace-sync-production-freeze.ts"), "utf8");
    const cli = readFileSync(path.join(root, "scripts/run-mp-sync.ts"), "utf8");
    const sync = readFileSync(path.join(root, "src/server/internal/marketplace-sync.ts"), "utf8");
    expect(policy).toContain("export function marketplaceSyncProductionFreeze");
    expect(policy).toContain(PRODUCTION_FREEZE);
    expect(page).toContain("marketplaceSyncProductionFreeze");
    expect(page).toContain("syncFrozenMessage");
    expect(view).toContain("syncFrozenMessage");
    expect(sync).toContain("marketplaceSyncProductionFreeze");
    expect(cli).toContain("MP_SYNC_CLI_PHYSICAL_EXECUTION_DISABLED");
    expect(cli).not.toContain("syncMarketplacesAsUserInternal");
    expect(cli).not.toContain("persistMarketplaceSyncInTransaction");
  });
});
