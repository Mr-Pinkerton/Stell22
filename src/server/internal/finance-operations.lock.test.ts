import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import {
  lockAccountsThenDealsThenBatches,
  lockBatches,
  lockDealsThenBatches,
  lockProductionOperations,
  lockRailLots,
  LockSetChangedError,
  retryOnLockSetChange,
  sameSortedIds,
  sortedUniqueIds,
} from "./finance-operations";

const internalDir = path.dirname(fileURLToPath(import.meta.url));

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkTsFiles(full));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

describe("sortedUniqueIds", () => {
  it("dedupes, drops empties, sorts ASC", () => {
    expect(sortedUniqueIds(["b", "a", "b", "", "a"])).toEqual(["a", "b"]);
  });
});

describe("sameSortedIds", () => {
  it("compares unique sorted sets", () => {
    expect(sameSortedIds(["b", "a"], ["a", "b", "a"])).toBe(true);
    expect(sameSortedIds(["a"], ["a", "b"])).toBe(false);
  });
});

describe("retryOnLockSetChange", () => {
  it("retries LockSetChangedError then succeeds", async () => {
    let n = 0;
    const value = await retryOnLockSetChange(async () => {
      n += 1;
      if (n < 3) throw new LockSetChangedError();
      return "ok";
    });
    expect(value).toBe("ok");
    expect(n).toBe(3);
  });
});

describe("lock order", () => {
  it("lockDealsThenBatches locks Deal then Batch in id order", async () => {
    const sqls: string[] = [];
    const db = {
      $queryRaw: vi.fn(async (query: Prisma.Sql) => {
        sqls.push(query.strings.join("?"));
        return [];
      }),
      dealItem: {
        findMany: vi.fn(async () => [{ batchId: "batch-z" }, { batchId: "batch-a" }]),
      },
    };

    await lockDealsThenBatches(db as never, ["deal-b", "deal-a"]);

    expect(sqls[0]).toContain('"Deal"');
    expect(sqls[0]).toContain("FOR UPDATE");
    expect(sqls[1]).toContain('"Batch"');
    expect(sqls[1]).toContain("FOR UPDATE");
    expect(db.dealItem.findMany).toHaveBeenCalledOnce();
  });

  it("lockAccountsThenDealsThenBatches locks Account before Deal before Batch", async () => {
    const tables: string[] = [];
    const db = {
      $queryRaw: vi.fn(async (query: Prisma.Sql) => {
        const text = query.strings.join("?");
        if (text.includes('"Account"')) tables.push("Account");
        if (text.includes('"Deal"')) tables.push("Deal");
        if (text.includes('"Batch"')) tables.push("Batch");
        return [];
      }),
      dealItem: { findMany: vi.fn(async () => [{ batchId: "batch-1" }]) },
    };

    await lockAccountsThenDealsThenBatches(db as never, ["acc-2", "acc-1"], ["deal-1"]);
    expect(tables).toEqual(["Account", "Deal", "Batch"]);
  });

  it("skips empty id lists", async () => {
    const db = { $queryRaw: vi.fn(), dealItem: { findMany: vi.fn() } };
    await lockAccountsThenDealsThenBatches(db as never, [], []);
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(db.dealItem.findMany).not.toHaveBeenCalled();
  });

  it("lockBatches locks Batch ORDER BY id FOR UPDATE and skips empty", async () => {
    const sqls: string[] = [];
    const db = {
      $queryRaw: vi.fn(async (query: Prisma.Sql) => {
        sqls.push(query.strings.join("?"));
        return [];
      }),
    };
    await lockBatches(db as never, ["batch-z", "batch-a", "batch-a"]);
    expect(sqls).toHaveLength(1);
    expect(sqls[0]).toContain('"Batch"');
    expect(sqls[0]).toContain("ORDER BY id FOR UPDATE");
    await lockBatches(db as never, []);
    expect(db.$queryRaw).toHaveBeenCalledOnce();
  });

  it("lockProductionOperations locks ProductionOperation ORDER BY id FOR UPDATE and skips empty", async () => {
    const sqls: string[] = [];
    const db = {
      $queryRaw: vi.fn(async (query: Prisma.Sql) => {
        sqls.push(query.strings.join("?"));
        return [];
      }),
    };
    await lockProductionOperations(db as never, ["op-b", "op-a"]);
    expect(sqls).toHaveLength(1);
    expect(sqls[0]).toContain('"ProductionOperation"');
    expect(sqls[0]).toContain("ORDER BY id FOR UPDATE");
    await lockProductionOperations(db as never, [null, ""]);
    expect(db.$queryRaw).toHaveBeenCalledOnce();
  });

  it("lockRailLots locks RailLot ORDER BY id FOR UPDATE and skips empty", async () => {
    const sqls: string[] = [];
    const db = {
      $queryRaw: vi.fn(async (query: Prisma.Sql) => {
        sqls.push(query.strings.join("?"));
        return [];
      }),
    };
    await lockRailLots(db as never, ["lot-z", "lot-a", "lot-a"]);
    expect(sqls).toHaveLength(1);
    expect(sqls[0]).toContain('"RailLot"');
    expect(sqls[0]).toContain("ORDER BY id FOR UPDATE");
    await lockRailLots(db as never, []);
    expect(db.$queryRaw).toHaveBeenCalledOnce();
  });
});

describe("internal modules are Next-free", () => {
  it("does not import next/cache", () => {
    const hits: string[] = [];
    for (const file of walkTsFiles(internalDir)) {
      const src = readFileSync(file, "utf8");
      if (src.includes("next/cache") || src.includes("revalidatePath")) {
        hits.push(path.relative(internalDir, file));
      }
    }
    expect(hits).toEqual([]);
  });
});
