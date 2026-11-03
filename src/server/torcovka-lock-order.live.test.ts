import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { productionCancelFingerprint } from "@/lib/production-operation-cancel";
import { newRequestId } from "@/lib/request-id";
import { runDisposableMigrate } from "@/server/internal/disposable-migrate/guard";
import { PRODUCTION_COST_FLOW_KEY } from "@/server/internal/cost-flow-state";
import { CANCEL_FROZEN_BLOCKED } from "@/lib/production-operation-cancel";

const gate = vi.hoisted(() => ({
  admin: { id: "pending-admin", name: "Проверка", email: "locks@example.invalid", role: "ADMIN" as const },
}));

const harness = vi.hoisted(() => ({
  url: "",
  client: null as PrismaClient | null,
}));

vi.mock("@/server/session", () => ({
  requireAdmin: async () => gate.admin,
  requireTerminalEmployee: async (expectedEmployeeId?: string) => ({
    id: expectedEmployeeId ?? "missing-employee",
    fullName: "Резчик",
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ set: vi.fn(), delete: vi.fn() })),
  headers: vi.fn(async () => new Headers()),
}));
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

import { cancelProductionOperation, correctTorcovkaRailsTaken } from "@/server/production";
import { submitTorcovka } from "@/server/terminal";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PG17_BIN = process.env.P1_PG17_BIN ?? "C:\\Users\\bocma\\AppData\\Local\\Temp\\pg17\\pgsql\\bin";
const FORBIDDEN_PORTS = new Set(["5432", "5433", "5434"]);

function pause(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function signal() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const extra = err as Error & { code?: string; meta?: { code?: string } };
    return `${extra.code ?? ""} ${extra.meta?.code ?? ""} ${extra.message}`;
  }
  return String(err);
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
      server.close(() => resolve(String(address.port)));
    });
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

type Held = {
  employeeId: string;
  batchId: string;
  lotId: string;
  operationId: string;
  fingerprint: string;
};

