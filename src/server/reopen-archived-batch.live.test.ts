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
import { STALE_OPERATION_CANCEL, CANCEL_ALREADY } from "@/lib/production-operation-cancel";
import { TORCOVKA_GENERIC_DELETE_BLOCKED } from "@/lib/torcovka-delete-policy";
import { newRequestId } from "@/lib/request-id";
import { runDisposableMigrate } from "@/server/internal/disposable-migrate/guard";
import { PRODUCTION_COST_FLOW_KEY } from "@/server/internal/cost-flow-state";

const gate = vi.hoisted(() => ({
  admin: { id: "pending-admin", name: "Проверка", email: "reopen@example.invalid", role: "ADMIN" as const },
}));

const harness = vi.hoisted(() => ({
  url: "",
  client: null as { $disconnect: () => Promise<void> } | null,
}));

const recalc = vi.hoisted(() => vi.fn(async () => {}));

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
vi.mock("@/server/cost-queue", () => ({ enqueueRecalcBatchCosts: recalc }));

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

import { deleteProductionOperation, cancelProductionOperation } from "@/server/production";
import { getSalaryReport } from "@/server/payroll";
import { submitTorcovka } from "@/server/terminal";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LOCAL_PG_BIN = "C:\\Program Files\\PostgreSQL\\18\\bin";
const FORBIDDEN_PORTS = new Set(["5432", "5433", "5434"]);
const ARCHIVED_CUT = "Партия в архиве — торцовка недоступна";

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
      server.close(() => resolve(String(address.port)));
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
  if (init.status !== 0) throw new Error("disposable cluster init failed");
  input.markLocalDataDir(dataDir);
  const started = spawnSync(
    path.join(LOCAL_PG_BIN, "pg_ctl.exe"),
    ["-D", dataDir, "-l", path.join(input.cwd, "pg.log"), "-w", "-t", "30", "start", "-o", `-h 127.0.0.1 -p ${port}`],
    { encoding: "utf8", timeout: 40_000 },
  );
  if (started.status !== 0) throw new Error("disposable cluster start failed");
  const psql = path.join(LOCAL_PG_BIN, "psql.exe");
  const env = { ...process.env, PGCONNECT_TIMEOUT: "5" };
  const createdDb = spawnSync(
    psql,
    ["-X", "-h", "127.0.0.1", "-p", port, "-U", "p1iso", "-d", "postgres", "-q", "-v", "ON_ERROR_STOP=1", "-c", `CREATE DATABASE "${input.database}"`],
    { encoding: "utf8", env, timeout: 15_000, input: "" },
  );
  if (createdDb.status !== 0) throw new Error("disposable database create failed");
  return port;
}

type World = {
  materialId: string;
  employeeId: string;
  batchId: string;
  lotId: string;
  purchaseCost: string;
  totalCost: string;
};

function fingerprintOf(op: {
  id: string;
  type: string;
  isPaid: boolean;
  cancelledAt: Date | null;
  railsTaken: number | null;
  hours: { toString(): string } | null;
  productQty: number | null;
  lines: Array<{ id: string; quantity: number }>;
}): string {
  return productionCancelFingerprint({
    operationId: op.id,
    type: op.type,
    isPaid: op.isPaid,
    cancelledAt: op.cancelledAt ? op.cancelledAt.toISOString() : null,
    railsTaken: op.railsTaken,
    hours: op.hours == null ? null : op.hours.toString(),
    productQty: op.productQty,
    lines: op.lines.map((line) => ({ id: line.id, quantity: line.quantity })),
  });
}

