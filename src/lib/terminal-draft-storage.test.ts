import { describe, expect, it } from "vitest";
import { restorePendingAck } from "./restore-pending-ack";
import {
  clearDraft,
  draftStorageKey,
  isDraftStaleByAge,
  isMeaningful,
  parseTerminalDraft,
  persistPendingDraft,
  readDraft,
  serializeDraft,
  writeDraft,
  type TerminalDraftV1,
} from "./terminal-draft-storage";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(k) {
      return map.has(k) ? map.get(k)! : null;
    },
    key(i) {
      return [...map.keys()][i] ?? null;
    },
    removeItem(k) {
      map.delete(k);
    },
    setItem(k, v) {
      map.set(k, v);
    },
  } as Storage;
}

function throwingStorage(method: "getItem" | "setItem" | "removeItem"): Storage {
  const inner = memoryStorage();
  return {
    ...inner,
    [method]: () => {
      throw new Error("quota");
    },
  } as Storage;
}

const emptyAck = {
  phase: "none" as const,
  approvalCode: "",
};

function torcovkaDraft(over: Partial<TerminalDraftV1> & { employeeId?: string } = {}): TerminalDraftV1 {
  return {
    version: 1,
    employeeId: over.employeeId ?? "emp-a",
    clientRequestId: "id-abc",
    createdAt: "2026-09-05T11:32:00.000Z",
    updatedAt: "2026-09-05T11:33:00.000Z",
    operationType: "TORCOVKA",
    payload: {
      batchId: "batch-1",
      lotId: "lot-1",
      railsTaken: 10,
      picks: [{ lengthM: 1.2, sort: "SORT1", quantity: 19 }],
      activeSort: "SORT1",
      ackUi: { ...emptyAck },
    },
    ...over,
  } as TerminalDraftV1;
}