describe("BA-P11-001 lock order on disposable PostgreSQL 17", () => {
  let runId = "";
  let database = "";
  let dbPassword = "";
  let container = "";
  let cwd = "";
  let localDataDir = "";
  let startedDocker = false;
  let seed: PrismaClient | null = null;
  let seq = 0;

  beforeAll(async () => {
    runId = randomBytes(4).toString("hex");
    database = `p1iso_${runId}`;
    dbPassword = randomBytes(16).toString("hex");
    container = `p1iso-lock-${runId}`;
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "p1iso-lock-"));
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
    const user = await seed.user.create({
      data: { email: `locks-${runId}@example.invalid`, passwordHash: "not-a-login", name: "Проверка" },
    });
    gate.admin = { id: user.id, name: user.name, email: user.email, role: "ADMIN" };
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
    if (cwd) {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          fs.rmSync(cwd, { recursive: true, force: true });
          break;
        } catch (err) {
          const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";
          if ((code !== "EBUSY" && code !== "EPERM") || attempt === 9) throw err;
          pause(300);
        }
      }
    }
  });

  async function holdPair(label: string): Promise<{ batchId: string; lotId: string }> {
    seq += 1;
    const material = await seed!.material.create({
      data: { name: `${label}-${runId}-${seq}`, sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    const batch = await seed!.batch.create({
      data: {
        name: `партия-${label}-${runId}-${seq}`,
        materialId: material.id,
        sectionWidthMm: 40,
        sectionHeightMm: 20,
        purchaseCost: 1000,
        totalCost: 1000,
        priceSort1: 1000,
        priceSort2: 500,
        purchaseDate: new Date("2026-03-01T00:00:00.000Z"),
        status: "IN_WORK",
      },
    });
    const lot = await seed!.railLot.create({
      data: {
        batchId: batch.id,
        lengthM: 2,
        railType: "POLKA",
        sort: "SORT1",
        isPackage: true,
        quantity: 4,
        remainingQuantity: 4,
      },
    });
    return { batchId: batch.id, lotId: lot.id };
  }

  async function lockRow(tx: Prisma.TransactionClient, table: "Batch" | "RailLot", id: string) {
    await tx.$executeRaw`SET LOCAL deadlock_timeout = '500ms'`;
    if (table === "Batch") {
      await tx.$queryRaw`SELECT id FROM "Batch" WHERE id = ${id} FOR UPDATE`;
    } else {
      await tx.$queryRaw`SELECT id FROM "RailLot" WHERE id = ${id} FOR UPDATE`;
    }
  }

  it("returns 40P01 when Batch-then-RailLot meets RailLot-then-Batch", async () => {
    const pair = await holdPair("deadlock");
    const batchHeld = signal();
    const lotHeld = signal();
    const left = seed!.$transaction(async (tx) => {
      await lockRow(tx, "Batch", pair.batchId);
      batchHeld.resolve();
      await lotHeld.promise;
      await lockRow(tx, "RailLot", pair.lotId);
    }, { maxWait: 10_000, timeout: 10_000 });
    const right = seed!.$transaction(async (tx) => {
      await batchHeld.promise;
      await lockRow(tx, "RailLot", pair.lotId);
      lotHeld.resolve();
      await lockRow(tx, "Batch", pair.batchId);
    }, { maxWait: 10_000, timeout: 10_000 });
    const settled = await Promise.allSettled([left, right]);
    const rejected = settled.filter((item) => item.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(errorText((rejected[0] as PromiseRejectedResult).reason)).toContain("40P01");
    expect(settled.some((item) => item.status === "fulfilled")).toBe(true);
  }, 30_000);

  it("commits both sides when each transaction locks RailLot before Batch", async () => {
    const pair = await holdPair("aligned");
    const lotHeld = signal();
    const left = seed!.$transaction(async (tx) => {
      await lockRow(tx, "RailLot", pair.lotId);
      lotHeld.resolve();
      await lockRow(tx, "Batch", pair.batchId);
    }, { maxWait: 10_000, timeout: 10_000 });
    const right = seed!.$transaction(async (tx) => {
      await lotHeld.promise;
      await lockRow(tx, "RailLot", pair.lotId);
      await lockRow(tx, "Batch", pair.batchId);
    }, { maxWait: 10_000, timeout: 10_000 });
    const settled = await Promise.allSettled([left, right]);
    expect(settled.map((item) => item.status)).toEqual(["fulfilled", "fulfilled"]);
  }, 30_000);

  async function heldCut(): Promise<Held> {
    seq += 1;
    const material = await seed!.material.create({
      data: { name: `рез-${runId}-${seq}`, sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    const employee = await seed!.employee.create({
      data: { fullName: `Резчик ${seq}`, pin: String(4000 + seq), rateTorcovkaSort1: 100 },
    });
    const batch = await seed!.batch.create({
      data: {
        name: `работа-${runId}-${seq}`,
        materialId: material.id,
        sectionWidthMm: 40,
        sectionHeightMm: 20,
        purchaseCost: 8000,
        totalCost: 8000,
        priceSort1: 20000,
        priceSort2: 10000,
        purchaseDate: new Date("2026-03-02T00:00:00.000Z"),
        status: "IN_WORK",
      },
    });
    const lot = await seed!.railLot.create({
      data: {
        batchId: batch.id,
        lengthM: new Prisma.Decimal(2),
        railType: "POLKA",
        sort: "SORT1",
        isPackage: true,
        quantity: 6,
        remainingQuantity: 4,
      },
    });
    const op = await seed!.productionOperation.create({
      data: {
        type: "TORCOVKA",
        employeeId: employee.id,
        workDate: new Date("2026-03-02T00:00:00.000Z"),
        clientRequestId: newRequestId(),
        batchId: batch.id,
        railLotId: lot.id,
        railsTaken: 2,
        rateSnapshotVersion: 1,
        lines: {
          create: [{
            quantity: 1,
            blankLengthM: new Prisma.Decimal(2),
            blankType: "POLKA",
            blankSort: "SORT1",
            blankMaterialId: material.id,
          }],
        },
      },
      include: { lines: true },
    });
    await seed!.blankStock.create({
      data: {
        materialId: material.id,
        lengthM: new Prisma.Decimal(2),
        detailType: "POLKA",
        sort: "SORT1",
        quantity: 1,
      },
    });
    return {
      employeeId: employee.id,
      batchId: batch.id,
      lotId: lot.id,
      operationId: op.id,
      fingerprint: productionCancelFingerprint({
        operationId: op.id,
        type: op.type,
        isPaid: op.isPaid,
        cancelledAt: null,
        railsTaken: op.railsTaken,
        hours: null,
        productQty: null,
        lines: op.lines.map((line) => ({ id: line.id, quantity: line.quantity })),
      }),
    };
  }

  async function snapshot(held: Held) {
    const lot = await seed!.railLot.findUniqueOrThrow({ where: { id: held.lotId } });
    const batch = await seed!.batch.findUniqueOrThrow({ where: { id: held.batchId } });
    const ops = await seed!.productionOperation.count({ where: { batchId: held.batchId } });
    const blanks = await seed!.blankStock.findMany({ where: { materialId: (await seed!.batch.findUniqueOrThrow({ where: { id: held.batchId } })).materialId } });
    return { lot, batch, ops, blanks };
  }

  it("runs a new cut beside a rail correction without a deadlock or duplicated stock", async () => {
    const held = await heldCut();
    const requestId = newRequestId();
    const submitId = newRequestId();
    const settled = await Promise.allSettled([
      submitTorcovka({
        employeeId: held.employeeId,
        batchId: held.batchId,
        railLotId: held.lotId,
        railsTaken: 1,
        picks: [{ lengthM: 2, sort: "SORT1", quantity: 1 }],
        clientRequestId: submitId,
      }),
      correctTorcovkaRailsTaken({
        operationId: held.operationId,
        expectedOldRailsTaken: 2,
        newRailsTaken: 1,
        reason: "рейка возвращена корректировкой",
        requestId,
      }),
    ]);
    expect(settled.every((item) => item.status === "fulfilled")).toBe(true);
    const replay = await correctTorcovkaRailsTaken({
      operationId: held.operationId,
      expectedOldRailsTaken: 2,
      newRailsTaken: 1,
      reason: "рейка возвращена корректировкой",
      requestId,
    });
    expect(replay.replayed).toBe(true);
    await submitTorcovka({
      employeeId: held.employeeId,
      batchId: held.batchId,
      railLotId: held.lotId,
      railsTaken: 1,
      picks: [{ lengthM: 2, sort: "SORT1", quantity: 1 }],
      clientRequestId: submitId,
    });
    const seen = await snapshot(held);
    expect(seen.lot.remainingQuantity).toBe(4);
    expect(seen.lot.remainingQuantity).toBeGreaterThanOrEqual(0);
    expect(seen.batch.status).toBe("IN_WORK");
    expect(seen.ops).toBe(2);
    expect(await seed!.productionOperationCorrection.count({ where: { operationId: held.operationId } })).toBe(1);
    expect(await seed!.setting.findUnique({ where: { key: PRODUCTION_COST_FLOW_KEY } })).toBeNull();
  }, 30_000);

  it("runs a new cut beside cancellation without a deadlock or negative stock", async () => {
    const held = await heldCut();
    const requestId = newRequestId();
    const settled = await Promise.allSettled([
      submitTorcovka({
        employeeId: held.employeeId,
        batchId: held.batchId,
        railLotId: held.lotId,
        railsTaken: 1,
        picks: [{ lengthM: 2, sort: "SORT1", quantity: 1 }],
        clientRequestId: newRequestId(),
      }),
      cancelProductionOperation({
        operationId: held.operationId,
        requestId,
        reason: "отмена рядом с новым резом",
        expectedStateFingerprint: held.fingerprint,
      }),
    ]);
    expect(settled.every((item) => item.status === "fulfilled")).toBe(true);
    const replay = await cancelProductionOperation({
      operationId: held.operationId,
      requestId,
      reason: "отмена рядом с новым резом",
      expectedStateFingerprint: held.fingerprint,
    });
    expect(replay.replayed).toBe(true);
    const seen = await snapshot(held);
    expect(seen.lot.remainingQuantity).toBe(5);
    expect(seen.lot.remainingQuantity).toBeLessThanOrEqual(seen.lot.quantity);
    expect(seen.batch.status).toBe("IN_WORK");
    expect(seen.ops).toBe(2);
    expect(await seed!.productionOperationCancellation.count({ where: { operationId: held.operationId } })).toBe(1);
  }, 30_000);

  it("lets correction and cancellation serialize without applying both stock effects", async () => {
    const held = await heldCut();
    const settled = await Promise.allSettled([
      correctTorcovkaRailsTaken({
        operationId: held.operationId,
        expectedOldRailsTaken: 2,
        newRailsTaken: 1,
        reason: "корректировка против отмены",
        requestId: newRequestId(),
      }),
      cancelProductionOperation({
        operationId: held.operationId,
        requestId: newRequestId(),
        reason: "отмена против корректировки",
        expectedStateFingerprint: held.fingerprint,
      }),
    ]);
    expect(settled.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((item) => item.status === "rejected") as PromiseRejectedResult;
    expect(errorText(rejected.reason)).not.toContain("40P01");
    const seen = await snapshot(held);
    const cancelled = await seed!.productionOperation.findUniqueOrThrow({ where: { id: held.operationId } });
    expect(seen.lot.remainingQuantity).toBeGreaterThanOrEqual(0);
    expect(seen.lot.remainingQuantity).toBeLessThanOrEqual(seen.lot.quantity);
    expect(seen.ops).toBe(1);
    if (cancelled.cancelledAt) {
      expect(seen.lot.remainingQuantity).toBe(6);
      expect(cancelled.railsTaken).toBe(2);
    } else {
      expect(seen.lot.remainingQuantity).toBe(5);
      expect(cancelled.railsTaken).toBe(1);
    }
    expect(seen.batch.status).toBe("IN_WORK");
    expect(seen.batch.closedAt).toBeNull();
  }, 30_000);

  it("still refuses cancellation of a frozen batch before changing stock", async () => {
    const held = await heldCut();
    await seed!.batch.update({ where: { id: held.batchId }, data: { frozenAt: new Date() } });
    await expect(
      cancelProductionOperation({
        operationId: held.operationId,
        requestId: newRequestId(),
        reason: "партия заморожена",
        expectedStateFingerprint: held.fingerprint,
      }),
    ).rejects.toThrow(CANCEL_FROZEN_BLOCKED);
    const lot = await seed!.railLot.findUniqueOrThrow({ where: { id: held.lotId } });
    expect(lot.remainingQuantity).toBe(4);
    expect((await seed!.productionOperation.findUniqueOrThrow({ where: { id: held.operationId } })).cancelledAt).toBeNull();
  }, 30_000);
});
