import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runDisposableMigrate } from "@/server/internal/disposable-migrate/guard";
import { PRODUCTION_COST_FLOW_KEY } from "@/server/internal/cost-flow-state";

const gate = vi.hoisted(() => ({
  admin: { id: "pending-admin", name: "Проверка", email: "bank@example.invalid", role: "ADMIN" as const },
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

import {
  assignCashFlow,
  convertCashFlowToTransfer,
  createCashFlow,
  createDeal,
  createStatement,
  deleteAccount,
  deleteCashFlow,
  deleteDeal,
  deleteStatement,
  getFinanceData,
  importStatement,
  reapplyAutoRules,
  unlinkTransfer,
  updateManualCashFlow,
} from "@/server/finance";
import { importStatementInternal } from "@/server/internal/statement-import";
import { extractStatements } from "@/server/statement-mail";

const LIVE = process.env.P1_DISPOSABLE_LIVE === "1";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FORBIDDEN_PORTS = new Set(["5432", "5433", "5434"]);

function encodeWindows1251(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 128) bytes[i] = code;
    else if (code >= 0x0410 && code <= 0x044f) bytes[i] = code - 0x0410 + 0xc0;
    else if (code === 0x0401) bytes[i] = 0xa8;
    else if (code === 0x0451) bytes[i] = 0xb8;
    else throw new Error(`cannot encode U+${code.toString(16)} as windows-1251`);
  }
  return bytes;
}

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
    { encoding: "utf8", timeout: 60_000 },
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
    let lastError = "";
    for (let attempt = 0; attempt < 90 && ready === ""; attempt += 1) {
      const probe = spawnSync(
        "docker",
        ["exec", "-e", `PGPASSWORD=${input.password}`, input.container, "psql", "-X", "-U", "p1iso", "-d", input.database, "-q", "-At", "-c", "SELECT version()"],
        { encoding: "utf8", timeout: 15_000 },
      );
      if (probe.status === 0 && probe.stdout.includes("PostgreSQL 17")) ready = probe.stdout.trim();
      else {
        lastError = `${probe.stderr ?? ""} ${probe.stdout ?? ""}`.trim();
        pause(1000);
      }
    }
    if (!ready.includes("PostgreSQL 17")) {
      throw new Error(`disposable PostgreSQL 17 did not become ready: ${lastError}`);
    }
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

function bankFile(input: {
  account: string;
  start: string;
  end: string;
  opening: string;
  closing: string;
  docs: Array<{
    number: string;
    date: string;
    amount: string;
    payer: string;
    payee: string;
    purpose?: string;
    payerName?: string;
    payerInn?: string;
    payeeName?: string;
    payeeInn?: string;
  }>;
}): string {
  const docs = input.docs
    .map(
      (doc) => `СекцияДокумент=Платежное поручение
Номер=${doc.number}
Дата=${doc.date}
Сумма=${doc.amount}
ПлательщикСчет=${doc.payer}
Плательщик=${doc.payerName ?? "Плательщик"}
ПлательщикИНН=${doc.payerInn ?? "7700000001"}
ПолучательСчет=${doc.payee}
Получатель=${doc.payeeName ?? "Получатель"}
ПолучательИНН=${doc.payeeInn ?? "7800000002"}
НазначениеПлатежа=${doc.purpose ?? "Оплата"}
КонецДокумента`,
    )
    .join("\n");
  return `1CClientBankExchange
ВерсияФормата=1.03
Кодировка=Windows
СекцияРасчСчет
ДатаНачала=${input.start}
ДатаКонца=${input.end}
РасчСчет=${input.account}
БИК=044525104
НачальныйОстаток=${input.opening}
КонечныйОстаток=${input.closing}
КонецРасчСчет
${docs}
КонецФайла`;
}

describe.skipIf(!LIVE)("bank statement immutability and coverage on disposable PostgreSQL 17", () => {
  let runId = "";
  let database = "";
  let dbPassword = "";
  let container = "";
  let cwd = "";
  let localDataDir = "";
  let startedDocker = false;
  let seed: PrismaClient | null = null;

  beforeAll(async () => {
    runId = randomBytes(4).toString("hex");
    database = `p1iso_${runId}`;
    dbPassword = randomBytes(16).toString("hex");
    container = `p1iso-bank-${runId}`;
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "p1iso-bank-"));
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
  }, 300_000);

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

  async function account(name: string, number: string) {
    return seed!.account.create({
      data: { name, accountNumber: number, confirmed: true, openingBalance: 0, balance: 0 },
    });
  }

  it("A–F imported rows stay immutable, convert without rewriting the bank leg, and block group deletion", async () => {
    const number = `407028100000${runId.slice(0, 8)}1`;
    const other = await account(`Касса ${runId}`, `408178100000${runId.slice(0, 8)}1`);
    const file = bankFile({
      account: number,
      start: "01.09.2026",
      end: "01.09.2026",
      opening: "0.00",
      closing: "250.00",
      docs: [
        { number: "11", date: "01.09.2026", amount: "150.00", payer: number, payee: "40602810000000000001", purpose: "банк-расход" },
        { number: "12", date: "01.09.2026", amount: "100.00", payer: "40602810000000000002", payee: number, purpose: "банк-приход" },
      ],
    });
    const imported = await importStatementInternal(file, "a.txt");
    expect(imported.importedCount).toBe(2);
    const rows = await seed!.cashFlow.findMany({ where: { statementId: imported.statement.id }, orderBy: { amount: "asc" } });
    const income = rows.find((row) => row.flowType === "INCOME");
    const expense = rows.find((row) => row.flowType === "EXPENSE");
    expect(income && expense).toBeTruthy();
    const article = await seed!.articleCategory.create({ data: { name: `Кат ${runId}`, isOverhead: false } });
    const expenseArticle = await seed!.article.create({
      data: { name: `Статья ${runId}`, flowType: "EXPENSE", categoryId: article.id },
    });
    await expect(assignCashFlow(expense!.id, { articleId: expenseArticle.id })).rejects.toThrow(/нельзя изменить/);
    await expect(updateManualCashFlow(expense!.id, {
      date: "2026-09-02",
      amount: 1,
      flowType: "INCOME",
      accountName: other.name,
      counterpartyName: null,
      description: "подмена",
      articleName: null,
      dealId: null,
      dealName: null,
    })).rejects.toThrow(/нельзя изменить/);
    await expect(updateManualCashFlow(income!.id, {
      date: "2026-09-02",
      amount: 1,
      flowType: "EXPENSE",
      accountName: other.name,
      counterpartyName: null,
      description: "подмена",
      articleName: null,
      dealId: null,
      dealName: null,
    })).rejects.toThrow(/нельзя изменить/);
    await expect(deleteCashFlow(expense!.id)).rejects.toThrow(/нельзя удалить/);
    await expect(deleteStatement(imported.statement.id)).rejects.toThrow(/нельзя удалить/);
    expect(await seed!.cashFlow.count({ where: { statementId: imported.statement.id } })).toBe(2);
    expect(await seed!.statement.count({ where: { id: imported.statement.id } })).toBe(1);

    await seed!.autoRule.create({
      data: {
        flowType: "EXPENSE",
        articleId: expenseArticle.id,
        logicOperator: "AND",
        descriptionKeywords: "банк-расход",
      },
    });
    await reapplyAutoRules();
    const still = await seed!.cashFlow.findUniqueOrThrow({ where: { id: expense!.id } });
    expect(still.articleId).toBeNull();

    const [sourceRow, otherRow] = await convertCashFlowToTransfer(expense!.id, other.id);
    const saved = await seed!.cashFlow.findUniqueOrThrow({ where: { id: expense!.id } });
    expect(saved.amount.toFixed(2)).toBe("150.00");
    expect(saved.date.toISOString().slice(0, 10)).toBe("2026-09-01");
    expect(saved.accountId).toBe(expense!.accountId);
    expect(saved.flowType).toBe("EXPENSE");
    expect(saved.description).toBe("банк-расход");
    expect(saved.statementId).toBe(expense!.statementId);
    expect(saved.importKey).toBe(expense!.importKey);
    expect(saved.isTransfer).toBe(true);
    expect(saved.transferId).toBeTruthy();
    expect(sourceRow.source).toBe("BANK");
    expect(otherRow.source).toBe("BANK");
    await expect(deleteCashFlow(saved.id)).rejects.toThrow(/нельзя удалить/);
    await expect(deleteCashFlow(otherRow.id)).rejects.toThrow(/нельзя удалить/);
    await expect(unlinkTransfer(saved.id)).rejects.toThrow(/нельзя расцепить/);
    expect(await seed!.cashFlow.count({ where: { transferId: saved.transferId } })).toBe(2);
  });

  it("G manual amount, date, and account can change, and the row can be deleted", async () => {
    const from = await account(`Ручной ${runId}`, `407028100000${runId.slice(0, 8)}2`);
    const to = await account(`Ручной 2 ${runId}`, `407028100000${runId.slice(0, 8)}3`);
    const created = await createCashFlow({
      date: "2026-09-01",
      amount: 40,
      flowType: "EXPENSE",
      accountName: from.name,
      counterpartyName: null,
      description: "ручная операция",
      articleName: null,
      dealId: null,
      dealName: null,
    });
    const updated = await updateManualCashFlow(created.id, {
      date: "2026-09-04",
      amount: 55,
      flowType: "INCOME",
      accountName: to.name,
      counterpartyName: null,
      description: "ручная операция",
      articleName: null,
      dealId: null,
      dealName: null,
    });
    expect(updated.amount).toBe(55);
    expect(updated.date).toBe("2026-09-04");
    expect(updated.accountId).toBe(to.id);
    expect(updated.flowType).toBe("INCOME");
    expect(updated.source).toBe("MANUAL");
    const stored = await seed!.cashFlow.findUniqueOrThrow({ where: { id: created.id } });
    expect(stored.statementId).toBeNull();
    expect(stored.importKey).toBeNull();
    await deleteCashFlow(created.id);
    expect(await seed!.cashFlow.count({ where: { id: created.id } })).toBe(0);
  });

  it("H–I identical import is idempotent and an overlapping different file fails closed", async () => {
    const number = `407028100000${runId.slice(0, 8)}4`;
    const file = bankFile({
      account: number,
      start: "05.09.2026",
      end: "05.09.2026",
      opening: "0.00",
      closing: "10.00",
      docs: [{ number: "21", date: "05.09.2026", amount: "10.00", payer: number, payee: "40602810000000000021" }],
    });
    const first = await importStatement(file, "same.txt");
    const anchor = await seed!.account.findFirstOrThrow({ where: { accountNumber: number } });
    const second = await importStatementInternal(file, "same-again.txt");
    expect(second.importedCount).toBe(0);
    expect(second.statement.id).toBe(first.statement.id);
    expect(await seed!.statement.count({ where: { accountId: anchor.id } })).toBe(1);
    expect(await seed!.cashFlow.count({ where: { accountId: anchor.id } })).toBe(1);
    const after = await seed!.account.findUniqueOrThrow({ where: { id: anchor.id } });
    expect(after.balanceAsOf?.toISOString()).toBe(anchor.balanceAsOf?.toISOString());
    expect(after.openingBalance.toFixed(2)).toBe(anchor.openingBalance.toFixed(2));

    const overlap = bankFile({
      account: number,
      start: "05.09.2026",
      end: "06.09.2026",
      opening: "0.00",
      closing: "30.00",
      docs: [{ number: "22", date: "06.09.2026", amount: "20.00", payer: number, payee: "40602810000000000022" }],
    });
    await expect(importStatementInternal(overlap, "overlap.txt")).rejects.toThrow(/пересекаются/);
    expect(await seed!.statement.count({ where: { accountId: anchor.id } })).toBe(1);
    expect(await seed!.cashFlow.count({ where: { accountId: anchor.id } })).toBe(1);
  });

  it("J–M coverage reports a gap, a silent covered day, separate accounts, and unknown history", async () => {
    const left = `407028100000${runId.slice(0, 8)}5`;
    const right = `407028100000${runId.slice(0, 8)}6`;
    await importStatementInternal(bankFile({
      account: left,
      start: "01.09.2026",
      end: "01.09.2026",
      opening: "0.00",
      closing: "1.00",
      docs: [{ number: "31", date: "01.09.2026", amount: "1.00", payer: left, payee: "40602810000000000031" }],
    }), "gap-a.txt");
    await importStatementInternal(bankFile({
      account: left,
      start: "03.09.2026",
      end: "03.09.2026",
      opening: "1.00",
      closing: "2.00",
      docs: [{ number: "32", date: "03.09.2026", amount: "1.00", payer: left, payee: "40602810000000000032" }],
    }), "gap-b.txt");
    await importStatementInternal(bankFile({
      account: right,
      start: "01.09.2026",
      end: "03.09.2026",
      opening: "0.00",
      closing: "1.00",
      docs: [{ number: "41", date: "01.09.2026", amount: "1.00", payer: right, payee: "40602810000000000041" }],
    }), "span.txt");
    const historical = await account(`Архив ${runId}`, `407028100000${runId.slice(0, 8)}7`);
    await seed!.statement.create({
      data: { date: new Date("2020-01-15T00:00:00.000Z"), accountId: historical.id, uploadedAt: new Date() },
    });
    const data = await getFinanceData();
    const leftAccount = data.accounts.find((row) => row.accountNumber === left);
    const rightAccount = data.accounts.find((row) => row.accountNumber === right);
    const leftCoverage = data.statementCoverage.find((row) => row.accountId === leftAccount?.id);
    const rightCoverage = data.statementCoverage.find((row) => row.accountId === rightAccount?.id);
    const oldCoverage = data.statementCoverage.find((row) => row.accountId === historical.id);
    expect(leftCoverage?.missingDates).toContain("2026-09-02");
    expect(rightCoverage?.missingDates).not.toContain("2026-09-02");
    expect(rightCoverage?.coveredRanges).toEqual([{ start: "2026-09-01", end: "2026-09-03" }]);
    expect(leftCoverage?.overlappingDates).toEqual([]);
    expect(rightCoverage?.overlappingDates).toEqual([]);
    expect(oldCoverage?.status).toBe("UNKNOWN");
    expect(oldCoverage?.missingDates).toEqual([]);
    expect(oldCoverage?.coveredRanges).toEqual([]);
    const placeholder = data.statements.find((row) => row.accountName === historical.name);
    expect(placeholder?.periodStatus).toBe("UNKNOWN");
  });

  it("N concurrent identical imports create one statement", async () => {
    const number = `407028100000${runId.slice(0, 8)}8`;
    await account(`Гонка ${runId}`, number);
    const file = bankFile({
      account: number,
      start: "10.09.2026",
      end: "10.09.2026",
      opening: "0.00",
      closing: "5.00",
      docs: [{ number: "51", date: "10.09.2026", amount: "5.00", payer: number, payee: "40602810000000000051" }],
    });
    await Promise.all([
      importStatementInternal(file, "race-a.txt"),
      importStatementInternal(file, "race-b.txt"),
    ]);
    const owner = await seed!.account.findFirstOrThrow({ where: { accountNumber: number } });
    expect(await seed!.statement.count({ where: { accountId: owner.id, source: "BANK_1C" } })).toBe(1);
    expect(await seed!.cashFlow.count({ where: { accountId: owner.id } })).toBe(1);
  });

  it("O balances, deal totals, and frozen batch cost stay consistent", async () => {
    const material = await seed!.material.create({
      data: { name: `Порода ${runId}`, sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    const openName = `Открытая ${runId}`;
    const frozenName = `Замороженная ${runId}`;
    await seed!.batch.create({
      data: {
        name: openName,
        materialId: material.id,
        sectionWidthMm: 40,
        sectionHeightMm: 20,
        purchaseCost: 1000,
        totalCost: 1000,
        priceSort1: 0,
        priceSort2: 0,
        purchaseDate: new Date("2026-09-01T00:00:00.000Z"),
      },
    });
    const frozen = await seed!.batch.create({
      data: {
        name: frozenName,
        materialId: material.id,
        sectionWidthMm: 40,
        sectionHeightMm: 20,
        purchaseCost: 1000,
        totalCost: 1000,
        priceSort1: 0,
        priceSort2: 0,
        purchaseDate: new Date("2026-09-01T00:00:00.000Z"),
        frozenAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    });
    const bank = await account(`Сделка банк ${runId}`, `407028100000${runId.slice(0, 8)}9`);
    const cash = await account(`Сделка касса ${runId}`, `408178100000${runId.slice(0, 8)}9`);
    await createDeal({ name: `Сделка ${runId}`, batchNames: [openName, frozenName] });
    await createCashFlow({
      date: "2026-09-08",
      amount: 3000,
      flowType: "EXPENSE",
      accountName: cash.name,
      counterpartyName: null,
      description: "доплата сделки",
      articleName: null,
      dealId: (await seed!.deal.findFirstOrThrow({ where: { name: `Сделка ${runId}` } })).id,
      dealName: `Сделка ${runId}`,
    });
    const openBatch = await seed!.batch.findFirstOrThrow({ where: { name: openName } });
    const frozenBatch = await seed!.batch.findUniqueOrThrow({ where: { id: frozen.id } });
    const deal = await seed!.deal.findFirstOrThrow({ where: { name: `Сделка ${runId}` } });
    expect(openBatch.totalCost.toFixed(2)).toBe("1500.00");
    expect(frozenBatch.totalCost.toFixed(2)).toBe("1000.00");
    expect(deal.total.toFixed(2)).toBe("3000.00");
    const file = bankFile({
      account: bank.accountNumber!,
      start: "08.09.2026",
      end: "08.09.2026",
      opening: "0.00",
      closing: "0.00",
      docs: [{ number: "61", date: "08.09.2026", amount: "70.00", payer: bank.accountNumber!, payee: "40602810000000000061" }],
    });
    await importStatementInternal(file, "deal.txt");
    const bankRow = await seed!.cashFlow.findFirstOrThrow({ where: { accountId: bank.id, importKey: { not: null } } });
    await convertCashFlowToTransfer(bankRow.id, cash.id);
    const afterDeal = await seed!.deal.findUniqueOrThrow({ where: { id: deal.id } });
    const afterOpen = await seed!.batch.findUniqueOrThrow({ where: { id: openBatch.id } });
    const afterFrozen = await seed!.batch.findUniqueOrThrow({ where: { id: frozen.id } });
    expect(afterDeal.total.toFixed(2)).toBe("3000.00");
    expect(afterOpen.totalCost.toFixed(2)).toBe("1500.00");
    expect(afterFrozen.totalCost.toFixed(2)).toBe("1000.00");
    const bankSaved = await seed!.cashFlow.findUniqueOrThrow({ where: { id: bankRow.id } });
    expect(bankSaved.amount.toFixed(2)).toBe("70.00");
    expect(bankSaved.isTransfer).toBe(true);
    expect(await seed!.setting.count({ where: { key: PRODUCTION_COST_FLOW_KEY } })).toBe(0);
  });

  it("P file and mail importers use the same duplicate and overlap refusal", async () => {
    const number = `407028100000${runId.slice(0, 8)}0`;
    const file = bankFile({
      account: number,
      start: "12.09.2026",
      end: "12.09.2026",
      opening: "0.00",
      closing: "8.00",
      docs: [{ number: "71", date: "12.09.2026", amount: "8.00", payer: number, payee: "40602810000000000071" }],
    });
    const ui = await importStatement(file, "ui.txt");
    const mail = await importStatementInternal(file, "mail.txt");
    expect(mail.statement.id).toBe(ui.statement.id);
    expect(mail.importedCount).toBe(0);
    const zipped = extractStatements("mail.zip", zipSync({ "mail.txt": encodeWindows1251(file) }));
    expect(zipped.statements).toHaveLength(1);
    const fromZip = await importStatementInternal(zipped.statements[0]!.content, zipped.statements[0]!.fileName);
    expect(fromZip.importedCount).toBe(0);
    expect(fromZip.statement.id).toBe(ui.statement.id);
    const owner = await seed!.account.findFirstOrThrow({ where: { accountNumber: number } });
    expect(await seed!.cashFlow.count({ where: { accountId: owner.id } })).toBe(1);
    const clash = bankFile({
      account: number,
      start: "12.09.2026",
      end: "12.09.2026",
      opening: "0.00",
      closing: "9.00",
      docs: [{ number: "72", date: "12.09.2026", amount: "9.00", payer: number, payee: "40602810000000000072" }],
    });
    await expect(importStatement(clash, "ui-clash.txt")).rejects.toThrow(/пересекаются/);
    await expect(importStatementInternal(clash, "mail-clash.txt")).rejects.toThrow(/пересекаются/);
    expect(await seed!.statement.count({ where: { accountId: owner.id } })).toBe(1);
  });

  it("links the opposite bank document and refuses an amount-only pair", async () => {
    const left = `407028100000${runId.slice(0, 8)}a`;
    const right = `407028100000${runId.slice(0, 8)}b`;
    const leftFile = bankFile({
      account: left,
      start: "15.09.2026",
      end: "15.09.2026",
      opening: "0.00",
      closing: "0.00",
      docs: [{ number: "77", date: "15.09.2026", amount: "100.00", payer: left, payee: right }],
    });
    const rightFile = bankFile({
      account: right,
      start: "15.09.2026",
      end: "15.09.2026",
      opening: "0.00",
      closing: "100.00",
      docs: [{ number: "77", date: "15.09.2026", amount: "100.00", payer: left, payee: right }],
    });
    await importStatementInternal(leftFile, "pair-left.txt");
    await importStatementInternal(rightFile, "pair-right.txt");
    const leftAccount = await seed!.account.findFirstOrThrow({ where: { accountNumber: left } });
    const rightAccount = await seed!.account.findFirstOrThrow({ where: { accountNumber: right } });
    const source = await seed!.cashFlow.findFirstOrThrow({ where: { accountId: leftAccount.id } });
    await convertCashFlowToTransfer(source.id, rightAccount.id);
    const legs = await seed!.cashFlow.findMany({
      where: { accountId: { in: [leftAccount.id, rightAccount.id] } },
    });
    expect(legs).toHaveLength(2);
    expect(new Set(legs.map((leg) => leg.transferId)).size).toBe(1);
    expect(legs.every((leg) => leg.isTransfer)).toBe(true);
    expect(legs.find((leg) => leg.accountId === leftAccount.id)?.amount.toFixed(2)).toBe("100.00");
    expect(legs.find((leg) => leg.accountId === rightAccount.id)?.statementId).toBeTruthy();

    const ambiguousLeft = `407028100000${runId.slice(0, 8)}c`;
    const ambiguousRight = `407028100000${runId.slice(0, 8)}d`;
    await importStatementInternal(bankFile({
      account: ambiguousLeft,
      start: "16.09.2026",
      end: "16.09.2026",
      opening: "0.00",
      closing: "0.00",
      docs: [{ number: "81", date: "16.09.2026", amount: "40.00", payer: ambiguousLeft, payee: "40602810000000000081" }],
    }), "amb-left.txt");
    await importStatementInternal(bankFile({
      account: ambiguousRight,
      start: "16.09.2026",
      end: "16.09.2026",
      opening: "0.00",
      closing: "80.00",
      docs: [
        { number: "82", date: "16.09.2026", amount: "40.00", payer: "40602810000000000082", payee: ambiguousRight },
        { number: "83", date: "16.09.2026", amount: "40.00", payer: "40602810000000000083", payee: ambiguousRight },
      ],
    }), "amb-right.txt");
    const ambSourceAccount = await seed!.account.findFirstOrThrow({ where: { accountNumber: ambiguousLeft } });
    const ambDest = await seed!.account.findFirstOrThrow({ where: { accountNumber: ambiguousRight } });
    const ambSource = await seed!.cashFlow.findFirstOrThrow({ where: { accountId: ambSourceAccount.id } });
    await expect(convertCashFlowToTransfer(ambSource.id, ambDest.id)).rejects.toThrow(/только по сумме/);
    expect(await seed!.cashFlow.count({ where: { accountId: ambDest.id } })).toBe(2);
    expect(ambSource.isTransfer).toBe(false);
  });

  it("B–D a changed purpose or counterparty is an overlap, on every import path", async () => {
    const number = `407028100000${runId.slice(0, 8)}m`;
    const base = {
      account: number,
      start: "20.09.2026",
      end: "20.09.2026",
      opening: "0.00",
      closing: "15.00",
      docs: [{
        number: "91",
        date: "20.09.2026",
        amount: "15.00",
        payer: number,
        payee: "40602810000000000091",
        purpose: "Оплата поставки",
        payerName: "Ромашка",
        payerInn: "7700000091",
      }],
    };
    const file = bankFile(base);
    const ui = await importStatement(file, "purpose-ui.txt");
    const owner = await seed!.account.findFirstOrThrow({ where: { accountNumber: number } });
    const before = {
      statements: await seed!.statement.count({ where: { accountId: owner.id } }),
      flows: await seed!.cashFlow.count({ where: { accountId: owner.id } }),
      opening: owner.openingBalance.toFixed(2),
      asOf: owner.balanceAsOf?.toISOString() ?? null,
    };
    const again = await importStatementInternal(file, "purpose-mail.txt");
    expect(again.importedCount).toBe(0);
    expect(again.statement.id).toBe(ui.statement.id);
    const zipped = extractStatements("purpose.zip", zipSync({ "purpose.txt": encodeWindows1251(file) }));
    const fromZip = await importStatementInternal(zipped.statements[0]!.content, "renamed.txt");
    expect(fromZip.importedCount).toBe(0);
    expect(fromZip.statement.id).toBe(ui.statement.id);

    const changedPurpose = bankFile({
      ...base,
      docs: [{ ...base.docs[0]!, purpose: "Возврат поставки" }],
    });
    await expect(importStatement(changedPurpose, "purpose-ui-changed.txt")).rejects.toThrow(/пересекаются/);
    await expect(importStatementInternal(changedPurpose, "purpose-mail-changed.txt")).rejects.toThrow(/пересекаются/);
    const changedPayerName = bankFile({
      ...base,
      docs: [{ ...base.docs[0]!, payerName: "Лютик" }],
    });
    const changedPayerInn = bankFile({
      ...base,
      docs: [{ ...base.docs[0]!, payerInn: "7700000092" }],
    });
    const changedPayeeName = bankFile({
      ...base,
      docs: [{ ...base.docs[0]!, payeeName: "Лютик" }],
    });
    const changedPayeeInn = bankFile({
      ...base,
      docs: [{ ...base.docs[0]!, payeeInn: "7700000092" }],
    });
    await expect(importStatementInternal(changedPayerName, "payer-name.txt")).rejects.toThrow(/пересекаются/);
    await expect(importStatementInternal(changedPayerInn, "payer-inn.txt")).rejects.toThrow(/пересекаются/);
    await expect(importStatement(changedPayeeName, "payee-name.txt")).rejects.toThrow(/пересекаются/);
    await expect(importStatementInternal(changedPayeeInn, "payee-inn.txt")).rejects.toThrow(/пересекаются/);
    const changedParty = bankFile({
      ...base,
      docs: [{ ...base.docs[0]!, payerName: "Лютик", payerInn: "7700000092" }],
    });
    await expect(importStatementInternal(changedParty, "party-mail.txt")).rejects.toThrow(/пересекаются/);
    const zippedParty = extractStatements("party.zip", zipSync({ "party.txt": encodeWindows1251(changedParty) }));
    await expect(
      importStatementInternal(zippedParty.statements[0]!.content, zippedParty.statements[0]!.fileName),
    ).rejects.toThrow(/пересекаются/);

    const after = await seed!.account.findUniqueOrThrow({ where: { id: owner.id } });
    expect(await seed!.statement.count({ where: { accountId: owner.id } })).toBe(before.statements);
    expect(await seed!.cashFlow.count({ where: { accountId: owner.id } })).toBe(before.flows);
    expect(after.openingBalance.toFixed(2)).toBe(before.opening);
    expect(after.balanceAsOf?.toISOString() ?? null).toBe(before.asOf);
    const saved = await seed!.cashFlow.findMany({
      where: { accountId: owner.id },
      include: { counterparty: true },
    });
    expect(saved.map((row) => row.description)).toEqual(["Оплата поставки"]);
    expect(saved[0]!.counterparty?.name).toBe("Получатель");
    expect(saved[0]!.counterparty?.inn).toBe("7800000002");
    expect(saved[0]!.amount.toFixed(2)).toBe("15.00");
  });

  it("E–G account deletion keeps every statement and still removes an empty account", async () => {
    const number = `407028100000${runId.slice(0, 8)}e`;
    const silent = bankFile({
      account: number,
      start: "21.09.2026",
      end: "21.09.2026",
      opening: "0.00",
      closing: "0.00",
      docs: [],
    });
    await importStatementInternal(silent, "silent.txt");
    const bank = await seed!.account.findFirstOrThrow({ where: { accountNumber: number } });
    expect(await seed!.cashFlow.count({ where: { accountId: bank.id } })).toBe(0);
    expect(await seed!.statement.count({ where: { accountId: bank.id, source: "BANK_1C" } })).toBe(1);
    await expect(deleteAccount(bank.id)).rejects.toThrow(/выписки/);
    expect(await seed!.statement.count({ where: { accountId: bank.id } })).toBe(1);

    const historical = await account(`История ${runId}`, `407028100000${runId.slice(0, 8)}f`);
    await seed!.statement.create({
      data: { date: new Date("2019-01-01T00:00:00.000Z"), accountId: historical.id, uploadedAt: new Date() },
    });
    await expect(deleteAccount(historical.id)).rejects.toThrow(/выписки/);
    expect(await seed!.statement.count({ where: { accountId: historical.id, source: null } })).toBe(1);

    const placeholderOwner = await account(`Пустая заготовка ${runId}`, `407028100000${runId.slice(0, 8)}g`);
    const placeholder = await createStatement({
      date: "2026-09-21",
      accountName: placeholderOwner.name,
      fileName: "manual.txt",
      content: "",
      is1C: false,
      bindAccountId: null,
    });
    await expect(deleteAccount(placeholderOwner.id)).rejects.toThrow(/выписки/);
    await deleteStatement(placeholder.id);
    expect(await seed!.statement.count({ where: { accountId: placeholderOwner.id } })).toBe(0);
    await deleteAccount(placeholderOwner.id);
    expect(await seed!.account.count({ where: { id: placeholderOwner.id } })).toBe(0);

    const empty = await account(`Пустой ${runId}`, `407028100000${runId.slice(0, 8)}h`);
    await deleteAccount(empty.id);
    expect(await seed!.account.count({ where: { id: empty.id } })).toBe(0);
  });

  it("H–K imported deal links and unknown statements stay, and a manual placeholder can be deleted", async () => {
    const keyword = `ключ${runId}`;
    const category = await seed!.articleCategory.create({ data: { name: `Категория ${runId}` } });
    const article = await seed!.article.create({
      data: { name: `Статья ${runId}`, flowType: "EXPENSE", categoryId: category.id },
    });
    const importedDeal = await seed!.deal.create({ data: { name: `Импортная ${runId}`, total: 0 } });
    await seed!.autoRule.create({
      data: {
        flowType: "EXPENSE",
        articleId: article.id,
        dealId: importedDeal.id,
        descriptionKeywords: keyword,
        logicOperator: "AND",
      },
    });
    const number = `407028100000${runId.slice(0, 8)}i`;
    await importStatementInternal(bankFile({
      account: number,
      start: "22.09.2026",
      end: "22.09.2026",
      opening: "0.00",
      closing: "12.00",
      docs: [{
        number: "92",
        date: "22.09.2026",
        amount: "12.00",
        payer: number,
        payee: "40602810000000000092",
        purpose: `Оплата ${keyword}`,
      }],
    }), "auto-deal.txt");
    const bank = await seed!.account.findFirstOrThrow({ where: { accountNumber: number } });
    const imported = await seed!.cashFlow.findFirstOrThrow({ where: { accountId: bank.id } });
    expect(imported.dealId).toBe(importedDeal.id);
    expect(imported.statementId).not.toBeNull();
    const anchor = bank.balanceAsOf?.toISOString() ?? null;
    await expect(deleteDeal(importedDeal.id)).rejects.toThrow(/импортированная банковская/);
    const kept = await seed!.cashFlow.findUniqueOrThrow({ where: { id: imported.id } });
    expect(kept.dealId).toBe(importedDeal.id);
    expect(kept.amount.toFixed(2)).toBe("12.00");
    expect(await seed!.deal.count({ where: { id: importedDeal.id } })).toBe(1);
    expect((await seed!.account.findUniqueOrThrow({ where: { id: bank.id } })).balanceAsOf?.toISOString() ?? null).toBe(anchor);

    const manualAccount = await account(`Ручная сделка ${runId}`, `407028100000${runId.slice(0, 8)}j`);
    const manualDeal = await seed!.deal.create({ data: { name: `Ручная ${runId}`, total: 0 } });
    const manual = await createCashFlow({
      date: "2026-09-22",
      amount: 9,
      flowType: "EXPENSE",
      accountName: manualAccount.name,
      counterpartyName: null,
      description: "ручная в сделке",
      articleName: null,
      dealId: manualDeal.id,
      dealName: manualDeal.name,
    });
    await deleteDeal(manualDeal.id);
    expect(await seed!.deal.count({ where: { id: manualDeal.id } })).toBe(0);
    expect((await seed!.cashFlow.findUniqueOrThrow({ where: { id: manual.id } })).dealId).toBeNull();

    const unknownOwner = await account(`Неизвестная ${runId}`, `407028100000${runId.slice(0, 8)}k`);
    const unknown = await seed!.statement.create({
      data: { date: new Date("2018-05-01T00:00:00.000Z"), accountId: unknownOwner.id, uploadedAt: new Date() },
    });
    await expect(deleteStatement(unknown.id)).rejects.toThrow(/нельзя удалить/);
    expect(await seed!.statement.count({ where: { id: unknown.id } })).toBe(1);

    const manualPlaceholder = await createStatement({
      date: "2026-09-22",
      accountName: unknownOwner.name,
      fileName: "manual-2.txt",
      content: "",
      is1C: false,
      bindAccountId: null,
    });
    await deleteStatement(manualPlaceholder.id);
    expect(await seed!.statement.count({ where: { id: manualPlaceholder.id } })).toBe(0);
    expect(await seed!.statement.count({ where: { id: unknown.id } })).toBe(1);
  });
});