describe("terminal-draft-storage", () => {
  it("1 write/read TORCOVKA round-trip", () => {
    const storage = memoryStorage();
    const draft = torcovkaDraft();
    writeDraft(storage, draft);
    const read = readDraft(storage, "emp-a");
    expect(read).toEqual({ status: "ok", draft: serializeDraft(draft) });
  });

  it("2 rehydrate after JSON.parse (reload)", () => {
    const storage = memoryStorage();
    writeDraft(storage, torcovkaDraft());
    const raw = storage.getItem(draftStorageKey("emp-a"));
    const parsed = parseTerminalDraft(JSON.parse(raw!));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.draft.clientRequestId).toBe("id-abc");
  });

  it("3 same employee key survives simulated logout", () => {
    const storage = memoryStorage();
    writeDraft(storage, torcovkaDraft());
    expect(readDraft(storage, "emp-a").status).toBe("ok");
    expect(readDraft(storage, "emp-a")).toMatchObject({
      status: "ok",
      draft: { clientRequestId: "id-abc" },
    });
  });

  it("4 employee isolation: B does not see A", () => {
    const storage = memoryStorage();
    writeDraft(storage, torcovkaDraft({ employeeId: "emp-a" }));
    expect(readDraft(storage, "emp-b").status).toBe("none");
  });

  it("5 clear B does not remove A", () => {
    const storage = memoryStorage();
    writeDraft(storage, torcovkaDraft({ employeeId: "emp-a" }));
    writeDraft(
      storage,
      torcovkaDraft({
        employeeId: "emp-b",
        clientRequestId: "id-b",
      }),
    );
    clearDraft(storage, "emp-b");
    expect(readDraft(storage, "emp-a")).toMatchObject({
      status: "ok",
      draft: { clientRequestId: "id-abc" },
    });
    expect(readDraft(storage, "emp-b").status).toBe("none");
  });

  it("6 clientRequestId byte-for-byte", () => {
    const storage = memoryStorage();
    const id = "550e8400-e29b-41d4-a716-446655440000";
    writeDraft(storage, torcovkaDraft({ clientRequestId: id }));
    const read = readDraft(storage, "emp-a");
    expect(read.status === "ok" && read.draft.clientRequestId === id).toBe(true);
  });

  it("7 clear after simulated CREATED", () => {
    const storage = memoryStorage();
    writeDraft(storage, torcovkaDraft());
    clearDraft(storage, "emp-a");
    expect(readDraft(storage, "emp-a").status).toBe("none");
  });

  it("8 ACK payload does not imply clear", () => {
    const storage = memoryStorage();
    const draft = torcovkaDraft();
    if (draft.operationType !== "TORCOVKA") throw new Error("setup");
    draft.payload.ackUi = {
      phase: "approval",
      approvalCode: "0427",
    };
    writeDraft(storage, draft);
    expect(readDraft(storage, "emp-a").status).toBe("ok");
  });

  it("9 storage write errors do not throw", () => {
    expect(() => writeDraft(throwingStorage("setItem"), torcovkaDraft())).not.toThrow();
  });

  it("10 explicit delete clears only current key", () => {
    const storage = memoryStorage();
    writeDraft(storage, torcovkaDraft({ employeeId: "emp-a" }));
    clearDraft(storage, "emp-a");
    expect(storage.getItem(draftStorageKey("emp-a"))).toBeNull();
  });

  it("11 malformed JSON is safe", () => {
    const storage = memoryStorage();
    storage.setItem(draftStorageKey("emp-a"), "{not json");
    expect(readDraft(storage, "emp-a")).toEqual({ status: "error", reason: "malformed" });
    expect(parseTerminalDraft(null)).toEqual({ ok: false, reason: "malformed" });
    expect(parseTerminalDraft([])).toEqual({ ok: false, reason: "malformed" });
  });

  it("12 unsupported version is safe", () => {
    expect(parseTerminalDraft({ version: 2, employeeId: "x" })).toEqual({
      ok: false,
      reason: "unsupported_version",
    });
  });

  it("13 stale lot id survives parse", () => {
    const parsed = parseTerminalDraft(torcovkaDraft());
    expect(parsed.ok && parsed.draft.operationType === "TORCOVKA").toBe(true);
    if (parsed.ok && parsed.draft.operationType === "TORCOVKA") {
      expect(parsed.draft.payload.lotId).toBe("lot-1");
    }
  });

  it("14 PRISADKA picks round-trip", () => {
    const storage = memoryStorage();
    const draft: TerminalDraftV1 = {
      version: 1,
      employeeId: "emp-a",
      clientRequestId: "p-1",
      createdAt: "2026-09-05T11:00:00.000Z",
      updatedAt: "2026-09-05T11:00:00.000Z",
      operationType: "PRISADKA",
      payload: { picks: [{ detailId: "d1", kind: "torcev", quantity: 2 }] },
    };
    writeDraft(storage, draft);
    const read = readDraft(storage, "emp-a");
    expect(read.status === "ok" && read.draft.operationType === "PRISADKA").toBe(true);
    if (read.status === "ok" && read.draft.operationType === "PRISADKA") {
      expect(read.draft.payload.picks).toEqual([{ detailId: "d1", kind: "torcev", quantity: 2 }]);
    }
  });

  it("15 UPAKOVKA picks round-trip", () => {
    const storage = memoryStorage();
    const draft: TerminalDraftV1 = {
      version: 1,
      employeeId: "emp-a",
      clientRequestId: "u-1",
      createdAt: "2026-09-05T11:00:00.000Z",
      updatedAt: "2026-09-05T11:00:00.000Z",
      operationType: "UPAKOVKA",
      payload: { picks: [{ productId: "prod-1", quantity: 3 }] },
    };
    writeDraft(storage, draft);
    const read = readDraft(storage, "emp-a");
    expect(read.status === "ok" && read.draft.operationType === "UPAKOVKA").toBe(true);
  });

  it("16 legacy extreme reason/note parse safely and keep approvalCode empty", () => {
    const parsed = parseTerminalDraft({
      version: 1,
      employeeId: "emp-a",
      clientRequestId: "id-abc",
      createdAt: "2026-09-05T11:32:00.000Z",
      updatedAt: "2026-09-05T11:33:00.000Z",
      operationType: "TORCOVKA",
      payload: {
        batchId: "batch-1",
        lotId: "lot-1",
        railsTaken: 10,
        picks: [{ lengthM: 1.2, sort: "SORT1", quantity: 19 }],
        activeSort: "SORT1",
        ackUi: {
          phase: "extreme",
          highWasteReason: "OTHER",
          highWasteNote: "скол",
        },
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.draft.operationType !== "TORCOVKA") throw new Error("setup");
    expect(parsed.draft.payload.ackUi).toEqual({
      phase: "none",
      approvalCode: "",
    });
    expect(parsed.draft.clientRequestId).toBe("id-abc");
    expect(parsed.draft.payload.batchId).toBe("batch-1");
    expect(parsed.draft.payload.lotId).toBe("lot-1");
    expect(parsed.draft.payload.railsTaken).toBe(10);
    expect(
      restorePendingAck({
        draft: parsed.draft,
        railLots: [{ id: "lot-1", lengthM: 10 }],
      }),
    ).toBeNull();
  });

  it("16b approval code round-trip keeps leading zeros", () => {
    const storage = memoryStorage();
    const draft = torcovkaDraft();
    if (draft.operationType !== "TORCOVKA") throw new Error("setup");
    draft.payload.ackUi = { phase: "approval", approvalCode: "0007" };
    writeDraft(storage, draft);
    const read = readDraft(storage, "emp-a");
    expect(read.status === "ok" && read.draft.operationType === "TORCOVKA").toBe(true);
    if (read.status === "ok" && read.draft.operationType === "TORCOVKA") {
      expect(read.draft.payload.ackUi).toEqual({
        phase: "approval",
        approvalCode: "0007",
      });
      expect(read.draft.clientRequestId).toBe("id-abc");
    }
  });

  it("17 serialized JSON does not contain secrets", () => {
    const json = JSON.stringify(serializeDraft(torcovkaDraft()));
    expect(json).not.toMatch(/pin/i);
    expect(json).not.toContain("stell22_terminal");
    expect(json).not.toContain("SESSION");
    expect(json).not.toContain("hourlyRate");
    expect(json).not.toContain("JWT");
  });

  it("18 HOURS hoursInput round-trip", () => {
    const storage = memoryStorage();
    const draft: TerminalDraftV1 = {
      version: 1,
      employeeId: "emp-a",
      clientRequestId: "h-1",
      createdAt: "2026-09-05T11:00:00.000Z",
      updatedAt: "2026-09-05T11:00:00.000Z",
      operationType: "HOURS",
      payload: { hoursInput: "8.5" },
    };
    writeDraft(storage, draft);
    const read = readDraft(storage, "emp-a");
    expect(read.status === "ok" && read.draft.operationType === "HOURS").toBe(true);
    if (read.status === "ok" && read.draft.operationType === "HOURS") {
      expect(read.draft.payload.hoursInput).toBe("8.5");
    }
  });

  it("isMeaningful: empty TORCOVKA is not meaningful; batch is", () => {
    const empty = torcovkaDraft();
    if (empty.operationType !== "TORCOVKA") throw new Error("setup");
    empty.payload.batchId = null;
    empty.payload.lotId = null;
    empty.payload.railsTaken = 0;
    empty.payload.picks = [];
    expect(isMeaningful(empty)).toBe(false);
    empty.payload.batchId = "b1";
    expect(isMeaningful(empty)).toBe(true);
  });

  it("age helper does not delete; 24h is display-only", () => {
    const recent = new Date().toISOString();
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    expect(isDraftStaleByAge(recent)).toBe(false);
    expect(isDraftStaleByAge(old)).toBe(true);
    const storage = memoryStorage();
    writeDraft(storage, torcovkaDraft({ createdAt: old, updatedAt: old }));
    expect(readDraft(storage, "emp-a").status).toBe("ok");
  });

  it("getItem throw is safe (no crash, no draft)", () => {
    expect(readDraft(throwingStorage("getItem"), "emp-a")).toEqual({ status: "none" });
  });

  it("removeItem throw is safe", () => {
    expect(() => clearDraft(throwingStorage("removeItem"), "emp-a")).not.toThrow();
  });

  it("mismatched employeeId in JSON is ignored", () => {
    const storage = memoryStorage();
    storage.setItem(draftStorageKey("emp-a"), JSON.stringify(torcovkaDraft({ employeeId: "emp-other" })));
    expect(readDraft(storage, "emp-a").status).toBe("none");
  });

  it("empty initial screen payloads are not meaningful", () => {
    expect(
      isMeaningful({
        version: 1,
        employeeId: "emp-a",
        clientRequestId: "p-empty",
        createdAt: "2026-09-05T11:00:00.000Z",
        updatedAt: "2026-09-05T11:00:00.000Z",
        operationType: "PRISADKA",
        payload: { picks: [] },
      }),
    ).toBe(false);
    expect(
      isMeaningful({
        version: 1,
        employeeId: "emp-a",
        clientRequestId: "u-empty",
        createdAt: "2026-09-05T11:00:00.000Z",
        updatedAt: "2026-09-05T11:00:00.000Z",
        operationType: "UPAKOVKA",
        payload: { picks: [] },
      }),
    ).toBe(false);
    expect(
      isMeaningful({
        version: 1,
        employeeId: "emp-a",
        clientRequestId: "h-empty",
        createdAt: "2026-09-05T11:00:00.000Z",
        updatedAt: "2026-09-05T11:00:00.000Z",
        operationType: "HOURS",
        payload: { hoursInput: "" },
      }),
    ).toBe(false);
  });

  it("A empty HOURS does not create a draft", () => {
    const storage = memoryStorage();
    const pending: TerminalDraftV1 = {
      version: 1,
      employeeId: "emp-a",
      clientRequestId: "h-new",
      createdAt: "2026-09-05T11:00:00.000Z",
      updatedAt: "2026-09-05T11:00:00.000Z",
      operationType: "HOURS",
      payload: { hoursInput: "" },
    };
    expect(persistPendingDraft(storage, pending, false)).toBe(false);
    expect(readDraft(storage, "emp-a").status).toBe("none");
  });

  it("B persisted HOURS then empty updates storage, keeps id", () => {
    const storage = memoryStorage();
    const filled: TerminalDraftV1 = {
      version: 1,
      employeeId: "emp-a",
      clientRequestId: "h-keep",
      createdAt: "2026-09-05T11:00:00.000Z",
      updatedAt: "2026-09-05T11:00:00.000Z",
      operationType: "HOURS",
      payload: { hoursInput: "8" },
    };
    writeDraft(storage, filled);
    const emptied: TerminalDraftV1 = {
      ...filled,
      updatedAt: "2026-09-05T11:01:00.000Z",
      payload: { hoursInput: "" },
    };
    expect(persistPendingDraft(storage, emptied, true)).toBe(true);
    const read = readDraft(storage, "emp-a");
    expect(read.status).toBe("ok");
    if (read.status !== "ok" || read.draft.operationType !== "HOURS") throw new Error("setup");
    expect(read.draft.payload.hoursInput).toBe("");
    expect(read.draft.clientRequestId).toBe("h-keep");
    expect(storage.getItem(draftStorageKey("emp-a"))).not.toBeNull();
  });

  it("C persisted PRISADKA then empty picks updates storage, keeps id", () => {
    const storage = memoryStorage();
    const filled: TerminalDraftV1 = {
      version: 1,
      employeeId: "emp-a",
      clientRequestId: "p-keep",
      createdAt: "2026-09-05T11:00:00.000Z",
      updatedAt: "2026-09-05T11:00:00.000Z",
      operationType: "PRISADKA",
      payload: { picks: [{ detailId: "d1", kind: "torcev", quantity: 10 }] },
    };
    writeDraft(storage, filled);
    const emptied: TerminalDraftV1 = {
      ...filled,
      updatedAt: "2026-09-05T11:01:00.000Z",
      payload: { picks: [] },
    };
    expect(persistPendingDraft(storage, emptied, true)).toBe(true);
    const read = readDraft(storage, "emp-a");
    expect(read.status === "ok" && read.draft.operationType === "PRISADKA").toBe(true);
    if (read.status === "ok" && read.draft.operationType === "PRISADKA") {
      expect(read.draft.payload.picks).toEqual([]);
      expect(read.draft.clientRequestId).toBe("p-keep");
    }
  });

  it("D persisted UPAKOVKA then empty picks updates storage, keeps id", () => {
    const storage = memoryStorage();
    const filled: TerminalDraftV1 = {
      version: 1,
      employeeId: "emp-a",
      clientRequestId: "u-keep",
      createdAt: "2026-09-05T11:00:00.000Z",
      updatedAt: "2026-09-05T11:00:00.000Z",
      operationType: "UPAKOVKA",
      payload: { picks: [{ productId: "prod-1", quantity: 10 }] },
    };
    writeDraft(storage, filled);
    const emptied: TerminalDraftV1 = {
      ...filled,
      updatedAt: "2026-09-05T11:01:00.000Z",
      payload: { picks: [] },
    };
    expect(persistPendingDraft(storage, emptied, true)).toBe(true);
    const read = readDraft(storage, "emp-a");
    expect(read.status === "ok" && read.draft.operationType === "UPAKOVKA").toBe(true);
    if (read.status === "ok" && read.draft.operationType === "UPAKOVKA") {
      expect(read.draft.payload.picks).toEqual([]);
      expect(read.draft.clientRequestId).toBe("u-keep");
    }
  });

  it("E explicit clear removes the key", () => {
    const storage = memoryStorage();
    writeDraft(storage, torcovkaDraft());
    clearDraft(storage, "emp-a");
    expect(storage.getItem(draftStorageKey("emp-a"))).toBeNull();
    expect(readDraft(storage, "emp-a").status).toBe("none");
  });
});
