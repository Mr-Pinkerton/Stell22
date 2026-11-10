import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runDisposableMigrate } from "@/server/internal/disposable-migrate/guard";

const harness = vi.hoisted(() => ({
  url: "",
  client: null as PrismaClient | null,
}));

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
import { COST_FLOW_C_OLD_ZERO, COST_FLOW_LOT_UNINITIALIZED } from "@/server/internal/cost-flow-raw";
import { isCostFlowActive, PRODUCTION_COST_FLOW_KEY } from "@/server/internal/cost-flow-state";
import { syncDealInternal } from "@/server/internal/finance-operations";

const LIVE = process.env.P1_DISPOSABLE_LIVE === "1";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FORBIDDEN_PORTS = new Set(["5432", "5433", "5434"]);
const FORBIDDEN_DATABASES = new Set([
  "stell22",
  "stell22_dev",
  "stell22_integrity",
  "stell22_smoke",
  "stell22_inc001_dry",
]);
const WHEN = new Date("2026-03-15T12:00:00.000Z");
const GATE = { version: 1, active: true } as const;

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

type LotSeed = {
  initial: string | null;
  remaining: string | null;
  quantity?: number;
  remainingQuantity?: number;
};

type MoneyEvent = {
  id: string;
  type: string;
  batchId: string | null;
  total: string;
  material: string;
  labor: string;
  nomenclature: string;
};

type MoneySnap = {
  batches: { id: string; total: string; frozen: string | null }[];
  lots: { id: string; batchId: string; initial: string | null; remaining: string | null }[];
  events: MoneyEvent[];
  finals: { id: string; batchId: string; status: string; cost1: string; cost2: string }[];
};

