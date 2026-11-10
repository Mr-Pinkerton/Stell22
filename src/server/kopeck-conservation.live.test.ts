import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runDisposableMigrate } from "@/server/internal/disposable-migrate/guard";

const harness = vi.hoisted(() => ({
  url: "",
  client: null as PrismaClient | null,
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

import { DEAL_EXTRA_FROZEN_MIX } from "@/lib/deal-cost";
import { maybeFreezeBatch, recalcBatchCosts } from "@/server/internal/cost";
import { syncBatchTotalCostInternal, syncDealInternal } from "@/server/internal/finance-operations";

const LIVE = process.env.P1_DISPOSABLE_LIVE === "1";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FORBIDDEN_PORTS = new Set(["5432", "5433", "5434"]);
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
  const pgBin = process.env.P1_PG17_BIN;
  if (!pgBin) throw new Error("Docker did not start disposable PostgreSQL 17, and P1_PG17_BIN is not set");
  const postgres = path.join(pgBin, "postgres.exe");
  if (!fs.existsSync(postgres)) throw new Error("P1_PG17_BIN does not contain PostgreSQL 17 binaries");
  const version = spawnSync(postgres, ["-V"], { encoding: "utf8" });
  if (!version.stdout.includes("17.")) throw new Error(`expected PostgreSQL 17, got ${version.stdout.trim()}`);
  const port = await reserveLoopbackPort();
  if (FORBIDDEN_PORTS.has(port)) throw new Error("disposable port was not an ephemeral loopback port");
  const dataDir = path.join(input.cwd, "pgdata");
  const env = { ...process.env, PATH: `${pgBin};${process.env.PATH ?? ""}`, PGCONNECT_TIMEOUT: "5" };
  const init = spawnSync(path.join(pgBin, "initdb.exe"), ["-D", dataDir, "-U", "p1iso", "-A", "trust", "--encoding", "UTF8"], {
    encoding: "utf8",
    env,
  });
  if (init.status !== 0) throw new Error(`disposable cluster init failed\n${init.stderr}`);
  input.markLocalDataDir(dataDir);
  const started = spawnSync(
    path.join(pgBin, "pg_ctl.exe"),
    ["-D", dataDir, "-l", path.join(input.cwd, "pg.log"), "-w", "-t", "30", "start", "-o", `-h 127.0.0.1 -p ${port}`],
    { encoding: "utf8", timeout: 40_000, env },
  );
  if (started.status !== 0) throw new Error(`disposable cluster start failed\n${started.stderr}`);
  const createdDb = spawnSync(
    path.join(pgBin, "psql.exe"),
    ["-X", "-h", "127.0.0.1", "-p", port, "-U", "p1iso", "-d", "postgres", "-q", "-v", "ON_ERROR_STOP=1", "-c", `CREATE DATABASE "${input.database}"`],
    { encoding: "utf8", env, timeout: 15_000, input: "" },
  );
  if (createdDb.status !== 0) throw new Error(`disposable database create failed\n${createdDb.stderr}`);
  return port;
}

describe.skipIf(!LIVE)("BA-P01 kopeck conservation on disposable PostgreSQL 17", () => {
  let database = "";
  let container = "";
  let cwd = "";
  let localDataDir = "";
  let startedDocker = false;
  let seed: PrismaClient | null = null;
  let accountId = "";
  let quarantineId = "";
  let materialId = "";
  let employeeId = "";

  beforeAll(async () => {
    const runId = randomBytes(4).toString("hex");
    database = `p1iso_${runId}`;
    const dbPassword = randomBytes(16).toString("hex");
    container = `p1iso-kopeck-${runId}`;
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "p1iso-kopeck-"));
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
    const identity = await seed.$queryRaw<Array<{ name: string; version: string }>>`
      SELECT current_database() AS name, version() AS version
    `;
    expect(identity[0]?.name).toBe(database);
    expect(identity[0]?.version).toContain("PostgreSQL 17");
    const material = await seed.material.create({
      data: { name: `Порода ${runId}`, sectionWidthMm: 1000, sectionHeightMm: 1000 },
    });
    materialId = material.id;
    const account = await seed.account.create({
      data: { name: `Счёт ${runId}`, confirmed: true, openingBalance: 0, balance: 0 },
    });
    const quarantine = await seed.account.create({
      data: { name: `Карантин ${runId}`, confirmed: false, openingBalance: 0, balance: 0 },
    });
    accountId = account.id;
    quarantineId = quarantine.id;
    const employee = await seed.employee.create({
      data: { fullName: `Сотрудник ${runId}`, pin: "2468" },
    });
    employeeId = employee.id;
  }, 180_000);

  afterAll(async () => {
    await seed?.$disconnect();
    await harness.client?.$disconnect();
    const pgBin = process.env.P1_PG17_BIN;
    if (localDataDir) {
      if (!pgBin) throw new Error("P1_PG17_BIN is required to stop the disposable cluster");
      spawnSync(path.join(pgBin, "pg_ctl.exe"), ["-D", localDataDir, "stop", "-m", "immediate", "-w", "-t", "20"], {
        encoding: "utf8",
        timeout: 25_000,
        env: { ...process.env, PATH: `${pgBin};${process.env.PATH ?? ""}` },
      });
    }
    if (startedDocker) spawnSync("docker", ["rm", "-f", container], { encoding: "utf8" });
    if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
  });

  async function makeBatch(id: string, purchase: string, frozen = false) {
    return seed!.batch.create({
      data: {
        id,
        name: `Партия ${id}`,
        materialId,
        sectionWidthMm: 1000,
        sectionHeightMm: 1000,
        purchaseCost: purchase,
        totalCost: purchase,
        priceSort1: "1.00",
        priceSort2: "1.00",
        purchaseDate: WHEN,
        frozenAt: frozen ? WHEN : null,
      },
    });
  }

  async function dealWith(name: string, batchIds: string[], amount: string, flags?: { confirmed?: boolean; transfer?: boolean }) {
    const deal = await seed!.deal.create({ data: { name, total: 0 } });
    for (const batchId of batchIds) {
      await seed!.dealItem.create({ data: { dealId: deal.id, batchId } });
    }
    await seed!.cashFlow.create({
      data: {
        amount,
        flowType: "EXPENSE",
        accountId: flags?.confirmed === false ? quarantineId : accountId,
        dealId: deal.id,
        date: WHEN,
        isTransfer: flags?.transfer === true,
      },
    });
    return deal.id;
  }

  async function totals(ids: string[]) {
    const rows = await seed!.batch.findMany({ where: { id: { in: ids } } });
    const byId = new Map(rows.map((row) => [row.id, row.totalCost.toFixed(2)]));
    return ids.map((id) => byId.get(id) ?? "missing");
  }

  it("сохраняет доплату на записываемых партиях и не двигает замороженную", async () => {
    await makeBatch("ko-a", "10.00");
    await makeBatch("ko-b", "10.00");
    await makeBatch("ko-c", "10.00");
    const three = await dealWith("три равные", ["ko-c", "ko-a", "ko-b"], "130.00");
    await syncDealInternal(three);
    expect(await totals(["ko-a", "ko-b", "ko-c"])).toEqual(["43.33", "43.33", "43.34"]);
    await syncDealInternal(three);
    expect(await totals(["ko-a", "ko-b", "ko-c"])).toEqual(["43.33", "43.33", "43.34"]);

    await makeBatch("ko-d", "10.00");
    await makeBatch("ko-e", "10.00");
    const penny = await dealWith("копейка", ["ko-e", "ko-d"], "20.01");
    await syncDealInternal(penny);
    expect(await totals(["ko-d", "ko-e"])).toEqual(["10.00", "10.01"]);

    await makeBatch("ko-z0", "0.00");
    await makeBatch("ko-a0", "0.00");
    const zeros = await dealWith("нули", ["ko-z0", "ko-a0"], "0.01");
    await syncDealInternal(zeros);
    expect(await totals(["ko-a0", "ko-z0"])).toEqual(["0.00", "0.01"]);

    await makeBatch("ko-large", "90000.00");
    await makeBatch("ko-small", "30000.00");
    const uneven = await dealWith("веса", ["ko-small", "ko-large"], "120100.01");
    await syncDealInternal(uneven);
    expect(await totals(["ko-large", "ko-small"])).toEqual(["90075.00", "30025.01"]);

    await makeBatch("ko-one", "10.00");
    const single = await dealWith("одна", ["ko-one"], "15.00");
    await syncDealInternal(single);
    expect(await totals(["ko-one"])).toEqual(["15.00"]);

    await makeBatch("ko-zero", "10.00");
    const none = await dealWith("ноль", ["ko-zero"], "10.00");
    await syncDealInternal(none);
    expect(await totals(["ko-zero"])).toEqual(["10.00"]);

    await makeBatch("ko-q", "15.00");
    const ignored = await dealWith("карантин", ["ko-q"], "80.00", { confirmed: false });
    await seed!.cashFlow.create({
      data: {
        amount: "25.00",
        flowType: "EXPENSE",
        accountId,
        dealId: ignored,
        date: WHEN,
        isTransfer: true,
      },
    });
    await seed!.cashFlow.create({
      data: {
        amount: "15.00",
        flowType: "EXPENSE",
        accountId,
        dealId: ignored,
        date: WHEN,
        isTransfer: false,
      },
    });
    await syncDealInternal(ignored);
    expect(await totals(["ko-q"])).toEqual(["15.00"]);

    await makeBatch("ko-other", "10.00");
    await makeBatch("ko-shared", "10.00");
    const first = await dealWith("первая сделка", ["ko-shared", "ko-other"], "20.01");
    const second = await dealWith("вторая сделка", ["ko-shared"], "10.05");
    await syncDealInternal(first);
    await syncDealInternal(second);
    await syncDealInternal(first);
    expect(await totals(["ko-other", "ko-shared"])).toEqual(["10.00", "10.06"]);
  }, 60_000);

  it("повторяющиеся строки одной партии не теряют и не удваивают доплату", async () => {
    await makeBatch("ko-dup", "10.00");
    const duplicated = await seed!.deal.create({ data: { name: "три строки", total: "0.00" } });
    for (let copy = 0; copy < 3; copy += 1) {
      await seed!.dealItem.create({ data: { dealId: duplicated.id, batchId: "ko-dup" } });
    }
    await seed!.cashFlow.create({
      data: {
        amount: "30.10",
        flowType: "EXPENSE",
        accountId,
        dealId: duplicated.id,
        date: WHEN,
        isTransfer: false,
      },
    });
    await syncDealInternal(duplicated.id);
    expect((await seed!.deal.findUniqueOrThrow({ where: { id: duplicated.id } })).total.toFixed(2)).toBe("30.10");
    expect(await totals(["ko-dup"])).toEqual(["30.10"]);
    await syncDealInternal(duplicated.id);
    expect((await seed!.deal.findUniqueOrThrow({ where: { id: duplicated.id } })).total.toFixed(2)).toBe("30.10");
    expect(await totals(["ko-dup"])).toEqual(["30.10"]);

    await makeBatch("ko-dup-zero", "10.00");
    const zeroCopies = await seed!.deal.create({ data: { name: "нули строк", total: "0.00" } });
    for (let copy = 0; copy < 3; copy += 1) {
      await seed!.dealItem.create({ data: { dealId: zeroCopies.id, batchId: "ko-dup-zero" } });
    }
    await seed!.cashFlow.create({
      data: {
        amount: "10.00",
        flowType: "EXPENSE",
        accountId,
        dealId: zeroCopies.id,
        date: WHEN,
        isTransfer: false,
      },
    });
    await syncDealInternal(zeroCopies.id);
    expect((await seed!.deal.findUniqueOrThrow({ where: { id: zeroCopies.id } })).total.toFixed(2)).toBe("10.00");
    expect(await totals(["ko-dup-zero"])).toEqual(["10.00"]);

    await makeBatch("ko-ord-a", "10.00");
    await makeBatch("ko-ord-b", "10.00");
    const forward = await seed!.deal.create({ data: { name: "прямой порядок", total: "0.00" } });
    const backward = await seed!.deal.create({ data: { name: "обратный порядок", total: "0.00" } });
    for (const batchId of ["ko-ord-b", "ko-ord-a", "ko-ord-b"]) {
      await seed!.dealItem.create({ data: { dealId: forward.id, batchId } });
    }
    for (const batchId of ["ko-ord-a", "ko-ord-b", "ko-ord-a"]) {
      await seed!.dealItem.create({ data: { dealId: backward.id, batchId } });
    }
    for (const dealId of [forward.id, backward.id]) {
      await seed!.cashFlow.create({
        data: {
          amount: "20.01",
          flowType: "EXPENSE",
          accountId,
          dealId,
          date: WHEN,
          isTransfer: false,
        },
      });
      await syncDealInternal(dealId);
    }
    expect(await totals(["ko-ord-a", "ko-ord-b"])).toEqual(["10.00", "10.02"]);
    expect((await seed!.deal.findUniqueOrThrow({ where: { id: forward.id } })).total.toFixed(2)).toBe("20.01");
    expect((await seed!.deal.findUniqueOrThrow({ where: { id: backward.id } })).total.toFixed(2)).toBe("20.01");

    await makeBatch("ko-share-dup", "10.00");
    const neighbor = await dealWith("сосед без повторов", ["ko-share-dup", "ko-ord-a"], "20.01");
    const repeated = await seed!.deal.create({ data: { name: "повтор общей", total: "0.00" } });
    for (let copy = 0; copy < 3; copy += 1) {
      await seed!.dealItem.create({ data: { dealId: repeated.id, batchId: "ko-share-dup" } });
    }
    await seed!.cashFlow.create({
      data: {
        amount: "10.05",
        flowType: "EXPENSE",
        accountId,
        dealId: repeated.id,
        date: WHEN,
        isTransfer: false,
      },
    });
    await syncDealInternal(neighbor);
    await syncDealInternal(repeated.id);
    await syncDealInternal(neighbor);
    expect((await seed!.deal.findUniqueOrThrow({ where: { id: repeated.id } })).total.toFixed(2)).toBe("10.05");
    expect(await totals(["ko-share-dup"])).toEqual(["10.06"]);
    expect(await seed!.setting.findUnique({ where: { key: "production_cost_flow" } })).toBeNull();
  }, 60_000);

  it("прямой пересчёт без внешней транзакции откатывает отказ целиком", async () => {
    await makeBatch("ko-good-a", "10.00");
    await makeBatch("ko-good-b", "10.00");
    await makeBatch("ko-mix-c", "10.00", true);
    await dealWith("смесь соседа", ["ko-good-b", "ko-mix-c"], "100.00");
    const good = await dealWith("хорошая сделка", ["ko-good-a", "ko-good-b"], "30.00");
    const read = async () => ({
      good: (await seed!.deal.findUniqueOrThrow({ where: { id: good } })).total.toFixed(2),
      a: (await totals(["ko-good-a"]))[0],
      b: (await totals(["ko-good-b"]))[0],
      c: (await totals(["ko-mix-c"]))[0],
      events: await seed!.costEvent.count({
        where: { batchId: { in: ["ko-good-a", "ko-good-b", "ko-mix-c"] } },
      }),
    });
    const before = await read();
    expect(before).toEqual({ good: "0.00", a: "10.00", b: "10.00", c: "10.00", events: 0 });
    await expect(syncDealInternal(good)).rejects.toThrow(DEAL_EXTRA_FROZEN_MIX);
    expect(await read()).toEqual(before);
    expect(await seed!.setting.findUnique({ where: { key: "production_cost_flow" } })).toBeNull();
  }, 60_000);

  async function snapshot(batchIds: string[], dealId: string) {
    const deal = await seed!.deal.findUniqueOrThrow({ where: { id: dealId } });
    return {
      batches: await totals(batchIds),
      deal: deal.total.toFixed(2),
      costs: await seed!.batchCost.count({ where: { batchId: { in: batchIds } } }),
      events: await seed!.costEvent.count({ where: { batchId: { in: batchIds } } }),
    };
  }

  it("отклоняет положительную доплату смешанной сделки до записи", async () => {
    await makeBatch("ko-frozen", "10.00", true);
    await makeBatch("ko-open", "10.00");
    const mixed = await dealWith("смесь", ["ko-open", "ko-frozen"], "120.00");
    const before = await snapshot(["ko-frozen", "ko-open"], mixed);
    await expect(syncDealInternal(mixed)).rejects.toThrow(DEAL_EXTRA_FROZEN_MIX);
    expect(await snapshot(["ko-frozen", "ko-open"], mixed)).toEqual(before);
    await expect(syncBatchTotalCostInternal("ko-open")).rejects.toThrow(DEAL_EXTRA_FROZEN_MIX);
    await expect(syncBatchTotalCostInternal("ko-frozen")).resolves.toBeNull();
    expect(await snapshot(["ko-frozen", "ko-open"], mixed)).toEqual(before);

    await makeBatch("ko-frozen-zero", "10.00", true);
    await makeBatch("ko-open-zero", "10.00");
    const zero = await dealWith("смесь без доплаты", ["ko-open-zero", "ko-frozen-zero"], "20.00");
    await syncDealInternal(zero);
    expect(await totals(["ko-frozen-zero", "ko-open-zero"])).toEqual(["10.00", "10.00"]);
    expect((await seed!.deal.findUniqueOrThrow({ where: { id: zero } })).total.toFixed(2)).toBe("20.00");

    await makeBatch("ko-frozen-a", "10.00", true);
    await makeBatch("ko-frozen-b", "10.00", true);
    const frozenOnly = await dealWith("только замороженные", ["ko-frozen-b", "ko-frozen-a"], "120.00");
    await syncDealInternal(frozenOnly);
    expect(await totals(["ko-frozen-a", "ko-frozen-b"])).toEqual(["10.00", "10.00"]);
    expect(await seed!.setting.findUnique({ where: { key: "production_cost_flow" } })).toBeNull();
  }, 60_000);

  async function produced(batchId: string, lines: { sort: "SORT1" | "SORT2"; quantity: number }[]) {
    await seed!.productionOperation.create({
      data: {
        type: "TORCOVKA",
        employeeId,
        workDate: WHEN,
        clientRequestId: `req-${batchId}`,
        batchId,
        isPaid: true,
        paidAt: WHEN,
        rateSnapshotVersion: 1,
        lines: {
          create: lines.map((line) => ({
            quantity: line.quantity,
            blankLengthM: "1",
            blankSort: line.sort,
          })),
        },
      },
    });
    await seed!.batch.update({ where: { id: batchId }, data: { closedAt: WHEN } });
  }

  it("пишет FINAL и PRELIMINARY без лишней копейки и не трогает старую строку", async () => {
    await makeBatch("ko-hist", "10.00", true);
    const historical = await seed!.batchCost.create({
      data: {
        batchId: "ko-hist",
        status: "FINAL",
        volumeSort1: "1.005000",
        volumeSort2: "8.995000",
        costSort1: "1.01",
        costSort2: "9.00",
        pricePerM3Sort1: "1.00",
        pricePerM3Sort2: "1.00",
      },
    });
    const before = await seed!.$queryRaw<Array<{ cost1: string; cost2: string; price1: string; price2: string }>>`
      SELECT "costSort1"::text AS cost1, "costSort2"::text AS cost2,
             "pricePerM3Sort1"::text AS price1, "pricePerM3Sort2"::text AS price2
      FROM "BatchCost" WHERE id = ${historical.id}
    `;

    await makeBatch("ko-both", "10.00");
    await produced("ko-both", [
      { sort: "SORT1", quantity: 201 },
      { sort: "SORT2", quantity: 1799 },
    ]);
    await recalcBatchCosts({ batchId: "ko-both" });
    const preliminary = await seed!.batchCost.findMany({ where: { batchId: "ko-both", status: "PRELIMINARY" } });
    expect(preliminary).toHaveLength(1);
    expect(preliminary[0]!.costSort1.toFixed(2)).toBe("1.01");
    expect(preliminary[0]!.costSort2.toFixed(2)).toBe("8.99");

    const froze = await seed!.$transaction((tx) => maybeFreezeBatch(tx, "ko-both"));
    expect(froze).toBe(true);
    const again = await seed!.$transaction((tx) => maybeFreezeBatch(tx, "ko-both"));
    expect(again).toBe(false);
    const finals = await seed!.batchCost.findMany({ where: { batchId: "ko-both", status: "FINAL" } });
    expect(finals).toHaveLength(1);
    expect(finals[0]!.costSort1.toFixed(2)).toBe("1.01");
    expect(finals[0]!.costSort2.toFixed(2)).toBe("8.99");
    expect(finals[0]!.costSort1.plus(finals[0]!.costSort2).toFixed(2)).toBe("10.00");

    await makeBatch("ko-sort1", "10.00");
    await produced("ko-sort1", [{ sort: "SORT1", quantity: 4 }]);
    await seed!.$transaction((tx) => maybeFreezeBatch(tx, "ko-sort1"));
    const only = await seed!.batchCost.findFirstOrThrow({ where: { batchId: "ko-sort1", status: "FINAL" } });
    expect(only.costSort1.toFixed(2)).toBe("10.00");
    expect(only.costSort2.toFixed(2)).toBe("0.00");

    await recalcBatchCosts({ batchId: "ko-hist" });
    await seed!.$transaction((tx) => maybeFreezeBatch(tx, "ko-hist"));
    const after = await seed!.$queryRaw<Array<{ cost1: string; cost2: string; price1: string; price2: string }>>`
      SELECT "costSort1"::text AS cost1, "costSort2"::text AS cost2,
             "pricePerM3Sort1"::text AS price1, "pricePerM3Sort2"::text AS price2
      FROM "BatchCost" WHERE id = ${historical.id}
    `;
    expect(after).toEqual(before);
    expect(await seed!.setting.findUnique({ where: { key: "production_cost_flow" } })).toBeNull();
  }, 60_000);
});
