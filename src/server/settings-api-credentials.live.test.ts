import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hashPassword } from "@/lib/password";
import { runDisposableMigrate } from "@/server/internal/disposable-migrate/guard";

const gate = vi.hoisted(() => ({
  admin: true,
  user: { id: "", name: "Проверка", email: "", role: "ADMIN" },
}));

const harness = vi.hoisted(() => ({
  url: "",
  client: null as { $disconnect: () => Promise<void> } | null,
}));

vi.mock("@/server/session", () => ({
  requireAdmin: async () => {
    if (!gate.admin) throw new Error("Требуется сессия администратора");
    return gate.user;
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

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

import { getApiCredentials, saveApiCredentials, verifyApiCredentialsPassword } from "@/server/settings";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LOCAL_PG_BIN = "C:\\Program Files\\PostgreSQL\\18\\bin";
const FORBIDDEN_PORTS = new Set(["5432", "5433", "5434"]);
const password = "correct-admin-password";
const wrongPassword = "wrong-admin-password";

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

describe("API credentials on disposable PostgreSQL", () => {
  let runId = "";
  let database = "";
  let dbPassword = "";
  let container = "";
  let cwd = "";
  let localDataDir = "";
  let started = false;
  let seed: PrismaClient | null = null;

  beforeAll(async () => {
    runId = randomBytes(4).toString("hex");
    database = `p1iso_${runId}`;
    dbPassword = randomBytes(16).toString("hex");
    container = `p1iso-keys-${runId}`;
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "p1iso-keys-"));
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
        email: `keys-${runId}@example.invalid`,
        passwordHash: await hashPassword(password),
        name: "Проверка",
      },
    });
    gate.user = { id: user.id, name: user.name, email: user.email, role: "ADMIN" };
    await seed.setting.createMany({
      data: [
        { key: "apiCred:wb.token", value: "stored-wb-secret" },
        { key: "apiCred:ozon.apiKey", value: "stored-ozon-secret" },
        { key: "apiCred:ozon.clientId", value: "stored-client" },
      ],
    });
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

  async function stored() {
    const rows = await seed!.setting.findMany({
      where: { key: { startsWith: "apiCred:" } },
      orderBy: { key: "asc" },
    });
    return rows.map((row) => `${row.key}=${String(row.value)}`).join("|");
  }

  const original = "apiCred:ozon.apiKey=stored-ozon-secret|apiCred:ozon.clientId=stored-client|apiCred:wb.token=stored-wb-secret";

  it("keeps stored keys out of a passwordless or wrong-password read", async () => {
    gate.admin = true;
    const missing = await getApiCredentials();
    const wrong = await verifyApiCredentialsPassword(wrongPassword);
    expect(missing.ok).toBe(false);
    expect(wrong.ok).toBe(false);
    expect(JSON.stringify([missing, wrong])).not.toContain("stored-wb-secret");
    expect(await stored()).toBe(original);
  });

  it("returns keys only for the correct password", async () => {
    const result = await verifyApiCredentialsPassword(password);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values["wb.token"]).toBe("stored-wb-secret");
  });

  it("does not change stored keys when save has no password or the wrong password", async () => {
    gate.admin = true;
    const missing = await saveApiCredentials("", { "wb.token": "replacement-secret" });
    const wrong = await saveApiCredentials(wrongPassword, { "wb.token": "replacement-secret" });
    expect(missing.ok).toBe(false);
    expect(wrong.ok).toBe(false);
    expect(await stored()).toBe(original);
    expect(JSON.stringify([missing, wrong])).not.toContain("replacement-secret");
  });

  it("updates one field and leaves the others in place", async () => {
    const result = await saveApiCredentials(password, { "wb.token": "updated-wb-secret" });
    expect(result).toEqual({ ok: true });
    expect(await stored()).toBe(
      "apiCred:ozon.apiKey=stored-ozon-secret|apiCred:ozon.clientId=stored-client|apiCred:wb.token=updated-wb-secret",
    );
    const log = await seed!.changeLog.findFirstOrThrow({ where: { entityId: "apiCredentials" } });
    const encoded = JSON.stringify(log.newValues);
    expect(encoded).toContain("wb.token");
    expect(encoded).not.toContain("updated-wb-secret");
    expect(encoded).not.toContain(password);
    await seed!.setting.update({
      where: { key: "apiCred:wb.token" },
      data: { value: "stored-wb-secret" },
    });
  });

  it("rejects a non-admin before changing keys", async () => {
    gate.admin = false;
    await expect(getApiCredentials(password)).rejects.toThrow("Требуется сессия администратора");
    await expect(saveApiCredentials(password, { "ozon.apiKey": "other-secret" })).rejects.toThrow(
      "Требуется сессия администратора",
    );
    expect(await stored()).toBe(original);
    gate.admin = true;
  });
});
