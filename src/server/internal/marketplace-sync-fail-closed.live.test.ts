import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runDisposableMigrate } from "@/server/internal/disposable-migrate/guard";
import { userMovementActorFromAdmin } from "@/server/internal/inventory-movement-actor";

const harness = vi.hoisted(() => ({
  url: "",
  client: null as { $disconnect: () => Promise<void> } | null,
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

vi.mock("@/server/db", async () => {
  const { PrismaClient: Client } = await import("@prisma/client");
  let client: InstanceType<typeof Client> | null = null;
  const prisma = new Proxy({} as InstanceType<typeof Client>, {
    get(_target, prop, receiver) {
      if (!client) {
        if (!harness.url) throw new Error("disposable database is not ready");
        client = new Client({ datasourceUrl: harness.url });
        harness.client = client;
      }
      const value = Reflect.get(client, prop, receiver);
      return typeof value === "function" ? value.bind(client) : value;
    },
  });
  return { prisma };
});

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
  persistMarketplaceSyncInTransaction,
  syncMarketplacesAsUserInternal,
} from "@/server/internal/marketplace-sync";

const LIVE = process.env.P1_DISPOSABLE_LIVE === "1";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const FORBIDDEN_PORTS = new Set(["5432", "5433", "5434"]);
const LOCAL_PG_BIN = "C:\\Program Files\\PostgreSQL\\18\\bin";

function pause(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function reserveLoopbackPort(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("disposable port was not numeric"));
        return;
      }
      const port = String(address.port);
      server.close(() => resolve(port));
    });
  });
}

async function startDisposablePostgres(input: {
  container: string;
  database: string;
  password: string;
  cwd: string;
  markDockerStarted: () => void;
  markLocalDataDir: (dir: string) => void;
}): Promise<string> {
  const created = spawnSync(
    "docker",
    [
      "run", "-d", "--rm", "--name", input.container,
      "-e", "POSTGRES_USER=p1iso",
      "-e", `POSTGRES_PASSWORD=${input.password}`,
      "-e", `POSTGRES_DB=${input.database}`,
      "-p", "127.0.0.1::5432",
      "postgres:17-alpine",
    ],
    { encoding: "utf8", timeout: 20_000 },
  );
  if (created.status === 0) {
    input.markDockerStarted();
    const port = spawnSync(
      "docker",
      ["inspect", "--format", "{{(index (index .NetworkSettings.Ports \"5432/tcp\") 0).HostPort}}", input.container],
      { encoding: "utf8" },
    ).stdout.trim();
    if (!/^[0-9]+$/.test(port) || FORBIDDEN_PORTS.has(port)) {
      throw new Error("disposable port was not an ephemeral loopback port");
    }
    let ready = "";
    for (let attempt = 0; attempt < 30 && ready === ""; attempt += 1) {
      const probe = spawnSync(
        "docker",
        ["exec", "-e", `PGPASSWORD=${input.password}`, input.container, "psql", "-X", "-U", "p1iso", "-d", input.database, "-q", "-At", "-c", "SELECT current_database()"],
        { encoding: "utf8" },
      );
      if (probe.status === 0) ready = probe.stdout.trim();
      else pause(1000);
    }
    if (ready !== input.database) throw new Error("disposable database did not become ready");
    return port;
  }

  if (!fs.existsSync(path.join(LOCAL_PG_BIN, "initdb.exe"))) {
    throw new Error("no disposable PostgreSQL is available");
  }
  const port = await reserveLoopbackPort();
  if (FORBIDDEN_PORTS.has(port)) throw new Error("disposable port was not an ephemeral loopback port");
  const dataDir = path.join(input.cwd, "pgdata");
  const init = spawnSync(
    path.join(LOCAL_PG_BIN, "initdb.exe"),
    ["-D", dataDir, "-U", "p1iso", "-A", "trust", "--encoding", "UTF8"],
    { encoding: "utf8" },
  );
  if (init.status !== 0) {
    throw new Error(`disposable cluster init failed: ${(init.stderr || init.stdout).replaceAll(input.password, "[redacted]").slice(0, 400)}`);
  }
  input.markLocalDataDir(dataDir);
  const started = spawnSync(
    path.join(LOCAL_PG_BIN, "pg_ctl.exe"),
    ["-D", dataDir, "-l", path.join(input.cwd, "pg.log"), "-w", "-t", "30", "start", "-o", `-h 127.0.0.1 -p ${port}`],
    { encoding: "utf8", timeout: 40_000 },
  );
  if (started.status !== 0) {
    throw new Error(`disposable cluster start failed: ${(started.stderr || started.stdout).replaceAll(input.password, "[redacted]").slice(0, 400)}`);
  }
  const psql = path.join(LOCAL_PG_BIN, "psql.exe");
  const env = { ...process.env, PGPASSWORD: input.password, PGCONNECT_TIMEOUT: "5" };
  const createdDb = spawnSync(
    psql,
    ["-X", "-h", "127.0.0.1", "-p", port, "-U", "p1iso", "-d", "postgres", "-q", "-v", "ON_ERROR_STOP=1", "-c", `CREATE DATABASE "${input.database}"`],
    { encoding: "utf8", env, timeout: 15_000, input: "" },
  );
  if (createdDb.status !== 0) {
    throw new Error(`disposable database create failed: ${(createdDb.stderr || createdDb.stdout || "").replaceAll(input.password, "[redacted]").slice(0, 400)}`);
  }
  const identity = spawnSync(
    psql,
    ["-X", "-h", "127.0.0.1", "-p", port, "-U", "p1iso", "-d", input.database, "-q", "-At", "-c", "SELECT current_database()"],
    { encoding: "utf8", env, timeout: 15_000, input: "" },
  );
  if (identity.status !== 0 || identity.stdout.trim() !== input.database) {
    throw new Error("disposable database identity did not match");
  }
  return port;
}

