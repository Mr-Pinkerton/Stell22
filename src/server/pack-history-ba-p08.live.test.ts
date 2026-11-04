import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newRequestId } from "@/lib/request-id";
import { INVENTORY_BOUNDARY } from "@/server/internal/inventory-integrity";
import { PRODUCTION_COST_FLOW_KEY } from "@/server/internal/cost-flow-state";
import { runDisposableMigrate } from "@/server/internal/disposable-migrate/guard";
import {
  QUANTITY_EDIT_UPAKOVKA_COST_FLOW_NOT_READY,
  QUANTITY_EDIT_UPAKOVKA_HISTORY_AMBIGUOUS,
  computeQuantityEditStateFingerprint,
  type QuantityEditPhysicalAdjustment,
} from "@/server/internal/production-quantity-edit";

const gate = vi.hoisted(() => ({
  admin: { id: "pending-admin", name: "Проверка", email: "pack@example.invalid", role: "ADMIN" as const },
}));
const harness = vi.hoisted(() => ({
  url: "",
  client: null as PrismaClient | null,
}));

vi.mock("@/server/session", () => ({
  requireAdmin: async () => gate.admin,
  requireTerminalEmployee: async (expectedEmployeeId?: string) => ({
    id: expectedEmployeeId ?? "missing-employee",
    fullName: "Упаковщик",
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

import { editProductionOperationQuantity } from "@/server/production";
import { submitUpakovka } from "@/server/terminal";
import { conductInventory } from "@/server/warehouse";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PG17_BIN = process.env.P1_PG17_BIN ?? "C:\\Users\\bocma\\AppData\\Local\\Temp\\pg17\\pgsql\\bin";
const FORBIDDEN_PORTS = new Set(["5432", "5433", "5434"]);

function pause(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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

type Packed = {
  employeeId: string;
  productId: string;
  operationId: string;
  detailAId: string;
  detailBId: string;
  fastenerId: string;
  packagingId: string;
  extraId: string;
  blankA: number;
};

describe("BA-P08-001 historical pack quantity on disposable PostgreSQL 17", () => {
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
    container = `p1iso-pack-${runId}`;
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "p1iso-pack-"));
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
      data: { email: `pack-${runId}@example.invalid`, passwordHash: "not-a-login", name: "Проверка" },
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
    if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
  });

  async function blankQty(materialId: string, length: string): Promise<number> {
    const row = await seed!.blankStock.findUniqueOrThrow({
      where: {
        materialId_lengthM_detailType_sort: {
          materialId,
          lengthM: new Prisma.Decimal(length),
          detailType: "POLKA",
          sort: "SORT1",
        },
      },
    });
    return row.quantity;
  }

  async function nomQty(id: string): Promise<number> {
    return (await seed!.nomenclatureStock.findUniqueOrThrow({ where: { nomenclatureId: id } })).quantity;
  }

  async function editQty(operationId: string, newQuantity: number, requestId = newRequestId()) {
    const op = await seed!.productionOperation.findUniqueOrThrow({
      where: { id: operationId },
      include: { lines: { orderBy: { id: "asc" } }, nomenclatureLines: { orderBy: { id: "asc" } } },
    });
    return editProductionOperationQuantity({
      operationId,
      requestId,
      targetLineId: null,
      expectedOldQuantity: op.productQty ?? 0,
      newQuantity,
      expectedStateFingerprint: computeQuantityEditStateFingerprint({
        operationId: op.id,
        operationType: "UPAKOVKA",
        productId: op.productId,
        productQty: op.productQty,
        line: null,
        lines: op.lines,
        nomenclatureLines: op.nomenclatureLines,
      }),
    });
  }

  async function packProduct(label: string, quantity: number): Promise<Packed & { materialId: string }> {
    seq += 1;
    const material = await seed!.material.create({
      data: { name: `${label}-${runId}-${seq}`, sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    const employee = await seed!.employee.create({
      data: { fullName: `Упаковщик ${seq}`, pin: String(5000 + seq), rateUpakovka: new Prisma.Decimal(80) },
    });
    const detailA = await seed!.detail.create({
      data: {
        name: `A-${seq}`,
        materialId: material.id,
        detailNumber: 1,
        lengthM: new Prisma.Decimal("1.0000"),
        detailType: "POLKA",
        sort: "SORT1",
        prisadkaTorcevaya: false,
        prisadkaPloskost: false,
      },
    });
    const detailB = await seed!.detail.create({
      data: {
        name: `B-${seq}`,
        materialId: material.id,
        detailNumber: 2,
        lengthM: new Prisma.Decimal("2.0000"),
        detailType: "POLKA",
        sort: "SORT1",
        prisadkaTorcevaya: false,
        prisadkaPloskost: false,
      },
    });
    const fastener = await seed!.nomenclatureItem.create({
      data: { name: `крепёж-${seq}`, type: "FASTENER", unitPrice: new Prisma.Decimal(3) },
    });
    const packaging = await seed!.nomenclatureItem.create({
      data: { name: `тара-${seq}`, type: "PACKAGING", unitPrice: new Prisma.Decimal(2) },
    });
    const extra = await seed!.nomenclatureItem.create({
      data: { name: `доп-${seq}`, type: "OTHER", unitPrice: new Prisma.Decimal(1) },
    });
    const product = await seed!.product.create({
      data: {
        name: `изделие-${seq}`,
        materialId: material.id,
        skuOzon: `oz-${runId}-${seq}`,
        skuWb: `wb-${runId}-${seq}`,
        sort: "SORT1",
        packagingId: packaging.id,
        details: { create: [{ detailId: detailA.id, quantity: 2 }] },
        fasteners: { create: [{ nomenclatureId: fastener.id, quantity: 3 }] },
        extras: { create: [{ nomenclatureId: extra.id }] },
      },
    });
    await seed!.blankStock.create({
      data: {
        materialId: material.id,
        lengthM: new Prisma.Decimal("1.0000"),
        detailType: "POLKA",
        sort: "SORT1",
        quantity: 20,
      },
    });
    await seed!.blankStock.create({
      data: {
        materialId: material.id,
        lengthM: new Prisma.Decimal("2.0000"),
        detailType: "POLKA",
        sort: "SORT1",
        quantity: 20,
      },
    });
    await seed!.nomenclatureStock.createMany({
      data: [
        { nomenclatureId: fastener.id, quantity: 30 },
        { nomenclatureId: packaging.id, quantity: 10 },
        { nomenclatureId: extra.id, quantity: 10 },
      ],
    });
    await submitUpakovka({
      employeeId: employee.id,
      clientRequestId: newRequestId(),
      picks: [{ productId: product.id, quantity }],
    });
    const op = await seed!.productionOperation.findFirstOrThrow({
      where: { type: "UPAKOVKA", productId: product.id },
    });
    await seed!.productDetail.deleteMany({ where: { productId: product.id } });
    await seed!.productDetail.create({ data: { productId: product.id, detailId: detailB.id, quantity: 1 } });
    await seed!.product.update({ where: { id: product.id }, data: { packagingId: null } });
    await seed!.productFastener.deleteMany({ where: { productId: product.id } });
    await seed!.productExtra.deleteMany({ where: { productId: product.id } });
    return {
      employeeId: employee.id,
      productId: product.id,
      operationId: op.id,
      detailAId: detailA.id,
      detailBId: detailB.id,
      fastenerId: fastener.id,
      packagingId: packaging.id,
      extraId: extra.id,
      blankA: await blankQty(material.id, "1.0000"),
      materialId: material.id,
    };
  }

  it("increases an old pack on the stored composition after the BOM changes", async () => {
    const packed = await packProduct("up", 1);
    const before = await seed!.productionOperation.findUniqueOrThrow({ where: { id: packed.operationId } });
    const edited = await editQty(packed.operationId, 2);
    expect(edited.replayed).toBe(false);
    const after = await seed!.productionOperation.findUniqueOrThrow({
      where: { id: packed.operationId },
      include: { lines: true, nomenclatureLines: true },
    });
    expect(after.productQty).toBe(2);
    expect(after.id).toBe(before.id);
    expect(after.employeeId).toBe(before.employeeId);
    expect(after.clientRequestId).toBe(before.clientRequestId);
    expect(after.rateUpakovkaSnapshot?.toString() ?? null).toBe(before.rateUpakovkaSnapshot?.toString() ?? null);
    expect(after.lines.every((line) => line.detailId === packed.detailAId && line.sourceIsBlank)).toBe(true);
    expect(after.lines.reduce((sum, line) => sum + line.quantity, 0)).toBe(4);
    expect(after.nomenclatureLines.find((line) => line.nomenclatureId === packed.fastenerId)?.quantity).toBe(6);
    expect(after.nomenclatureLines.find((line) => line.nomenclatureId === packed.packagingId)?.quantity).toBe(2);
    expect(after.nomenclatureLines.find((line) => line.nomenclatureId === packed.extraId)?.quantity).toBe(2);
    expect(await blankQty(packed.materialId, "1.0000")).toBe(packed.blankA - 2);
    expect(await blankQty(packed.materialId, "2.0000")).toBe(20);
    expect(await nomQty(packed.fastenerId)).toBe(30 - 6);
    expect((await seed!.productStock.findUniqueOrThrow({ where: { productId: packed.productId } })).quantity).toBe(2);
    expect((await seed!.productStock.findUniqueOrThrow({ where: { productId: packed.productId } })).totalValue).toBeNull();
    const effect = await seed!.productionOperationQuantityEdit.findFirstOrThrow({
      where: { operationId: packed.operationId },
    });
    const snapshot = effect.effectSnapshot as { physicalAdjustments: Array<{ targetType: string; detailId?: string; nomenclatureId?: string; quantityDelta: number }> };
    expect(JSON.stringify(snapshot)).not.toContain(packed.detailBId);
    expect(snapshot.physicalAdjustments.some((row) => row.nomenclatureId === packed.fastenerId && row.quantityDelta === -3)).toBe(true);
    expect(await seed!.setting.findUnique({ where: { key: PRODUCTION_COST_FLOW_KEY } })).toBeNull();
  }, 30_000);

  async function seedProcessedHistory(label: string) {
    seq += 1;
    const material = await seed!.material.create({
      data: { name: `${label}-${runId}-${seq}`, sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    const employee = await seed!.employee.create({
      data: { fullName: `История ${seq}`, pin: String(5300 + seq), rateUpakovka: new Prisma.Decimal(80) },
    });
    const historical = await seed!.detail.create({
      data: {
        name: `источник-${seq}`,
        materialId: material.id,
        detailNumber: 6,
        lengthM: new Prisma.Decimal("0.7000"),
        detailType: "POLKA",
        sort: "SORT1",
        prisadkaTorcevaya: true,
        prisadkaPloskost: true,
      },
    });
    const replacement = await seed!.detail.create({
      data: {
        name: `карточка-${seq}`,
        materialId: material.id,
        detailNumber: 7,
        lengthM: new Prisma.Decimal("0.8000"),
        detailType: "POLKA",
        sort: "SORT1",
        prisadkaTorcevaya: true,
        prisadkaPloskost: true,
      },
    });
    const fastener = await seed!.nomenclatureItem.create({
      data: { name: `крест-${seq}`, type: "FASTENER", unitPrice: new Prisma.Decimal(3) },
    });
    const product = await seed!.product.create({
      data: {
        name: `история-${seq}`,
        materialId: material.id,
        skuOzon: `ozh-${runId}-${seq}`,
        skuWb: `wbh-${runId}-${seq}`,
        sort: "SORT1",
        details: { create: [{ detailId: replacement.id, quantity: 9 }] },
      },
    });
    await seed!.detailStock.createMany({
      data: [
        { detailId: historical.id, torcevayaDone: false, ploskostDone: false, quantity: 5 },
        { detailId: historical.id, torcevayaDone: true, ploskostDone: false, quantity: 5 },
        { detailId: historical.id, torcevayaDone: true, ploskostDone: true, quantity: 7 },
        { detailId: replacement.id, torcevayaDone: true, ploskostDone: true, quantity: 9 },
      ],
    });
    await seed!.nomenclatureStock.create({ data: { nomenclatureId: fastener.id, quantity: 10 } });
    await seed!.productStock.create({ data: { productId: product.id, quantity: 2 } });
    const op = await seed!.productionOperation.create({
      data: {
        type: "UPAKOVKA",
        employeeId: employee.id,
        workDate: new Date("2026-03-02T00:00:00.000Z"),
        clientRequestId: newRequestId(),
        productId: product.id,
        productQty: 2,
        rateSnapshotVersion: 1,
        lines: {
          create: [
            { detailId: historical.id, quantity: 1, sourceIsBlank: false, sourceTorcevayaDone: false, sourcePloskostDone: false },
            { detailId: historical.id, quantity: 1, sourceIsBlank: false, sourceTorcevayaDone: true, sourcePloskostDone: false },
          ],
        },
        nomenclatureLines: { create: [{ nomenclatureId: fastener.id, quantity: 1 }] },
      },
    });
    return {
      materialId: material.id,
      historicalId: historical.id,
      replacementId: replacement.id,
      fastenerId: fastener.id,
      productId: product.id,
      operationId: op.id,
    };
  }

  it("scales non-divisible stored lines onto their recorded source buckets", async () => {
    const packed = await seedProcessedHistory("flags");
    await editQty(packed.operationId, 4);
    const lines = await seed!.operationDetailLine.findMany({
      where: { operationId: packed.operationId },
      orderBy: [{ sourceTorcevayaDone: "asc" }, { sourcePloskostDone: "asc" }],
    });
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => [line.detailId, line.sourceIsBlank, line.sourceTorcevayaDone, line.sourcePloskostDone, line.quantity, line.blankMaterialId])).toEqual([
      [packed.historicalId, false, false, false, 2, null],
      [packed.historicalId, false, true, false, 2, null],
    ]);
    expect(await seed!.operationNomenclatureLine.count({ where: { operationId: packed.operationId } })).toBe(1);
    const bucket = (torcevayaDone: boolean, ploskostDone: boolean) => seed!.detailStock.findUniqueOrThrow({
      where: { detailId_torcevayaDone_ploskostDone: { detailId: packed.historicalId, torcevayaDone, ploskostDone } },
    });
    expect((await bucket(false, false)).quantity).toBe(4);
    expect((await bucket(true, false)).quantity).toBe(4);
    expect((await bucket(true, true)).quantity).toBe(7);
    expect((await seed!.detailStock.findUniqueOrThrow({
      where: { detailId_torcevayaDone_ploskostDone: { detailId: packed.replacementId, torcevayaDone: true, ploskostDone: true } },
    })).quantity).toBe(9);
    expect(await seed!.blankStock.count({ where: { materialId: packed.materialId } })).toBe(0);
    expect(await nomQty(packed.fastenerId)).toBe(9);
    expect((await seed!.productStock.findUniqueOrThrow({ where: { productId: packed.productId } })).quantity).toBe(4);
    const effect = await seed!.productionOperationQuantityEdit.findFirstOrThrow({ where: { operationId: packed.operationId } });
    const snapshot = effect.effectSnapshot as { physicalAdjustments: QuantityEditPhysicalAdjustment[] };
    expect(snapshot.physicalAdjustments).toEqual(expect.arrayContaining([
      { targetType: "DETAIL", detailId: packed.historicalId, torcevayaDone: false, ploskostDone: false, quantityDelta: -1 },
      { targetType: "DETAIL", detailId: packed.historicalId, torcevayaDone: true, ploskostDone: false, quantityDelta: -1 },
      { targetType: "NOMENCLATURE", nomenclatureId: packed.fastenerId, quantityDelta: -1 },
      { targetType: "PRODUCT", productId: packed.productId, quantityDelta: 2 },
    ]));
    expect(snapshot.physicalAdjustments).toHaveLength(4);
    expect(snapshot.physicalAdjustments.some((row) => row.targetType === "BLANK")).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain(packed.replacementId);
  }, 30_000);

  it("decreases an old pack on the stored composition", async () => {
    const packed = await packProduct("down", 2);
    await editQty(packed.operationId, 1);
    const after = await seed!.productionOperation.findUniqueOrThrow({
      where: { id: packed.operationId },
      include: { lines: true, nomenclatureLines: true },
    });
    expect(after.productQty).toBe(1);
    expect(after.lines.every((line) => line.detailId === packed.detailAId)).toBe(true);
    expect(after.lines.reduce((sum, line) => sum + line.quantity, 0)).toBe(2);
    expect(after.nomenclatureLines.find((line) => line.nomenclatureId === packed.fastenerId)?.quantity).toBe(3);
    expect(await blankQty(packed.materialId, "1.0000")).toBe(packed.blankA + 2);
    expect(await blankQty(packed.materialId, "2.0000")).toBe(20);
    expect((await seed!.productStock.findUniqueOrThrow({ where: { productId: packed.productId } })).quantity).toBe(1);
  }, 30_000);

  it("keeps both stored detail buckets when the current BOM is a different detail", async () => {
    seq += 1;
    const material = await seed!.material.create({
      data: { name: `buckets-${runId}-${seq}`, sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    const employee = await seed!.employee.create({
      data: { fullName: `Сборщик ${seq}`, pin: String(5100 + seq), rateUpakovka: new Prisma.Decimal(80) },
    });
    const historical = await seed!.detail.create({
      data: {
        name: `готовая-${seq}`,
        materialId: material.id,
        detailNumber: 3,
        lengthM: new Prisma.Decimal("0.7000"),
        detailType: "POLKA",
        sort: "SORT1",
        prisadkaTorcevaya: true,
        prisadkaPloskost: true,
      },
    });
    const replacement = await seed!.detail.create({
      data: {
        name: `новая-${seq}`,
        materialId: material.id,
        detailNumber: 4,
        lengthM: new Prisma.Decimal("0.8000"),
        detailType: "POLKA",
        sort: "SORT1",
        prisadkaTorcevaya: true,
        prisadkaPloskost: true,
      },
    });
    const product = await seed!.product.create({
      data: {
        name: `полка-${seq}`,
        materialId: material.id,
        skuOzon: `ozb-${runId}-${seq}`,
        skuWb: `wbb-${runId}-${seq}`,
        sort: "SORT1",
        details: { create: [{ detailId: replacement.id, quantity: 9 }] },
      },
    });
    await seed!.detailStock.create({
      data: { detailId: historical.id, torcevayaDone: true, ploskostDone: false, quantity: 5 },
    });
    await seed!.detailStock.create({
      data: { detailId: historical.id, torcevayaDone: true, ploskostDone: true, quantity: 5 },
    });
    await seed!.detailStock.create({
      data: { detailId: replacement.id, torcevayaDone: true, ploskostDone: true, quantity: 9 },
    });
    await seed!.productStock.create({ data: { productId: product.id, quantity: 2 } });
    const op = await seed!.productionOperation.create({
      data: {
        type: "UPAKOVKA",
        employeeId: employee.id,
        workDate: new Date("2026-03-02T00:00:00.000Z"),
        clientRequestId: newRequestId(),
        productId: product.id,
        productQty: 2,
        rateSnapshotVersion: 1,
        lines: {
          create: [
            { detailId: historical.id, quantity: 1, sourceIsBlank: false, sourceTorcevayaDone: true, sourcePloskostDone: false },
            { detailId: historical.id, quantity: 1, sourceIsBlank: false, sourceTorcevayaDone: true, sourcePloskostDone: true },
          ],
        },
      },
      include: { lines: true },
    });
    await editQty(op.id, 4);
    const lines = await seed!.operationDetailLine.findMany({ where: { operationId: op.id }, orderBy: { sourcePloskostDone: "asc" } });
    expect(lines.map((line) => [line.detailId, line.sourceTorcevayaDone, line.sourcePloskostDone, line.quantity])).toEqual([
      [historical.id, true, false, 2],
      [historical.id, true, true, 2],
    ]);
    expect((await seed!.detailStock.findUniqueOrThrow({
      where: { detailId_torcevayaDone_ploskostDone: { detailId: historical.id, torcevayaDone: true, ploskostDone: false } },
    })).quantity).toBe(4);
    expect((await seed!.detailStock.findUniqueOrThrow({
      where: { detailId_torcevayaDone_ploskostDone: { detailId: historical.id, torcevayaDone: true, ploskostDone: true } },
    })).quantity).toBe(4);
    expect((await seed!.detailStock.findUniqueOrThrow({
      where: { detailId_torcevayaDone_ploskostDone: { detailId: replacement.id, torcevayaDone: true, ploskostDone: true } },
    })).quantity).toBe(9);
    expect((await seed!.productStock.findUniqueOrThrow({ where: { productId: product.id } })).quantity).toBe(4);
  }, 30_000);

  it("refuses the edit after a conducted inventory of the historical component", async () => {
    const packed = await packProduct("inv", 1);
    const blank = await seed!.blankStock.findUniqueOrThrow({
      where: {
        materialId_lengthM_detailType_sort: {
          materialId: packed.materialId,
          lengthM: new Prisma.Decimal("1.0000"),
          detailType: "POLKA",
          sort: "SORT1",
        },
      },
    });
    const doc = await seed!.inventory.create({
      data: {
        date: new Date(),
        status: "DRAFT",
        lines: {
          create: [{
            refType: "BLANK",
            refId: blank.id,
            accountedQty: blank.quantity,
            actualQty: blank.quantity,
            deviation: 0,
            deviationSum: 0,
          }],
        },
      },
    });
    await conductInventory(doc.id);
    const opBefore = await seed!.productionOperation.findUniqueOrThrow({ where: { id: packed.operationId } });
    await seed!.inventory.update({
      where: { id: doc.id },
      data: { date: new Date(opBefore.createdAt.getTime() + 48 * 60 * 60 * 1000) },
    });
    const beforeBlank = await blankQty(packed.materialId, "1.0000");
    await expect(editQty(packed.operationId, 2)).rejects.toThrow(INVENTORY_BOUNDARY);
    expect(await blankQty(packed.materialId, "1.0000")).toBe(beforeBlank);
    expect((await seed!.productionOperation.findUniqueOrThrow({ where: { id: packed.operationId } })).productQty).toBe(1);
    expect((await seed!.productStock.findUniqueOrThrow({ where: { productId: packed.productId } })).quantity).toBe(1);
  }, 30_000);

  it("refuses an increase when the historical component is short and leaves no partial effect", async () => {
    const packed = await packProduct("short", 1);
    await seed!.blankStock.updateMany({
      where: { materialId: packed.materialId, lengthM: new Prisma.Decimal("1.0000") },
      data: { quantity: 0 },
    });
    await expect(editQty(packed.operationId, 2)).rejects.toThrow("Недостаточно заготовок для упаковки");
    expect(await blankQty(packed.materialId, "1.0000")).toBe(0);
    expect(await blankQty(packed.materialId, "2.0000")).toBe(20);
    expect(await nomQty(packed.fastenerId)).toBe(30 - 3);
    expect((await seed!.productionOperation.findUniqueOrThrow({ where: { id: packed.operationId } })).productQty).toBe(1);
    expect((await seed!.productStock.findUniqueOrThrow({ where: { productId: packed.productId } })).quantity).toBe(1);
  }, 30_000);

  it("keeps the stored composition after the current BOM is deleted", async () => {
    const packed = await packProduct("gone", 1);
    await seed!.productDetail.deleteMany({ where: { productId: packed.productId } });
    await editQty(packed.operationId, 2);
    const lines = await seed!.operationDetailLine.findMany({ where: { operationId: packed.operationId } });
    expect(lines.every((line) => line.detailId === packed.detailAId)).toBe(true);
    expect(await blankQty(packed.materialId, "2.0000")).toBe(20);
  }, 30_000);

  it("fails closed when stored lines do not divide into the requested quantity", async () => {
    seq += 1;
    const material = await seed!.material.create({
      data: { name: `odd-${runId}-${seq}`, sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    const employee = await seed!.employee.create({
      data: { fullName: `Нечёт ${seq}`, pin: String(5200 + seq) },
    });
    const detail = await seed!.detail.create({
      data: {
        name: `нечёт-${seq}`,
        materialId: material.id,
        detailNumber: 5,
        lengthM: new Prisma.Decimal("1.0000"),
        detailType: "POLKA",
        sort: "SORT1",
      },
    });
    const product = await seed!.product.create({
      data: {
        name: `нечёт-изделие-${seq}`,
        materialId: material.id,
        skuOzon: `ozo-${runId}-${seq}`,
        skuWb: `wbo-${runId}-${seq}`,
        sort: "SORT1",
      },
    });
    await seed!.blankStock.create({
      data: { materialId: material.id, lengthM: new Prisma.Decimal("1.0000"), detailType: "POLKA", sort: "SORT1", quantity: 8 },
    });
    await seed!.productStock.create({ data: { productId: product.id, quantity: 2 } });
    const op = await seed!.productionOperation.create({
      data: {
        type: "UPAKOVKA",
        employeeId: employee.id,
        workDate: new Date("2026-03-02T00:00:00.000Z"),
        clientRequestId: newRequestId(),
        productId: product.id,
        productQty: 2,
        rateSnapshotVersion: 1,
        lines: {
          create: [{
            detailId: detail.id,
            quantity: 1,
            sourceIsBlank: true,
            blankLengthM: new Prisma.Decimal("1.0000"),
            blankType: "POLKA",
            blankSort: "SORT1",
            blankMaterialId: material.id,
          }],
        },
      },
    });
    await expect(editQty(op.id, 3)).rejects.toThrow(QUANTITY_EDIT_UPAKOVKA_HISTORY_AMBIGUOUS);
    expect(await blankQty(material.id, "1.0000")).toBe(8);
    expect((await seed!.productionOperation.findUniqueOrThrow({ where: { id: op.id } })).productQty).toBe(2);
    expect(await seed!.operationDetailLine.count({ where: { operationId: op.id } })).toBe(1);
  }, 30_000);

  it("replays the same quantity edit without a second stock adjustment", async () => {
    const packed = await packProduct("replay", 1);
    const op = await seed!.productionOperation.findUniqueOrThrow({
      where: { id: packed.operationId },
      include: { lines: { orderBy: { id: "asc" } }, nomenclatureLines: { orderBy: { id: "asc" } } },
    });
    const requestId = newRequestId();
    const command = {
      operationId: packed.operationId,
      requestId,
      targetLineId: null,
      expectedOldQuantity: op.productQty ?? 0,
      newQuantity: 2,
      expectedStateFingerprint: computeQuantityEditStateFingerprint({
        operationId: op.id,
        operationType: "UPAKOVKA" as const,
        productId: op.productId,
        productQty: op.productQty,
        line: null,
        lines: op.lines,
        nomenclatureLines: op.nomenclatureLines,
      }),
    };
    await editProductionOperationQuantity(command);
    const again = await editProductionOperationQuantity(command);
    expect(again.replayed).toBe(true);
    expect(await blankQty(packed.materialId, "1.0000")).toBe(packed.blankA - 2);
    expect(await seed!.productionOperationQuantityEdit.count({ where: { operationId: packed.operationId } })).toBe(1);
    expect((await seed!.productStock.findUniqueOrThrow({ where: { productId: packed.productId } })).quantity).toBe(2);
  }, 30_000);

  it("serializes two quantity edits without a deadlock or a double adjustment", async () => {
    const packed = await packProduct("race", 1);
    const settled = await Promise.allSettled([editQty(packed.operationId, 2), editQty(packed.operationId, 2)]);
    expect(settled.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((item) => item.status === "rejected") as PromiseRejectedResult;
    expect(errorText(rejected.reason)).not.toContain("40P01");
    expect(await blankQty(packed.materialId, "1.0000")).toBe(packed.blankA - 2);
    expect(await blankQty(packed.materialId, "1.0000")).toBeGreaterThanOrEqual(0);
    expect((await seed!.productStock.findUniqueOrThrow({ where: { productId: packed.productId } })).quantity).toBe(2);
    expect((await seed!.productionOperation.findUniqueOrThrow({ where: { id: packed.operationId } })).productQty).toBe(2);
  }, 30_000);

  it("still refuses a quantity edit when the finished product was already shipped", async () => {
    const packed = await packProduct("ship", 1);
    await seed!.productStock.update({ where: { productId: packed.productId }, data: { quantity: 0 } });
    await expect(editQty(packed.operationId, 2)).rejects.toThrow("уже отгружено");
    expect(await blankQty(packed.materialId, "1.0000")).toBe(packed.blankA);
    expect((await seed!.productionOperation.findUniqueOrThrow({ where: { id: packed.operationId } })).productQty).toBe(1);
  }, 30_000);

  it("keeps the active cost-flow refusal", async () => {
    const packed = await packProduct("gate", 1);
    await seed!.setting.create({
      data: { key: PRODUCTION_COST_FLOW_KEY, value: { version: 1, active: true } },
    });
    try {
      await expect(editQty(packed.operationId, 2)).rejects.toThrow(QUANTITY_EDIT_UPAKOVKA_COST_FLOW_NOT_READY);
      expect(await blankQty(packed.materialId, "1.0000")).toBe(packed.blankA);
      expect((await seed!.productionOperation.findUniqueOrThrow({ where: { id: packed.operationId } })).productQty).toBe(1);
    } finally {
      await seed!.setting.delete({ where: { key: PRODUCTION_COST_FLOW_KEY } });
    }
  }, 30_000);

  it("serializes concurrent edits of the same processed-detail buckets", async () => {
    const packed = await seedProcessedHistory("race-flags");
    const settled = await Promise.allSettled([editQty(packed.operationId, 4), editQty(packed.operationId, 4)]);
    expect(settled.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((item) => item.status === "rejected") as PromiseRejectedResult;
    expect(errorText(rejected.reason)).not.toContain("40P01");
    expect((await seed!.detailStock.findUniqueOrThrow({
      where: { detailId_torcevayaDone_ploskostDone: { detailId: packed.historicalId, torcevayaDone: false, ploskostDone: false } },
    })).quantity).toBe(4);
    expect((await seed!.productStock.findUniqueOrThrow({ where: { productId: packed.productId } })).quantity).toBe(4);
    expect((await seed!.productionOperation.findUniqueOrThrow({ where: { id: packed.operationId } })).productQty).toBe(4);
    expect(await seed!.operationDetailLine.count({ where: { operationId: packed.operationId } })).toBe(2);
  }, 30_000);

  it("keeps the active cost-flow refusal for a processed-detail history", async () => {
    const packed = await seedProcessedHistory("gate-flags");
    await seed!.setting.create({
      data: { key: PRODUCTION_COST_FLOW_KEY, value: { version: 1, active: true } },
    });
    try {
      await expect(editQty(packed.operationId, 4)).rejects.toThrow(QUANTITY_EDIT_UPAKOVKA_COST_FLOW_NOT_READY);
      expect((await seed!.detailStock.findUniqueOrThrow({
        where: { detailId_torcevayaDone_ploskostDone: { detailId: packed.historicalId, torcevayaDone: false, ploskostDone: false } },
      })).quantity).toBe(5);
      expect((await seed!.productionOperation.findUniqueOrThrow({ where: { id: packed.operationId } })).productQty).toBe(2);
    } finally {
      await seed!.setting.delete({ where: { key: PRODUCTION_COST_FLOW_KEY } });
    }
  }, 30_000);

  it("refuses a processed-detail edit after a conducted inventory of that detail", async () => {
    const packed = await seedProcessedHistory("inv-flags");
    const doc = await seed!.inventory.create({
      data: {
        date: new Date(),
        status: "DRAFT",
        lines: {
          create: [{
            refType: "DETAIL",
            refId: packed.historicalId,
            accountedQty: 7,
            actualQty: 7,
            deviation: 0,
            deviationSum: 0,
          }],
        },
      },
    });
    await conductInventory(doc.id);
    const opBefore = await seed!.productionOperation.findUniqueOrThrow({ where: { id: packed.operationId } });
    await seed!.inventory.update({
      where: { id: doc.id },
      data: { date: new Date(opBefore.createdAt.getTime() + 48 * 60 * 60 * 1000) },
    });
    await expect(editQty(packed.operationId, 4)).rejects.toThrow(INVENTORY_BOUNDARY);
    expect((await seed!.detailStock.findUniqueOrThrow({
      where: { detailId_torcevayaDone_ploskostDone: { detailId: packed.historicalId, torcevayaDone: false, ploskostDone: false } },
    })).quantity).toBe(5);
    expect((await seed!.productionOperation.findUniqueOrThrow({ where: { id: packed.operationId } })).productQty).toBe(2);
  }, 30_000);
});