describe("BA-P11-001 reopen on disposable PostgreSQL", () => {
  let runId = "";
  let database = "";
  let dbPassword = "";
  let container = "";
  let cwd = "";
  let localDataDir = "";
  let started = false;
  let seed: PrismaClient | null = null;
  let seq = 0;

  beforeAll(async () => {
    runId = randomBytes(4).toString("hex");
    database = `p1iso_${runId}`;
    dbPassword = randomBytes(16).toString("hex");
    container = `p1iso-reopen-${runId}`;
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "p1iso-reopen-"));
    fs.cpSync(path.join(root, "prisma"), path.join(cwd, "prisma"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".env"), "DATABASE_URL=postgresql://blocked@127.0.0.1:1/blocked\n");
    const port = await startDisposablePostgres({
      container,
      database,
      password: dbPassword,
      cwd,
      markDockerStarted: () => {
        started = true;
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
    const user = await seed.user.create({
      data: {
        email: `reopen-${runId}@example.invalid`,
        passwordHash: "not-a-login",
        name: "Проверка",
      },
    });
    gate.admin = { id: user.id, name: user.name, email: user.email, role: "ADMIN" };
  }, 180_000);

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

  async function seedBatch(input?: { remaining?: number; status?: "IN_WORK" | "ARCHIVED" }): Promise<World> {
    seq += 1;
    const remaining = input?.remaining ?? 1;
    const status = input?.status ?? "IN_WORK";
    const material = await seed!.material.create({
      data: { name: `порода-${runId}-${seq}`, sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    const employee = await seed!.employee.create({
      data: { fullName: `Резчик ${seq}`, pin: String(1000 + seq), rateTorcovkaSort1: new Prisma.Decimal(100) },
    });
    const batch = await seed!.batch.create({
      data: {
        name: `партия-${runId}-${seq}`,
        materialId: material.id,
        sectionWidthMm: new Prisma.Decimal(40),
        sectionHeightMm: new Prisma.Decimal(20),
        purchaseCost: new Prisma.Decimal(10000),
        totalCost: new Prisma.Decimal(10000),
        priceSort1: new Prisma.Decimal(30000),
        priceSort2: new Prisma.Decimal(20000),
        purchaseDate: new Date("2026-01-15T00:00:00.000Z"),
        status,
        closedAt: status === "ARCHIVED" ? new Date("2026-02-01T00:00:00.000Z") : null,
      },
    });
    const lot = await seed!.railLot.create({
      data: {
        batchId: batch.id,
        lengthM: new Prisma.Decimal(2),
        railType: "POLKA",
        sort: "SORT1",
        isPackage: true,
        quantity: Math.max(remaining, 1),
        remainingQuantity: remaining,
      },
    });
    return {
      materialId: material.id,
      employeeId: employee.id,
      batchId: batch.id,
      lotId: lot.id,
      purchaseCost: "10000",
      totalCost: "10000",
    };
  }

  async function cutOne(world: World) {
    const result = await submitTorcovka({
      employeeId: world.employeeId,
      batchId: world.batchId,
      railLotId: world.lotId,
      railsTaken: 1,
      picks: [{ lengthM: 2, sort: "SORT1", quantity: 1 }],
      clientRequestId: newRequestId(),
    });
    expect(result.status).toBe("CREATED");
    return seed!.productionOperation.findFirstOrThrow({
      where: { railLotId: world.lotId, cancelledAt: null },
      include: { lines: true },
      orderBy: { createdAt: "desc" },
    });
  }

  async function moneyOf(batchId: string) {
    const batch = await seed!.batch.findUniqueOrThrow({ where: { id: batchId } });
    return {
      status: batch.status,
      closedAt: batch.closedAt,
      purchaseCost: batch.purchaseCost.toString(),
      totalCost: batch.totalCost.toString(),
      priceSort1: batch.priceSort1.toString(),
      priceSort2: batch.priceSort2.toString(),
      frozenAt: batch.frozenAt,
    };
  }

  it("archives a batch when the last rail is consumed", async () => {
    const world = await seedBatch();
    await cutOne(world);
    const batch = await seed!.batch.findUniqueOrThrow({ where: { id: world.batchId } });
    const lot = await seed!.railLot.findUniqueOrThrow({ where: { id: world.lotId } });
    expect(lot.remainingQuantity).toBe(0);
    expect(batch.status).toBe("ARCHIVED");
    expect(batch.closedAt).not.toBeNull();
  }, 60_000);

  it("reopens that batch when cancellation restores the rail, then accepts a new cut", async () => {
    const world = await seedBatch();
    const other = await seedBatch({ remaining: 0, status: "ARCHIVED" });
    const historical = await seedBatch({ remaining: 4, status: "ARCHIVED" });
    const op = await cutOne(world);
    const before = await moneyOf(world.batchId);
    expect(before.status).toBe("ARCHIVED");
    await cancelProductionOperation({
      operationId: op.id,
      requestId: newRequestId(),
      reason: "последняя рейка возвращена",
      expectedStateFingerprint: fingerprintOf(op),
    });
    const lot = await seed!.railLot.findUniqueOrThrow({ where: { id: world.lotId } });
    const batch = await moneyOf(world.batchId);
    expect(lot.remainingQuantity).toBe(1);
    expect(lot.remainingValue).toBeNull();
    expect(batch.status).toBe("IN_WORK");
    expect(batch.closedAt).toBeNull();
    expect(batch.purchaseCost).toBe(before.purchaseCost);
    expect(batch.totalCost).toBe(before.totalCost);
    expect(batch.priceSort1).toBe(before.priceSort1);
    expect(batch.frozenAt).toBeNull();
    expect(await seed!.setting.findUnique({ where: { key: PRODUCTION_COST_FLOW_KEY } })).toBeNull();
    const salary = await getSalaryReport();
    expect(salary.find((row) => row.id === `unpaid:${world.employeeId}`)).toBeUndefined();
    expect(recalc).toHaveBeenCalledWith(world.batchId);

    const again = await cutOne(world);
    expect(again.id).not.toBe(op.id);
    const after = await moneyOf(world.batchId);
    const afterLot = await seed!.railLot.findUniqueOrThrow({ where: { id: world.lotId } });
    expect(afterLot.remainingQuantity).toBe(0);
    expect(after.status).toBe("ARCHIVED");
    const paid = await getSalaryReport();
    expect(paid.find((row) => row.id === `unpaid:${world.employeeId}`)?.total).toBe(100);

    expect(await moneyOf(other.batchId)).toMatchObject({ status: "ARCHIVED" });
    expect((await seed!.railLot.findUniqueOrThrow({ where: { id: other.lotId } })).remainingQuantity).toBe(0);
    expect(await moneyOf(historical.batchId)).toMatchObject({ status: "ARCHIVED" });
    expect((await seed!.railLot.findUniqueOrThrow({ where: { id: historical.lotId } })).remainingQuantity).toBe(4);
  }, 60_000);

  it("refuses a cut on an archived batch that still has no rails and on a historical archived batch", async () => {
    const empty = await seedBatch({ remaining: 0, status: "ARCHIVED" });
    const historical = await seedBatch({ remaining: 3, status: "ARCHIVED" });
    await expect(cutOne(empty)).rejects.toThrow(ARCHIVED_CUT);
    await expect(cutOne(historical)).rejects.toThrow(ARCHIVED_CUT);
    expect((await seed!.railLot.findUniqueOrThrow({ where: { id: empty.lotId } })).remainingQuantity).toBe(0);
    expect((await seed!.batch.findUniqueOrThrow({ where: { id: empty.batchId } })).status).toBe("ARCHIVED");
    expect((await seed!.railLot.findUniqueOrThrow({ where: { id: historical.lotId } })).remainingQuantity).toBe(3);
    expect((await seed!.batch.findUniqueOrThrow({ where: { id: historical.batchId } })).status).toBe("ARCHIVED");
    expect(await seed!.productionOperation.count({ where: { batchId: { in: [empty.batchId, historical.batchId] } } })).toBe(0);
  }, 60_000);

  it("does not return the rail twice when cancellation is repeated", async () => {
    const world = await seedBatch();
    const op = await cutOne(world);
    const requestId = newRequestId();
    const input = {
      operationId: op.id,
      requestId,
      reason: "повтор той же отмены",
      expectedStateFingerprint: fingerprintOf(op),
    };
    const first = await cancelProductionOperation(input);
    const second = await cancelProductionOperation(input);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    await expect(
      cancelProductionOperation({ ...input, requestId: newRequestId() }),
    ).rejects.toThrow(CANCEL_ALREADY);
    expect((await seed!.railLot.findUniqueOrThrow({ where: { id: world.lotId } })).remainingQuantity).toBe(1);
    expect(await seed!.productionOperationCancellation.count({ where: { operationId: op.id } })).toBe(1);
    expect((await seed!.batch.findUniqueOrThrow({ where: { id: world.batchId } })).status).toBe("IN_WORK");
  }, 60_000);

  it("rejects a stale cancellation without restoring stock or status", async () => {
    const world = await seedBatch();
    const op = await cutOne(world);
    await expect(
      cancelProductionOperation({
        operationId: op.id,
        requestId: newRequestId(),
        reason: "устаревшая карточка",
        expectedStateFingerprint: "wrong-fingerprint",
      }),
    ).rejects.toThrow(STALE_OPERATION_CANCEL);
    const lot = await seed!.railLot.findUniqueOrThrow({ where: { id: world.lotId } });
    const batch = await seed!.batch.findUniqueOrThrow({ where: { id: world.batchId } });
    expect(lot.remainingQuantity).toBe(0);
    expect(batch.status).toBe("ARCHIVED");
    expect(op.cancelledAt).toBeNull();
    expect((await seed!.productionOperation.findUniqueOrThrow({ where: { id: op.id } })).cancelledAt).toBeNull();
    expect(await seed!.productionOperationCancellation.count({ where: { operationId: op.id } })).toBe(0);
  }, 60_000);

  it("keeps stock and status consistent when cancel and a new cut race", async () => {
    const world = await seedBatch();
    const op = await cutOne(world);
    const settled = await Promise.allSettled([
      cancelProductionOperation({
        operationId: op.id,
        requestId: newRequestId(),
        reason: "гонка с новым резом",
        expectedStateFingerprint: fingerprintOf(op),
      }),
      submitTorcovka({
        employeeId: world.employeeId,
        batchId: world.batchId,
        railLotId: world.lotId,
        railsTaken: 1,
        picks: [{ lengthM: 2, sort: "SORT1", quantity: 1 }],
        clientRequestId: newRequestId(),
      }),
    ]);
    const lot = await seed!.railLot.findUniqueOrThrow({ where: { id: world.lotId } });
    const batch = await seed!.batch.findUniqueOrThrow({ where: { id: world.batchId } });
    const blanks = await seed!.blankStock.findMany({ where: { materialId: world.materialId } });
    expect(lot.remainingQuantity).toBeGreaterThanOrEqual(0);
    expect(lot.remainingQuantity).toBeLessThanOrEqual(lot.quantity);
    expect(blanks.every((row) => row.quantity >= 0)).toBe(true);
    if (lot.remainingQuantity > 0) {
      expect(batch.status).toBe("IN_WORK");
      expect(batch.closedAt).toBeNull();
    } else {
      expect(batch.status).toBe("ARCHIVED");
    }
    expect(settled.filter((item) => item.status === "rejected").length).toBeLessThan(2);
    expect((await seed!.productionOperation.findUniqueOrThrow({ where: { id: op.id } })).cancelledAt).not.toBeNull();
  }, 60_000);

  it("still blocks generic torcovka delete and does not restore the rail that way", async () => {
    const world = await seedBatch();
    const op = await cutOne(world);
    await expect(deleteProductionOperation(op.id)).rejects.toThrow(TORCOVKA_GENERIC_DELETE_BLOCKED);
    expect((await seed!.railLot.findUniqueOrThrow({ where: { id: world.lotId } })).remainingQuantity).toBe(0);
    expect((await seed!.batch.findUniqueOrThrow({ where: { id: world.batchId } })).status).toBe("ARCHIVED");
    expect((await seed!.productionOperation.findUniqueOrThrow({ where: { id: op.id } })).cancelledAt).toBeNull();
  }, 60_000);
});
