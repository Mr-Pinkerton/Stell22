import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { overheadForProduct } from "@/lib/cost";
import { financePeriodExpense } from "@/mocks/finance-fixtures";
import { runDisposableMigrate } from "@/server/internal/disposable-migrate/guard";
import { PRODUCTION_COST_FLOW_KEY } from "@/server/internal/cost-flow-state";

const gate = vi.hoisted(() => ({
  admin: { id: "pending-admin", name: "Проверка", email: "transfer@example.invalid", role: "ADMIN" as const },
}));
const harness = vi.hoisted(() => ({
  url: "",
  client: null as PrismaClient | null,
}));

vi.mock("@/server/session", () => ({
  requireAdmin: async () => gate.admin,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/cost-queue", () => ({ enqueueRecalcBatchCosts: vi.fn(async () => {}) }));
vi.mock("@/server/db", async () => {
  const { PrismaClient: Client } = await import("@prisma/client");
  let client: PrismaClient | null = null;
  const prisma = new Proxy({} as PrismaClient, {
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

import { getPeriodOverhead } from "@/server/internal/cost";
import {
  assignCashFlow,
  convertCashFlowToTransfer,
  createCashFlow,
  createDeal,
  createTransfer,
  getFinanceData,
  reapplyAutoRules,
  updateDeal,
} from "@/server/finance";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PG17_BIN = process.env.P1_PG17_BIN ?? "C:\\Users\\bocma\\AppData\\Local\\Temp\\pg17\\pgsql\\bin";
const FORBIDDEN_PORTS = new Set(["5432", "5433", "5434"]);
const MARCH = {
  start: new Date("2026-03-01T00:00:00.000Z"),
  end: new Date("2026-03-31T23:59:59.999Z"),
};
const WHEN = new Date("2026-03-15T12:00:00.000Z");

function pause(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function reserveLoopbackPort(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("ephemeral port was not numeric"));
        return;
      }
      const port = String(address.port);
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function startPostgres17(input: {
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
        ["exec", "-e", `PGPASSWORD=${input.password}`, input.container, "psql", "-X", "-U", "p1iso", "-d", input.database, "-q", "-At", "-c", "SELECT version()"],
        { encoding: "utf8" },
      );
      if (probe.status === 0 && probe.stdout.includes("PostgreSQL 17")) ready = probe.stdout.trim();
      else pause(1000);
    }
    if (!ready.includes("PostgreSQL 17")) throw new Error("disposable PostgreSQL 17 did not become ready");
    return port;
  }
  const postgres = path.join(PG17_BIN, "postgres.exe");
  if (!fs.existsSync(postgres)) throw new Error("PostgreSQL 17 binaries are not available");
  const version = spawnSync(postgres, ["-V"], { encoding: "utf8" });
  if (!version.stdout.includes("17.")) throw new Error(`expected PostgreSQL 17, got ${version.stdout.trim()}`);
  const port = await reserveLoopbackPort();
  if (FORBIDDEN_PORTS.has(port)) throw new Error("disposable port was not an ephemeral loopback port");
  const dataDir = path.join(input.cwd, "pgdata");
  const env = { ...process.env, PATH: `${PG17_BIN};${process.env.PATH ?? ""}`, PGCONNECT_TIMEOUT: "5" };
  const init = spawnSync(path.join(PG17_BIN, "initdb.exe"), ["-D", dataDir, "-U", "p1iso", "-A", "trust", "--encoding", "UTF8"], {
    encoding: "utf8",
    env,
  });
  if (init.status !== 0) throw new Error(`disposable cluster init failed\n${init.stderr}`);
  input.markLocalDataDir(dataDir);
  const started = spawnSync(
    path.join(PG17_BIN, "pg_ctl.exe"),
    ["-D", dataDir, "-l", path.join(input.cwd, "pg.log"), "-w", "-t", "30", "start", "-o", `-h 127.0.0.1 -p ${port}`],
    { encoding: "utf8", timeout: 40_000, env },
  );
  if (started.status !== 0) throw new Error(`disposable cluster start failed\n${started.stderr}`);
  const createdDb = spawnSync(
    path.join(PG17_BIN, "psql.exe"),
    ["-X", "-h", "127.0.0.1", "-p", port, "-U", "p1iso", "-d", "postgres", "-q", "-v", "ON_ERROR_STOP=1", "-c", `CREATE DATABASE "${input.database}"`],
    { encoding: "utf8", env, timeout: 15_000, input: "" },
  );
  if (createdDb.status !== 0) throw new Error(`disposable database create failed\n${createdDb.stderr}`);
  return port;
}

describe("BA-P02-002 / BA-P11-002 transfer exclusion on disposable PostgreSQL 17", () => {
  let runId = "";
  let database = "";
  let dbPassword = "";
  let container = "";
  let cwd = "";
  let localDataDir = "";
  let startedDocker = false;
  let seed: PrismaClient | null = null;
  let accountA = "";
  let accountB = "";
  let accountC = "";
  let dealId = "";
  let batchId = "";
  let batchName = "";
  let deliveryArticleId = "";
  let overheadArticleId = "";
  let counterpartyId = "";

  beforeAll(async () => {
    runId = randomBytes(4).toString("hex");
    database = `p1iso_${runId}`;
    dbPassword = randomBytes(16).toString("hex");
    container = `p1iso-xfer-${runId}`;
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "p1iso-xfer-"));
    fs.cpSync(path.join(root, "prisma"), path.join(cwd, "prisma"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".env"), "DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked\n");
    const port = await startPostgres17({
      container,
      database,
      password: dbPassword,
      cwd,
      markDockerStarted: () => {
        startedDocker = true;
      },
      markLocalDataDir: (dir) => {
        localDataDir = dir;
      },
    });
    const url = `postgresql://p1iso:${dbPassword}@127.0.0.1:${port}/${database}?schema=public`;
    runDisposableMigrate({
      databaseUrl: url,
      cwd,
      schemaPath: path.join(cwd, "prisma", "schema.prisma"),
      repositoryRoot: root,
    });
    harness.url = url;
    seed = new PrismaClient({ datasourceUrl: url });
    const version = await seed.$queryRaw<Array<{ version: string }>>`SELECT version() AS version`;
    expect(version[0]?.version).toContain("PostgreSQL 17");

    const material = await seed.material.create({
      data: { name: `Порода ${runId}`, sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    batchName = `Закупка ${runId}`;
    const batch = await seed.batch.create({
      data: {
        name: batchName,
        materialId: material.id,
        sectionWidthMm: 40,
        sectionHeightMm: 20,
        purchaseCost: 1_000,
        totalCost: 1_000,
        priceSort1: 0,
        priceSort2: 0,
        purchaseDate: WHEN,
      },
    });
    batchId = batch.id;
    const a = await seed.account.create({
      data: { name: `Расчётный ${runId}`, confirmed: true, openingBalance: 0, balance: 0 },
    });
    const b = await seed.account.create({
      data: { name: `Касса ${runId}`, confirmed: true, openingBalance: 0, balance: 0 },
    });
    const c = await seed.account.create({
      data: { name: `Карантин ${runId}`, confirmed: false, openingBalance: 0, balance: 0 },
    });
    accountA = a.id;
    accountB = b.id;
    accountC = c.id;
    const overheadCat = await seed.articleCategory.create({
      data: { name: `Накладные ${runId}`, isOverhead: true },
    });
    const deliveryCat = await seed.articleCategory.create({
      data: { name: `Доставка ${runId}`, isOverhead: false },
    });
    const overhead = await seed.article.create({
      data: { name: `Цех ${runId}`, flowType: "EXPENSE", categoryId: overheadCat.id },
    });
    const delivery = await seed.article.create({
      data: { name: `Доставка партии ${runId}`, flowType: "EXPENSE", categoryId: deliveryCat.id },
    });
    overheadArticleId = overhead.id;
    deliveryArticleId = delivery.id;
    const counterparty = await seed.counterparty.create({ data: { name: `Поставщик ${runId}` } });
    counterpartyId = counterparty.id;
    const deal = await createDeal({ name: `Сделка ${runId}`, batchNames: [batchName] });
    dealId = deal.id;
    await seed.autoRule.create({
      data: {
        flowType: "EXPENSE",
        articleId: deliveryArticleId,
        dealId,
        logicOperator: "AND",
        descriptionKeywords: "доставка-авто",
      },
    });
  }, 180_000);

  afterAll(async () => {
    await seed?.$disconnect();
    await harness.client?.$disconnect();
    if (localDataDir) {
      spawnSync(path.join(PG17_BIN, "pg_ctl.exe"), ["-D", localDataDir, "stop", "-m", "immediate", "-w", "-t", "20"], {
        encoding: "utf8",
        timeout: 25_000,
        env: { ...process.env, PATH: `${PG17_BIN};${process.env.PATH ?? ""}` },
      });
    }
    if (startedDocker) spawnSync("docker", ["rm", "-f", container], { encoding: "utf8" });
    if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
  });

  async function batchCost(): Promise<string> {
    const batch = await seed!.batch.findUniqueOrThrow({ where: { id: batchId } });
    return batch.totalCost.toFixed(2);
  }

  async function dealTotal(): Promise<string> {
    const deal = await seed!.deal.findUniqueOrThrow({ where: { id: dealId } });
    return deal.total.toFixed(2);
  }

  it("keeps a transfer out of deal, batch, and product cost while ordinary expenses still count", async () => {
    const [outLeg, inLeg] = await createTransfer({
      date: "2026-03-15",
      amount: 1_500,
      fromAccountId: accountA,
      toAccountId: accountB,
      description: "оплата доставка-авто",
    });
    expect(outLeg.isTransfer).toBe(true);
    expect(inLeg.isTransfer).toBe(true);
    expect(outLeg.articleName).toBeNull();
    expect(outLeg.dealId).toBeNull();
    const blocked = await reapplyAutoRules();
    expect(blocked.updated.map((row) => row.id)).not.toContain(outLeg.id);
    expect(blocked.updated.map((row) => row.id)).not.toContain(inLeg.id);
    const transferAfterRule = await seed!.cashFlow.findUniqueOrThrow({ where: { id: outLeg.id } });
    expect(transferAfterRule.articleId).toBeNull();
    expect(transferAfterRule.dealId).toBeNull();
    expect(transferAfterRule.isTransfer).toBe(true);
    expect(await batchCost()).toBe("1000.00");
    expect(await dealTotal()).toBe("1000.00");

    await createCashFlow({
      date: "2026-03-15",
      amount: 2_000,
      flowType: "EXPENSE",
      accountName: `Расчётный ${runId}`,
      counterpartyName: null,
      description: "доставка партии",
      articleName: `Доставка партии ${runId}`,
      dealId,
      dealName: null,
    });
    expect(await batchCost()).toBe("2000.00");
    expect(await dealTotal()).toBe("2000.00");

    const legacyTransferId = randomUUID();
    await seed!.cashFlow.createMany({
      data: [
        {
          amount: 1_500,
          flowType: "EXPENSE",
          accountId: accountA,
          articleId: overheadArticleId,
          dealId,
          description: "исторический перевод",
          date: WHEN,
          isTransfer: true,
          transferId: legacyTransferId,
          isAutoAssigned: true,
        },
        {
          amount: 1_500,
          flowType: "INCOME",
          accountId: accountB,
          articleId: overheadArticleId,
          dealId,
          description: "исторический перевод",
          date: WHEN,
          isTransfer: true,
          transferId: legacyTransferId,
          isAutoAssigned: true,
        },
      ],
    });
    await updateDeal(dealId, { name: `Сделка ${runId}`, batchNames: [batchName] });
    expect(await batchCost()).toBe("2000.00");
    expect(await dealTotal()).toBe("2000.00");

    await seed!.cashFlow.create({
      data: {
        amount: 50,
        flowType: "EXPENSE",
        accountId: accountC,
        articleId: overheadArticleId,
        dealId,
        description: "карантин",
        date: WHEN,
      },
    });
    await updateDeal(dealId, { name: `Сделка ${runId}`, batchNames: [batchName] });
    expect(await batchCost()).toBe("2000.00");

    await createCashFlow({
      date: "2026-03-15",
      amount: 300,
      flowType: "EXPENSE",
      accountName: `Расчётный ${runId}`,
      counterpartyName: null,
      description: "аренда цеха",
      articleName: `Цех ${runId}`,
      dealId: null,
      dealName: null,
    });
    const overhead = await getPeriodOverhead(MARCH);
    expect(overhead.toFixed(2)).toBe("300.00");
    expect(overheadForProduct({ directCost: 100, periodOverhead: overhead, periodTotalDirect: 100 }).toFixed(2)).toBe("300.00");

    const autoExpense = await createCashFlow({
      date: "2026-03-15",
      amount: 400,
      flowType: "EXPENSE",
      accountName: `Расчётный ${runId}`,
      counterpartyName: null,
      description: "оплата доставка-авто",
      articleName: null,
      dealId: null,
      dealName: null,
    });
    const stamped = await seed!.cashFlow.findUniqueOrThrow({ where: { id: autoExpense.id } });
    expect(stamped.articleId).toBe(deliveryArticleId);
    expect(stamped.dealId).toBe(dealId);
    expect(stamped.isTransfer).toBe(false);
    expect(await batchCost()).toBe("2400.00");

    const converted = await convertCashFlowToTransfer(autoExpense.id, accountB);
    expect(converted).toHaveLength(2);
    expect(converted.every((row) => row.isTransfer)).toBe(true);
    const cleared = await seed!.cashFlow.findUniqueOrThrow({ where: { id: autoExpense.id } });
    expect(cleared.isTransfer).toBe(true);
    expect(cleared.articleId).toBeNull();
    expect(cleared.dealId).toBeNull();
    expect(await batchCost()).toBe("2000.00");
    expect(await dealTotal()).toBe("2000.00");

    const restored = await reapplyAutoRules();
    expect(restored.updated.map((row) => row.id)).not.toContain(autoExpense.id);
    const stillClear = await seed!.cashFlow.findUniqueOrThrow({ where: { id: autoExpense.id } });
    expect(stillClear.articleId).toBeNull();
    expect(stillClear.dealId).toBeNull();
    expect(stillClear.isTransfer).toBe(true);
    expect(await batchCost()).toBe("2000.00");

    await expect(
      assignCashFlow(outLeg.id, { articleId: overheadArticleId, dealId }),
    ).rejects.toThrow("Перевод нельзя разнести на статью или сделку");
    const untouched = await seed!.cashFlow.findUniqueOrThrow({ where: { id: outLeg.id } });
    expect(untouched.isTransfer).toBe(true);
    expect(untouched.articleId).toBeNull();
    expect(untouched.dealId).toBeNull();
    expect(untouched.amount.toFixed(2)).toBe("1500.00");
    expect(await batchCost()).toBe("2000.00");

    const legacy = await seed!.cashFlow.findFirstOrThrow({
      where: { transferId: legacyTransferId, flowType: "EXPENSE" },
    });
    await expect(
      assignCashFlow(legacy.id, { articleId: deliveryArticleId, dealId }),
    ).rejects.toThrow("Перевод нельзя разнести на статью или сделку");
    const legacyAfter = await seed!.cashFlow.findUniqueOrThrow({ where: { id: legacy.id } });
    expect(legacyAfter.isTransfer).toBe(true);
    expect(legacyAfter.articleId).toBe(overheadArticleId);
    expect(legacyAfter.dealId).toBe(dealId);

    const withCounterparty = await assignCashFlow(outLeg.id, { counterpartyId });
    expect(withCounterparty.isTransfer).toBe(true);
    expect(withCounterparty.articleName).toBeNull();
    expect(withCounterparty.dealId).toBeNull();

    const data = await getFinanceData();
    const shown = data.deals.find((deal) => deal.id === dealId);
    expect(shown?.purchaseTotal).toBe(1_000);
    expect(shown?.deliveryExtra).toBe(1_000);
    expect(shown?.total).toBe(2_000);
    expect(financePeriodExpense(data.cashFlows)).toBe(2_300);
    expect(data.accounts.find((account) => account.id === accountA)?.balance).toBe(-5_700);
    expect(data.accounts.find((account) => account.id === accountB)?.balance).toBe(3_400);
    expect(data.accounts.find((account) => account.id === accountC)?.balance).toBe(-50);

    const transfers = await seed!.cashFlow.findMany({ where: { isTransfer: true } });
    expect(transfers).toHaveLength(6);
    const pair = (transferId: string | null) => transfers.filter((row) => row.transferId === transferId);
    const freshTransfer = await seed!.cashFlow.findUniqueOrThrow({ where: { id: outLeg.id } });
    const freshLegs = pair(freshTransfer.transferId);
    expect(freshLegs).toHaveLength(2);
    expect(freshLegs.map((leg) => leg.flowType).sort()).toEqual(["EXPENSE", "INCOME"]);
    expect(freshLegs.map((leg) => leg.amount.toFixed(2)).sort()).toEqual(["1500.00", "1500.00"]);
    const convertedLegs = pair(cleared.transferId);
    expect(convertedLegs).toHaveLength(2);
    expect(convertedLegs.map((leg) => leg.amount.toFixed(2)).sort()).toEqual(["400.00", "400.00"]);
    expect(convertedLegs.every((leg) => leg.articleId == null && leg.dealId == null)).toBe(true);
    const legacyLegs = pair(legacyTransferId);
    expect(legacyLegs).toHaveLength(2);
    expect(legacyLegs.map((leg) => leg.flowType).sort()).toEqual(["EXPENSE", "INCOME"]);
    expect(legacyLegs.every((leg) => leg.articleId === overheadArticleId && leg.dealId === dealId)).toBe(true);
    expect((await getPeriodOverhead(null)).toFixed(2)).toBe("300.00");
    expect(await seed!.setting.findUnique({ where: { key: PRODUCTION_COST_FLOW_KEY } })).toBeNull();
    const frozen = await seed!.batch.findUniqueOrThrow({ where: { id: batchId } });
    expect(frozen.frozenAt).toBeNull();
    expect(frozen.purchaseCost.toFixed(2)).toBe("1000.00");
  }, 120_000);
});
