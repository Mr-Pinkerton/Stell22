import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { userMovementActorFromAdmin } from "@/server/internal/inventory-movement-actor";

const state = vi.hoisted(() => ({
  settings: [] as Array<{ key: string; value: string }>,
  transactions: 0,
  saleIds: [] as string[],
  productStockTouches: 0,
  httpCalls: 0,
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
      findMany: async () => state.settings,
    },
    product: {
      findMany: async () => [{ id: "product-1", skuOzon: "OZ-1", skuWb: "WB-1", status: "ACTIVE" }],
    },
    sale: {
      findFirst: async () => null,
    },
    supply: {
      findFirst: async () => null,
    },
    systemLog: {
      create: async () => ({ id: "log-1" }),
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      state.transactions += 1;
      return fn(fakeTx());
    },
  },
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

import {
  MARKETPLACE_SYNC_CREDENTIALS_REQUIRED,
  MARKETPLACE_SYNC_STUB_REFUSED,
  persistMarketplaceSyncInTransaction,
  syncMarketplacesAsUserInternal,
} from "@/server/internal/marketplace-sync";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const actor = userMovementActorFromAdmin({ id: "user-1", name: "Проверка" });

function trackHttp<T>(fn: () => T): T {
  state.httpCalls += 1;
  return fn();
}

function refuseHttp(label: string) {
  return () => {
    state.httpCalls += 1;
    throw new Error(`${label} unavailable`);
  };
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

function failingApis() {
  http.wbSales.mockImplementation(refuseHttp("WB sales"));
  http.wbIncomes.mockImplementation(refuseHttp("WB incomes"));
  http.wbStocks.mockImplementation(refuseHttp("WB stocks"));
  http.wbOrders.mockImplementation(refuseHttp("WB orders"));
  http.ozonPostings.mockImplementation(refuseHttp("Ozon postings"));
  http.ozonSupplies.mockImplementation(refuseHttp("Ozon supplies"));
  http.ozonStocks.mockImplementation(refuseHttp("Ozon stocks"));
  http.ozonCancelled.mockImplementation(refuseHttp("Ozon cancellations"));
}

function credentials(input: { wb: boolean; ozon: boolean }) {
  state.settings = [];
  if (input.wb) state.settings.push({ key: "apiCred:wb.token", value: "wb-test-token" });
  if (input.ozon) {
    state.settings.push({ key: "apiCred:ozon.clientId", value: "100" });
    state.settings.push({ key: "apiCred:ozon.apiKey", value: "ozon-test-key" });
  }
}

function fakeTx() {
  return {
    $queryRaw: async () => [],
    setting: { findUnique: async () => null },
    sale: {
      upsert: async (args: { create: { externalId: string } }) => {
        state.saleIds.push(args.create.externalId);
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
  };
}

beforeEach(() => {
  state.settings = [];
  state.transactions = 0;
  state.saleIds = [];
  state.productStockTouches = 0;
  state.httpCalls = 0;
  failingApis();
});

describe("marketplace sync fail-closed", () => {
  it("refuses when neither marketplace is configured", async () => {
    credentials({ wb: false, ozon: false });
    const result = await syncMarketplacesAsUserInternal(actor);
    expect(result.ok).toBe(false);
    expect(result.error).toBe(MARKETPLACE_SYNC_CREDENTIALS_REQUIRED);
    expect(state.transactions).toBe(0);
    expect(state.saleIds).toEqual([]);
    expect(state.productStockTouches).toBe(0);
    expect(state.httpCalls).toBe(0);
  });

  it("refuses when only Wildberries is configured", async () => {
    credentials({ wb: true, ozon: false });
    const result = await syncMarketplacesAsUserInternal(actor);
    expect(result.ok).toBe(false);
    expect(result.error).toBe(MARKETPLACE_SYNC_CREDENTIALS_REQUIRED);
    expect(state.transactions).toBe(0);
    expect(state.httpCalls).toBe(0);
  });

  it("refuses when only Ozon is configured", async () => {
    credentials({ wb: false, ozon: true });
    const result = await syncMarketplacesAsUserInternal(actor);
    expect(result.ok).toBe(false);
    expect(result.error).toBe(MARKETPLACE_SYNC_CREDENTIALS_REQUIRED);
    expect(state.transactions).toBe(0);
    expect(state.httpCalls).toBe(0);
  });

  it("does not invent stub rows when every configured fetch fails", async () => {
    credentials({ wb: true, ozon: true });
    const result = await syncMarketplacesAsUserInternal(actor);
    expect(result.ok).toBe(false);
    expect(state.transactions).toBe(0);
    expect(state.saleIds).toEqual([]);
    expect(state.productStockTouches).toBe(0);
    expect(result.salesAdded).toBe(0);
  });

  it("keeps a repeated refusal free of domain writes", async () => {
    credentials({ wb: false, ozon: false });
    await syncMarketplacesAsUserInternal(actor);
    await syncMarketplacesAsUserInternal(actor);
    expect(state.transactions).toBe(0);
    expect(state.saleIds).toEqual([]);
    expect(state.productStockTouches).toBe(0);
  });

  it("keeps the authenticated action and the sales screen from bypassing the guard", () => {
    const action = readFileSync(path.join(root, "src/server/marketplace.ts"), "utf8");
    const screen = readFileSync(path.join(root, "src/components/sales/sales-view.tsx"), "utf8");
    expect(action).toContain("syncMarketplacesAsUserInternal");
    expect(action).not.toContain("persistMarketplaceSyncInTransaction");
    expect(screen).toContain("marketplaceSyncFeedback");
    expect(screen).not.toContain("демо");
  });

  it("keeps the CLI physically disabled", () => {
    const cli = readFileSync(path.join(root, "scripts/run-mp-sync.ts"), "utf8");
    expect(cli).toContain("MP_SYNC_CLI_PHYSICAL_EXECUTION_DISABLED");
    expect(cli).not.toContain("syncMarketplacesAsUserInternal");
  });

  it("persists mocked API rows when both marketplaces are configured", async () => {
    credentials({ wb: true, ozon: true });
    configuredApis();
    const result = await syncMarketplacesAsUserInternal(actor);
    expect(result.ok).toBe(true);
    expect(result.sources).toEqual({ wb: "api", ozon: "api" });
    expect(state.transactions).toBe(1);
    expect(state.saleIds).toEqual(["API-WB-1", "API-OZ-1:OZ-1"]);
    expect(state.productStockTouches).toBe(0);
    expect(state.saleIds.some((id) => id.startsWith("S-") || id.startsWith("R-"))).toBe(false);
  });
});

describe("marketplace sync writer guard", () => {
  it("rejects stub-labeled input before any domain write", async () => {
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
            externalId: "stub-sale",
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
        sources: { wb: "stub", ozon: "stub" },
      }),
    ).rejects.toThrow(MARKETPLACE_SYNC_STUB_REFUSED);
    expect(reads).toBe(0);
  });
});