function refuseHttp() {
  return () => {
    throw new Error("configured marketplace API unavailable");
  };
}

function failingApis() {
  http.wbSales.mockImplementation(refuseHttp());
  http.wbIncomes.mockImplementation(refuseHttp());
  http.wbStocks.mockImplementation(refuseHttp());
  http.wbOrders.mockImplementation(refuseHttp());
  http.ozonPostings.mockImplementation(refuseHttp());
  http.ozonSupplies.mockImplementation(refuseHttp());
  http.ozonStocks.mockImplementation(refuseHttp());
  http.ozonCancelled.mockImplementation(refuseHttp());
}

function configuredApis() {
  http.wbSales.mockImplementation(async () => ({
    sales: [
      {
        date: "2026-01-02T00:00:00.000Z",
        supplierArticle: "WB-1",
        saleID: "API-WB-1",
        finishedPrice: 100,
      },
    ],
    nmIdToSku: new Map<number, string>(),
  }));
  http.wbIncomes.mockImplementation(async () => ({
    data: [
      {
        incomeId: 4242,
        number: "API-INC",
        date: "2026-01-02T00:00:00.000Z",
        dateClose: "2026-01-02T00:00:00.000Z",
        supplierArticle: "WB-1",
        quantity: 1,
        status: "ACCEPTED",
      },
    ],
    warnings: [],
  }));
  http.wbStocks.mockImplementation(async () => ({ data: [], warnings: [] }));
  http.wbOrders.mockImplementation(async () => new Map<number, string>());
  http.ozonPostings.mockImplementation(async () => [
    {
      posting_number: "API-OZ-1",
      status: "delivered",
      created_at: "2026-01-02T00:00:00.000Z",
      products: [{ offer_id: "OZ-1", quantity: 1, price: "50" }],
    },
  ]);
  http.ozonSupplies.mockImplementation(async () => ({ data: [], warnings: [] }));
  http.ozonStocks.mockImplementation(async () => []);
  http.ozonCancelled.mockImplementation(async () => []);
}