function dec(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

function sum(values: string[]): Prisma.Decimal {
  return values.reduce((total, value) => total.plus(value), new Prisma.Decimal(0));
}

describe.skipIf(!LIVE)("BA-P02-001 active late delta on disposable PostgreSQL 17", () => {
  let database = "";
  let container = "";
  let cwd = "";
  let localDataDir = "";
  let startedDocker = false;
  let seed: PrismaClient | null = null;
  let accountId = "";
  let quarantineId = "";
  let materialId = "";
  let port = "";

  beforeAll(async () => {
    const runId = randomBytes(4).toString("hex");
    database = `p1iso_${runId}`;
    expect(database.startsWith("p1iso_")).toBe(true);
    expect(FORBIDDEN_DATABASES.has(database)).toBe(false);
    const dbPassword = randomBytes(16).toString("hex");
    container = `p1iso-latedelta-${runId}`;
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "p1iso-latedelta-"));
    expect(path.resolve(cwd).startsWith(path.resolve(root))).toBe(false);
    fs.cpSync(path.join(root, "prisma"), path.join(cwd, "prisma"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".env"), "DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked\n");
    port = await startPostgres17({
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
    expect(FORBIDDEN_PORTS.has(port)).toBe(false);
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
    expect(identity[0]?.version).not.toContain("PostgreSQL 18");
    await seed.setting.create({ data: { key: PRODUCTION_COST_FLOW_KEY, value: GATE } });
    expect(await isCostFlowActive()).toBe(true);
    console.info(
      `R2-LATE-DELTA-EVIDENCE database=${database} port=${port} version=${identity[0]?.version} gate={\"version\":1,\"active\":true} docker=${startedDocker}`,
    );
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

  async function makeLot(batchId: string, lot: LotSeed) {
    return seed!.railLot.create({
      data: {
        batchId,
        lengthM: "1.0000",
        railType: "POLKA",
        sort: "SORT1",
        quantity: lot.quantity ?? 10,
        remainingQuantity: lot.remainingQuantity ?? lot.quantity ?? 10,
        initialValue: lot.initial,
        remainingValue: lot.remaining,
      },
    });
  }

  async function dealWith(
    name: string,
    batchIds: string[],
    amount: string,
    flags?: { confirmed?: boolean; transfer?: boolean },
  ) {
    const deal = await seed!.deal.create({ data: { name, total: 0 } });
    for (const batchId of batchIds) {
      await seed!.dealItem.create({ data: { dealId: deal.id, batchId } });
    }
    const flow = await seed!.cashFlow.create({
      data: {
        amount,
        flowType: "EXPENSE",
        accountId: flags?.confirmed === false ? quarantineId : accountId,
        dealId: deal.id,
        date: WHEN,
        isTransfer: flags?.transfer === true,
      },
    });
    return { dealId: deal.id, cashFlowId: flow.id };
  }

  async function capture(batchIds: string[]): Promise<MoneySnap> {
    const batches = await seed!.batch.findMany({ where: { id: { in: batchIds } } });
    const lots = await seed!.railLot.findMany({ where: { batchId: { in: batchIds } } });
    const events = await seed!.costEvent.findMany({ where: { batchId: { in: batchIds } } });
    const finals = await seed!.batchCost.findMany({
      where: { batchId: { in: batchIds }, status: "FINAL" },
    });
    const byId = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
    return {
      batches: batches
        .map((batch) => ({
          id: batch.id,
          total: batch.totalCost.toFixed(2),
          frozen: batch.frozenAt?.toISOString() ?? null,
        }))
        .sort((a, b) => byId(a.id, b.id)),
      lots: lots
        .map((lot) => ({
          id: lot.id,
          batchId: lot.batchId,
          initial: lot.initialValue?.toFixed(6) ?? null,
          remaining: lot.remainingValue?.toFixed(6) ?? null,
        }))
        .sort((a, b) => byId(a.batchId, b.batchId) || byId(a.id, b.id)),
      events: events
        .map((event) => ({
          id: event.id,
          type: event.type,
          batchId: event.batchId,
          total: event.totalValue.toFixed(6),
          material: event.materialValue.toFixed(6),
          labor: event.laborValue.toFixed(6),
          nomenclature: event.nomenclatureValue.toFixed(6),
        }))
        .sort((a, b) => byId(a.id, b.id)),
      finals: finals
        .map((row) => ({
          id: row.id,
          batchId: row.batchId,
          status: row.status,
          cost1: row.costSort1.toFixed(2),
          cost2: row.costSort2.toFixed(2),
        }))
        .sort((a, b) => byId(a.id, b.id)),
    };
  }

  function view(snap: MoneySnap) {
    return {
      batches: snap.batches.map((batch) => ({ id: batch.id, total: batch.total })),
      lots: snap.lots.map((lot) => ({
        batchId: lot.batchId,
        initial: lot.initial,
        remaining: lot.remaining,
      })),
      events: snap.events.map((event) => ({
        type: event.type,
        batchId: event.batchId,
        total: event.total,
        material: event.material,
        labor: event.labor,
        nomenclature: event.nomenclature,
      })),
      finals: snap.finals,
    };
  }

  function assertConserved(before: MoneySnap, after: MoneySnap) {
    const batchDelta = sum(after.batches.map((batch) => batch.total)).minus(
      sum(before.batches.map((batch) => batch.total)),
    );
    const lotDelta = sum(after.lots.map((lot) => lot.remaining ?? "0")).minus(
      sum(before.lots.map((lot) => lot.remaining ?? "0")),
    );
    const seen = new Set(before.events.map((event) => event.id));
    const fresh = after.events.filter((event) => !seen.has(event.id));
    expect(fresh.every((event) => event.type === "PURCHASE_VARIANCE")).toBe(true);
    expect(
      fresh.every(
        (event) =>
          event.labor === "0.000000" &&
          event.nomenclature === "0.000000" &&
          event.material === event.total,
      ),
    ).toBe(true);
    const variance = sum(fresh.map((event) => event.total));
    expect(lotDelta.plus(variance).toFixed(6)).toBe(batchDelta.toFixed(6));
    const initials = new Map(before.lots.map((lot) => [lot.id, lot.initial]));
    for (const lot of after.lots) {
      expect(lot.initial).toBe(initials.get(lot.id));
      expect(dec(lot.remaining ?? "0").isNeg()).toBe(false);
    }
    expect(after.finals).toEqual(before.finals);
  }

  async function syncThree(dealId: string, batchIds: string[]) {
    const snaps = [await capture(batchIds)];
    for (let pass = 0; pass < 3; pass += 1) {
      await syncDealInternal(dealId);
      snaps.push(await capture(batchIds));
    }
    expect(snaps[2]).toEqual(snaps[1]);
    expect(snaps[3]).toEqual(snaps[1]);
    assertConserved(snaps[0]!, snaps[1]!);
    assertConserved(snaps[1]!, snaps[2]!);
    return snaps;
  }

  it("исторический случай 1: 20.01 на двух партиях не двигает пул повторно", async () => {
    await makeBatch("h1-a", "10.00");
    await makeBatch("h1-b", "10.00");
    await makeLot("h1-a", { initial: "10.000000", remaining: "10.000000" });
    await makeLot("h1-b", { initial: "10.000000", remaining: "10.000000" });
    const deal = await dealWith("случай 1", ["h1-b", "h1-a"], "20.01");
    const snaps = await syncThree(deal.dealId, ["h1-a", "h1-b"]);
    expect(view(snaps[1]!)).toEqual({
      batches: [
        { id: "h1-a", total: "10.00" },
        { id: "h1-b", total: "10.01" },
      ],
      lots: [
        { batchId: "h1-a", initial: "10.000000", remaining: "10.000000" },
        { batchId: "h1-b", initial: "10.000000", remaining: "10.010000" },
      ],
      events: [],
      finals: [],
    });
    expect(view(snaps[2]!)).toEqual(view(snaps[1]!));
    expect(view(snaps[3]!)).toEqual(view(snaps[1]!));
  }, 60_000);

  it("исторический случай 2: 130.00 делится 43.33/43.33/43.34 независимо от порядка строк", async () => {
    await makeBatch("h2-a", "10.00");
    await makeBatch("h2-b", "10.00");
    await makeBatch("h2-c", "10.00");
    for (const id of ["h2-a", "h2-b", "h2-c"]) {
      await makeLot(id, { initial: "10.000000", remaining: "10.000000" });
    }
    const deal = await dealWith("случай 2", ["h2-c", "h2-a", "h2-b"], "130.00");
    const snaps = await syncThree(deal.dealId, ["h2-a", "h2-b", "h2-c"]);
    expect(view(snaps[1]!)).toEqual({
      batches: [
        { id: "h2-a", total: "43.33" },
        { id: "h2-b", total: "43.33" },
        { id: "h2-c", total: "43.34" },
      ],
      lots: [
        { batchId: "h2-a", initial: "10.000000", remaining: "43.330000" },
        { batchId: "h2-b", initial: "10.000000", remaining: "43.330000" },
        { batchId: "h2-c", initial: "10.000000", remaining: "43.340000" },
      ],
      events: [],
      finals: [],
    });

    await makeBatch("h2f-a", "10.00");
    await makeBatch("h2f-b", "10.00");
    await makeBatch("h2f-c", "10.00");
    for (const id of ["h2f-a", "h2f-b", "h2f-c"]) {
      await makeLot(id, { initial: "10.000000", remaining: "10.000000" });
    }
    const forward = await dealWith("случай 2 прямой порядок", ["h2f-a", "h2f-b", "h2f-c"], "130.00");
    const forwardSnaps = await syncThree(forward.dealId, ["h2f-a", "h2f-b", "h2f-c"]);
    expect(forwardSnaps[1]!.batches.map((batch) => batch.total)).toEqual(["43.33", "43.33", "43.34"]);
    expect(forwardSnaps[1]!.lots.map((lot) => lot.remaining)).toEqual([
      "43.330000",
      "43.330000",
      "43.340000",
    ]);
    expect(forwardSnaps[1]!.events).toEqual([]);
  }, 60_000);

  it("одна партия с положительной доплатой остаётся неизменной на втором и третьем пересчёте", async () => {
    await makeBatch("one", "10.00");
    await makeLot("one", { initial: "10.000000", remaining: "10.000000" });
    const deal = await dealWith("одна партия", ["one"], "12.50");
    const snaps = await syncThree(deal.dealId, ["one"]);
    expect(view(snaps[1]!)).toEqual({
      batches: [{ id: "one", total: "12.50" }],
      lots: [{ batchId: "one", initial: "10.000000", remaining: "12.500000" }],
      events: [],
      finals: [],
    });
  }, 60_000);

  it("несколько лотов одной партии делят дельту один раз", async () => {
    await makeBatch("lots", "10.00");
    await makeLot("lots", { initial: "6.000000", remaining: "6.000000" });
    await makeLot("lots", { initial: "4.000000", remaining: "4.000000" });
    const deal = await dealWith("два лота", ["lots"], "20.00");
    const snaps = await syncThree(deal.dealId, ["lots"]);
    expect(snaps[1]!.batches).toEqual([{ id: "lots", total: "20.00", frozen: null }]);
    expect(snaps[1]!.lots.map((lot) => lot.remaining).sort()).toEqual(["12.000000", "8.000000"]);
    expect(snaps[1]!.lots.map((lot) => lot.initial).sort()).toEqual(["4.000000", "6.000000"]);
    expect(snaps[1]!.events).toEqual([]);
  }, 60_000);

  it("частично списанный лот принимает положительную и отрицательную дельту без повторного движения", async () => {
    await makeBatch("part", "10.00");
    await makeLot("part", {
      initial: "10.000000",
      remaining: "4.000000",
      quantity: 10,
      remainingQuantity: 4,
    });
    const deal = await dealWith("частичный лот", ["part"], "16.00");
    const up = await syncThree(deal.dealId, ["part"]);
    expect(view(up[1]!)).toEqual({
      batches: [{ id: "part", total: "16.00" }],
      lots: [{ batchId: "part", initial: "10.000000", remaining: "6.400000" }],
      events: [
        {
          type: "PURCHASE_VARIANCE",
          batchId: "part",
          total: "3.600000",
          material: "3.600000",
          labor: "0.000000",
          nomenclature: "0.000000",
        },
      ],
      finals: [],
    });
    await seed!.cashFlow.update({ where: { id: deal.cashFlowId }, data: { amount: "13.00" } });
    const down = await syncThree(deal.dealId, ["part"]);
    expect(view(down[1]!)).toEqual({
      batches: [{ id: "part", total: "13.00" }],
      lots: [{ batchId: "part", initial: "10.000000", remaining: "5.200000" }],
      events: [
        ...view(up[1]!).events,
        {
          type: "PURCHASE_VARIANCE",
          batchId: "part",
          total: "-1.800000",
          material: "-1.800000",
          labor: "0.000000",
          nomenclature: "0.000000",
        },
      ],
      finals: [],
    });
  }, 60_000);

  it("полностью списанный лот оставляет остаток нулевым и пишет всю дельту в расхождение", async () => {
    await makeBatch("gone", "10.00");
    await makeLot("gone", {
      initial: "10.000000",
      remaining: "0.000000",
      quantity: 10,
      remainingQuantity: 0,
    });
    const deal = await dealWith("нулевой остаток", ["gone"], "15.00");
    const up = await syncThree(deal.dealId, ["gone"]);
    expect(view(up[1]!)).toEqual({
      batches: [{ id: "gone", total: "15.00" }],
      lots: [{ batchId: "gone", initial: "10.000000", remaining: "0.000000" }],
      events: [
        {
          type: "PURCHASE_VARIANCE",
          batchId: "gone",
          total: "5.000000",
          material: "5.000000",
          labor: "0.000000",
          nomenclature: "0.000000",
        },
      ],
      finals: [],
    });
    await seed!.cashFlow.update({ where: { id: deal.cashFlowId }, data: { amount: "12.00" } });
    const down = await syncThree(deal.dealId, ["gone"]);
    expect(down[1]!.lots[0]!.remaining).toBe("0.000000");
    expect(down[1]!.lots[0]!.initial).toBe("10.000000");
    expect(down[1]!.events.map((event) => event.total).sort()).toEqual(["-3.000000", "5.000000"]);
    expect(down[1]!.batches[0]!.total).toBe("12.00");
  }, 60_000);

  it("доля меньше копейки на границе q6 применяется один раз", async () => {
    await makeBatch("frac", "10.00");
    await makeLot("frac", { initial: "4.000000", remaining: "4.000000" });
    await makeLot("frac", { initial: "3.000000", remaining: "3.000000" });
    await makeLot("frac", { initial: "3.000000", remaining: "3.000000" });
    const deal = await dealWith("доля q6", ["frac"], "10.01");
    const snaps = await syncThree(deal.dealId, ["frac"]);
    expect(snaps[1]!.batches[0]!.total).toBe("10.01");
    expect(snaps[1]!.events).toEqual([]);
    expect(snaps[1]!.lots.map((lot) => `${lot.initial}->${lot.remaining}`).sort()).toEqual([
      "3.000000->3.003000",
      "3.000000->3.003000",
      "4.000000->4.004000",
    ]);
  }, 60_000);

  it("неинициализированный лот закрывается отказом и откатывает пересчёт", async () => {
    await makeBatch("raw", "10.00");
    await makeLot("raw", { initial: null, remaining: null });
    const deal = await dealWith("пустой лот", ["raw"], "12.00");
    const before = await capture(["raw"]);
    const dealBefore = (await seed!.deal.findUniqueOrThrow({ where: { id: deal.dealId } })).total.toFixed(2);
    await expect(syncDealInternal(deal.dealId)).rejects.toThrow(COST_FLOW_LOT_UNINITIALIZED);
    expect(await capture(["raw"])).toEqual(before);
    expect((await seed!.deal.findUniqueOrThrow({ where: { id: deal.dealId } })).total.toFixed(2)).toBe(dealBefore);
  }, 60_000);

  it("нулевая прежняя стоимость по-прежнему запрещает позднюю дельту и откатывается", async () => {
    await makeBatch("zero", "0.00");
    await makeLot("zero", { initial: "0.000000", remaining: "0.000000", quantity: 1, remainingQuantity: 1 });
    const deal = await dealWith("нулевая партия", ["zero"], "5.00");
    const before = await capture(["zero"]);
    await expect(syncDealInternal(deal.dealId)).rejects.toThrow(COST_FLOW_C_OLD_ZERO);
    expect(await capture(["zero"])).toEqual(before);
    expect((await seed!.deal.findUniqueOrThrow({ where: { id: deal.dealId } })).total.toFixed(2)).toBe("0.00");
  }, 60_000);

  it("замороженная партия и её FINAL не переписываются, смесь с открытой откатывается", async () => {
    await makeBatch("frozen", "10.00", true);
    await makeLot("frozen", { initial: "10.000000", remaining: "10.000000" });
    const finalRow = await seed!.batchCost.create({
      data: {
        batchId: "frozen",
        status: "FINAL",
        volumeSort1: "1.000000",
        volumeSort2: "0.000000",
        costSort1: "6.00",
        costSort2: "4.00",
        pricePerM3Sort1: "6.00",
        pricePerM3Sort2: "4.00",
      },
    });
    const frozenDeal = await dealWith("только заморозка", ["frozen"], "15.00");
    const snaps = await syncThree(frozenDeal.dealId, ["frozen"]);
    expect(snaps[0]).toEqual(snaps[3]);
    expect(snaps[3]!.batches[0]).toEqual({
      id: "frozen",
      total: "10.00",
      frozen: WHEN.toISOString(),
    });
    expect(snaps[3]!.finals).toEqual([
      { id: finalRow.id, batchId: "frozen", status: "FINAL", cost1: "6.00", cost2: "4.00" },
    ]);
    expect((await seed!.deal.findUniqueOrThrow({ where: { id: frozenDeal.dealId } })).total.toFixed(2)).toBe("15.00");

    await makeBatch("mix-open", "10.00");
    await makeLot("mix-open", { initial: "10.000000", remaining: "10.000000" });
    const mixed = await dealWith("смесь", ["mix-open", "frozen"], "120.00");
    const before = await capture(["mix-open", "frozen"]);
    const mixedDeal = (await seed!.deal.findUniqueOrThrow({ where: { id: mixed.dealId } })).total.toFixed(2);
    await expect(syncDealInternal(mixed.dealId)).rejects.toThrow(DEAL_EXTRA_FROZEN_MIX);
    expect(await capture(["mix-open", "frozen"])).toEqual(before);
    expect((await seed!.deal.findUniqueOrThrow({ where: { id: mixed.dealId } })).total.toFixed(2)).toBe(mixedDeal);
  }, 60_000);

  it("неподтверждённый расход и перевод не становятся доплатой закупки", async () => {
    await makeBatch("cash", "10.00");
    await makeLot("cash", { initial: "10.000000", remaining: "10.000000" });
    const deal = await dealWith("карантин", ["cash"], "80.00", { confirmed: false });
    await seed!.cashFlow.create({
      data: {
        amount: "25.00",
        flowType: "EXPENSE",
        accountId,
        dealId: deal.dealId,
        date: WHEN,
        isTransfer: true,
      },
    });
    const ignored = await syncThree(deal.dealId, ["cash"]);
    expect(view(ignored[1]!)).toEqual(view(ignored[0]!));
    expect(ignored[1]!.batches[0]!.total).toBe("10.00");

    await seed!.cashFlow.create({
      data: {
        amount: "15.00",
        flowType: "EXPENSE",
        accountId,
        dealId: deal.dealId,
        date: WHEN,
        isTransfer: false,
      },
    });
    const priced = await syncThree(deal.dealId, ["cash"]);
    expect(priced[1]!.batches[0]!.total).toBe("15.00");
    expect(priced[1]!.lots[0]!.remaining).toBe("15.000000");
    expect(priced[1]!.lots[0]!.initial).toBe("10.000000");
    expect(priced[1]!.events).toEqual([]);
    expect(priced[3]).toEqual(priced[1]);
  }, 60_000);

  it("две сделки на одной партии не повторяют распределение", async () => {
    await makeBatch("share", "10.00");
    await makeBatch("other", "10.00");
    await makeLot("share", { initial: "10.000000", remaining: "10.000000" });
    await makeLot("other", { initial: "10.000000", remaining: "10.000000" });
    const first = await dealWith("первая сделка", ["share", "other"], "20.01");
    const second = await dealWith("вторая сделка", ["share"], "10.05");
    await syncDealInternal(first.dealId);
    await syncDealInternal(second.dealId);
    const once = await capture(["share", "other"]);
    await syncDealInternal(first.dealId);
    await syncDealInternal(second.dealId);
    const twice = await capture(["share", "other"]);
    expect(twice).toEqual(once);
    expect(view(once).batches).toEqual([
      { id: "other", total: "10.00" },
      { id: "share", total: "10.06" },
    ]);
    expect(once.lots.find((lot) => lot.batchId === "share")).toMatchObject({
      initial: "10.000000",
      remaining: "10.060000",
    });
    expect(once.lots.find((lot) => lot.batchId === "other")).toMatchObject({
      initial: "10.000000",
      remaining: "10.000000",
    });
    expect(once.events).toEqual([]);
  }, 60_000);

  it("повторные строки одной партии не удваивают доплату", async () => {
    await makeBatch("dup", "10.00");
    await makeLot("dup", { initial: "10.000000", remaining: "10.000000" });
    const deal = await seed!.deal.create({ data: { name: "три строки", total: "0.00" } });
    for (let copy = 0; copy < 3; copy += 1) {
      await seed!.dealItem.create({ data: { dealId: deal.id, batchId: "dup" } });
    }
    await seed!.cashFlow.create({
      data: {
        amount: "30.10",
        flowType: "EXPENSE",
        accountId,
        dealId: deal.id,
        date: WHEN,
        isTransfer: false,
      },
    });
    const snaps = await syncThree(deal.id, ["dup"]);
    expect((await seed!.deal.findUniqueOrThrow({ where: { id: deal.id } })).total.toFixed(2)).toBe("30.10");
    expect(view(snaps[1]!)).toEqual({
      batches: [{ id: "dup", total: "30.10" }],
      lots: [{ batchId: "dup", initial: "10.000000", remaining: "30.100000" }],
      events: [],
      finals: [],
    });
  }, 60_000);

  it("при выключенном контуре пересчёт меняет стоимость партии и не двигает лот", async () => {
    await seed!.setting.update({
      where: { key: PRODUCTION_COST_FLOW_KEY },
      data: { value: { version: 1, active: false } },
    });
    try {
      expect(await isCostFlowActive()).toBe(false);
      await makeBatch("off", "10.00");
      await makeLot("off", { initial: "10.000000", remaining: "10.000000" });
      const deal = await dealWith("контур выключен", ["off"], "15.00");
      const before = await capture(["off"]);
      await syncDealInternal(deal.dealId);
      await syncDealInternal(deal.dealId);
      const after = await capture(["off"]);
      expect(after.batches[0]!.total).toBe("15.00");
      expect(after.lots).toEqual(before.lots);
      expect(after.events).toEqual([]);
      expect(after.finals).toEqual([]);
    } finally {
      await seed!.setting.update({
        where: { key: PRODUCTION_COST_FLOW_KEY },
        data: { value: GATE },
      });
      expect(await isCostFlowActive()).toBe(true);
    }
  }, 60_000);
});