describe.skipIf(!LIVE)("marketplace sync fail-closed disposable database", () => {
  let runId = "";
  let database = "";
  let password = "";
  let container = "";
  let cwd = "";
  let localDataDir = "";
  let seed: PrismaClient | null = null;
  let started = false;
  let userId = "";
  let productId = "";
  let actor = userMovementActorFromAdmin({ id: "pending", name: "Проверка" });
  let fetchCalls = 0;

  beforeAll(async () => {
    runId = randomBytes(4).toString("hex");
    database = `p1iso_${runId}`;
    password = randomBytes(16).toString("hex");
    container = `p1iso-mp-${runId}`;
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "p1iso-mp-"));
    vi.stubGlobal("fetch", () => {
      fetchCalls += 1;
      throw new Error("live marketplace HTTP is forbidden");
    });
    fs.cpSync(path.join(root, "prisma"), path.join(cwd, "prisma"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".env"), "DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked\n");
    const port = await startDisposablePostgres({
      container,
      database,
      password,
      cwd,
      markDockerStarted: () => {
        started = true;
      },
      markLocalDataDir: (dir) => {
        localDataDir = dir;
      },
    });
    const url = `postgresql://p1iso:${password}@127.0.0.1:${port}/${database}?schema=public`;
    runDisposableMigrate({
      databaseUrl: url,
      cwd,
      schemaPath: path.join(cwd, "prisma", "schema.prisma"),
      repositoryRoot: root,
    });
    harness.url = url;
    seed = new PrismaClient({ datasourceUrl: url });
    const user = await seed.user.create({
      data: { email: `mp-${runId}@example.invalid`, passwordHash: "not-a-password", name: "Проверка" },
    });
    userId = user.id;
    actor = userMovementActorFromAdmin(user);
    const material = await seed.material.create({ data: { name: `Порода ${runId}` } });
    const product = await seed.product.create({
      data: { name: "Изделие", materialId: material.id, skuOzon: "OZ-1", skuWb: "WB-1", sort: "SORT1" },
    });
    productId = product.id;
    await seed.productStock.create({ data: { productId, quantity: 100 } });
  }, 600_000);

  beforeEach(async () => {
    failingApis();
    fetchCalls = 0;
    await seed!.setting.deleteMany({ where: { key: { startsWith: "apiCred:" } } });
    await seed!.sale.deleteMany();
    await seed!.supply.deleteMany();
    await seed!.mpStock.deleteMany();
    await seed!.productStock.update({ where: { productId }, data: { quantity: 100 } });
  });

  afterAll(async () => {
    await seed?.$disconnect();
    await harness.client?.$disconnect();
    if (localDataDir) {
      spawnSync(
        path.join(LOCAL_PG_BIN, "pg_ctl.exe"),
        ["-D", localDataDir, "stop", "-m", "immediate", "-w", "-t", "20"],
        { encoding: "utf8", timeout: 25_000 },
      );
    }
    if (started) spawnSync("docker", ["rm", "-f", container], { encoding: "utf8" });
    if (cwd) {
      let removed = false;
      for (let attempt = 0; attempt < 10 && !removed; attempt += 1) {
        try {
          fs.rmSync(cwd, { recursive: true, force: true });
          removed = true;
        } catch (err) {
          const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";
          if ((code !== "EBUSY" && code !== "EPERM") || attempt === 9) throw err;
          pause(300);
        }
      }
    }
    vi.unstubAllGlobals();
  });

  async function counts() {
    const stock = await seed!.productStock.findUniqueOrThrow({ where: { productId } });
    return {
      sales: await seed!.sale.count(),
      supplies: await seed!.supply.count(),
      mpStock: await seed!.mpStock.count(),
      productStock: stock.quantity,
    };
  }

  async function saveCredentials(input: { wb: boolean; ozon: boolean }) {
    const rows: Array<{ key: string; value: string }> = [];
    if (input.wb) rows.push({ key: "apiCred:wb.token", value: "wb-test-token" });
    if (input.ozon) {
      rows.push({ key: "apiCred:ozon.clientId", value: "100" });
      rows.push({ key: "apiCred:ozon.apiKey", value: "ozon-test-key" });
    }
    if (rows.length > 0) await seed!.setting.createMany({ data: rows });
  }

  async function expectUnchanged() {
    expect(await counts()).toEqual({ sales: 0, supplies: 0, mpStock: 0, productStock: 100 });
    expect(fetchCalls).toBe(0);
  }

  it("writes nothing when neither marketplace is configured", async () => {
    const result = await syncMarketplacesAsUserInternal(actor);
    expect(result.ok).toBe(false);
    await expectUnchanged();
  });

  it("writes nothing when only Wildberries is configured", async () => {
    await saveCredentials({ wb: true, ozon: false });
    const result = await syncMarketplacesAsUserInternal(actor);
    expect(result.ok).toBe(false);
    await expectUnchanged();
  });

  it("writes nothing when only Ozon is configured", async () => {
    await saveCredentials({ wb: false, ozon: true });
    const result = await syncMarketplacesAsUserInternal(actor);
    expect(result.ok).toBe(false);
    await expectUnchanged();
  });

  it("writes nothing when the configured API calls fail", async () => {
    await saveCredentials({ wb: true, ozon: true });
    const result = await syncMarketplacesAsUserInternal(actor);
    expect(result.ok).toBe(false);
    await expectUnchanged();
  });

  it("keeps a second refusal from changing stock", async () => {
    await saveCredentials({ wb: true, ozon: false });
    await syncMarketplacesAsUserInternal(actor);
    await syncMarketplacesAsUserInternal(actor);
    await expectUnchanged();
  });

  it("rejects a direct stub payload before it can change stock", async () => {
    await expect(
      seed!.$transaction((tx) =>
        persistMarketplaceSyncInTransaction(tx, {
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
          supplies: [
            {
              marketplace: "WB",
              externalId: "stub-supply",
              number: null,
              sku: "WB-1",
              quantity: 4,
              status: "SHIPPED",
              warehouseName: null,
              createdAt: new Date("2026-01-02T00:00:00.000Z"),
              acceptedAt: null,
            },
          ],
          stocks: [{ marketplace: "WB", sku: "WB-1", quantity: 9 }],
          ozonCancelledExternalIds: [],
          productIdFor: () => productId,
          stockReplace: { wb: true, ozon: true },
          now: new Date("2026-01-02T00:00:00.000Z"),
          sources: { wb: "stub", ozon: "stub" },
        }),
      ),
    ).rejects.toThrow(/демонстрационные данные не записываются/);
    await expectUnchanged();
  });

  it("keeps a configured API payload and its stock effect", async () => {
    await saveCredentials({ wb: true, ozon: true });
    configuredApis();
    const result = await syncMarketplacesAsUserInternal(actor);
    expect(result.ok).toBe(true);
    expect(result.sources).toEqual({ wb: "api", ozon: "api" });
    expect(await counts()).toEqual({ sales: 2, supplies: 1, mpStock: 0, productStock: 99 });
    const sales = await seed!.sale.findMany({ select: { externalId: true } });
    expect(sales.map((row) => row.externalId).sort()).toEqual(["API-OZ-1:OZ-1", "API-WB-1"]);
    expect(fetchCalls).toBe(0);
    expect(userId).not.toBe("");
  });
});
