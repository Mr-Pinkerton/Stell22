import { describe, expect, it } from "vitest";
import {
  applyRailsCancelled,
  applyRailsConfirmed,
  canEnterTorcovkaBlanks,
  decideBatchTap,
  decideLotTap,
  isTorcovkaDirty,
  nextTorcovkaStateAfterSuccess,
  OPERATION_SAVED_TITLE,
  refreshAfterSavedOperation,
  shouldShowTorcovkaConfirmBar,
  shouldShowTorcovkaWastePct,
  shouldSkipTorcovkaDraftPersist,
  TERMINAL_REFRESH_AFTER_SAVE_WARNING,
  torcovkaBlankPrerequisiteHint,
  torcovkaSavedDetail,
  TORCOVKA_SWITCH_RESET,
  TORCOVKA_SWITCH_STAY,
  TORCOVKA_SWITCH_WARNING,
} from "./torcovka-terminal-flow";

describe("canEnterTorcovkaBlanks", () => {
  it("blocks blanks with no lot", () => {
    expect(canEnterTorcovkaBlanks({ lotId: null, railsTaken: 4 })).toBe(false);
  });

  it("blocks blanks when lot is selected but railsTaken is 0", () => {
    expect(canEnterTorcovkaBlanks({ lotId: "lot-1", railsTaken: 0 })).toBe(false);
  });

  it("allows blanks only after lot and railsTaken > 0", () => {
    expect(canEnterTorcovkaBlanks({ lotId: "lot-1", railsTaken: 1 })).toBe(true);
  });
});

describe("isTorcovkaDirty", () => {
  it("is clean with no rails and no picks", () => {
    expect(isTorcovkaDirty({ railsTaken: 0, pickedCount: 0 })).toBe(false);
  });

  it("is dirty when rails were confirmed", () => {
    expect(isTorcovkaDirty({ railsTaken: 2, pickedCount: 0 })).toBe(true);
  });

  it("is dirty when blanks were picked", () => {
    expect(isTorcovkaDirty({ railsTaken: 0, pickedCount: 3 })).toBe(true);
  });
});

describe("decideLotTap", () => {
  it("reopens rails editor for the committed lot", () => {
    expect(
      decideLotTap({ tappedLotId: "lot-1", committedLotId: "lot-1", dirty: true }),
    ).toEqual({ action: "edit-rails" });
  });

  it("opens pending rails without wiping when switching a clean selection", () => {
    expect(
      decideLotTap({ tappedLotId: "lot-2", committedLotId: "lot-1", dirty: false }),
    ).toEqual({ action: "open-pending-rails", nextLotId: "lot-2" });
  });

  it("asks confirmation before switching away from dirty input", () => {
    expect(
      decideLotTap({ tappedLotId: "lot-2", committedLotId: "lot-1", dirty: true }),
    ).toEqual({ action: "confirm-switch", nextLotId: "lot-2" });
  });

  it("opens pending rails when no lot is committed yet", () => {
    expect(
      decideLotTap({ tappedLotId: "lot-1", committedLotId: null, dirty: false }),
    ).toEqual({ action: "open-pending-rails", nextLotId: "lot-1" });
  });
});

describe("decideBatchTap", () => {
  it("ignores tapping the already selected batch", () => {
    expect(
      decideBatchTap({ tappedBatchId: "b1", committedBatchId: "b1", dirty: true }),
    ).toBe("noop");
  });

  it("switches immediately when input is clean", () => {
    expect(
      decideBatchTap({ tappedBatchId: "b2", committedBatchId: "b1", dirty: false }),
    ).toBe("switch");
  });

  it("asks confirmation when dirty input would be discarded", () => {
    expect(
      decideBatchTap({ tappedBatchId: "b2", committedBatchId: "b1", dirty: true }),
    ).toBe("confirm-switch");
  });
});

describe("rails dialog commit", () => {
  it("commits pending lot and resets picks when the lot actually changes", () => {
    expect(
      applyRailsConfirmed({
        pendingLotId: "lot-2",
        committedLotId: "lot-1",
        railsTaken: 3,
      }),
    ).toEqual({ lotId: "lot-2", railsTaken: 3, resetPicks: true });
  });

  it("keeps picks when confirming rails on the same committed lot", () => {
    expect(
      applyRailsConfirmed({
        pendingLotId: "lot-1",
        committedLotId: "lot-1",
        railsTaken: 5,
      }),
    ).toEqual({ lotId: "lot-1", railsTaken: 5, resetPicks: false });
  });

  it("cancel drops only the pending lot and leaves committed state alone", () => {
    expect(applyRailsCancelled()).toEqual({ pendingLotId: null });
  });
});

describe("nextTorcovkaStateAfterSuccess", () => {
  it("keeps the batch and lot when both still exist with remaining rails", () => {
    expect(
      nextTorcovkaStateAfterSuccess({
        batchId: "b1",
        lotId: "lot-1",
        batches: [{ id: "b1" }],
        lots: [{ id: "lot-1", remainingQuantity: 4 }],
      }),
    ).toEqual({ batchId: "b1", lotId: "lot-1", railsTaken: 0 });
  });

  it("drops the lot when remainingQuantity is 0 after refresh", () => {
    expect(
      nextTorcovkaStateAfterSuccess({
        batchId: "b1",
        lotId: "lot-1",
        batches: [{ id: "b1" }],
        lots: [{ id: "lot-1", remainingQuantity: 0 }],
      }),
    ).toEqual({ batchId: "b1", lotId: null, railsTaken: 0 });
  });

  it("does not keep a stale remainingQuantity from before refresh", () => {
    expect(
      nextTorcovkaStateAfterSuccess({
        batchId: "b1",
        lotId: "missing",
        batches: [{ id: "b1" }],
        lots: [{ id: "lot-other", remainingQuantity: 9 }],
      }),
    ).toEqual({ batchId: "b1", lotId: null, railsTaken: 0 });
  });

  it("drops batch and lot when the batch disappeared after refresh", () => {
    expect(
      nextTorcovkaStateAfterSuccess({
        batchId: "gone",
        lotId: "lot-1",
        batches: [{ id: "b1" }],
        lots: [{ id: "lot-1", remainingQuantity: 4 }],
      }),
    ).toEqual({ batchId: null, lotId: null, railsTaken: 0 });
  });
});

describe("torcovkaBlankPrerequisiteHint", () => {
  it("asks for a package before rails when batch is selected", () => {
    expect(
      torcovkaBlankPrerequisiteHint({ batchId: "b1", lotId: null, railsTaken: 0 }),
    ).toBe("Выберите пакет / рейку");
  });

  it("asks for rails instead of showing 100% waste", () => {
    expect(
      torcovkaBlankPrerequisiteHint({ batchId: "b1", lotId: "lot-1", railsTaken: 0 }),
    ).toBe("Укажите количество взятых реек");
  });

  it("hides the prerequisite once blanks may be entered", () => {
    expect(
      torcovkaBlankPrerequisiteHint({ batchId: "b1", lotId: "lot-1", railsTaken: 2 }),
    ).toBeNull();
  });
});

describe("shouldShowTorcovkaConfirmBar", () => {
  it("hides the confirm bar when there are no picks even if rails were taken", () => {
    expect(shouldShowTorcovkaConfirmBar({ pickedCount: 0 })).toBe(false);
  });

  it("shows the confirm bar only after at least one blank is picked", () => {
    expect(shouldShowTorcovkaConfirmBar({ pickedCount: 1 })).toBe(true);
  });
});

describe("success acknowledgement copy", () => {
  it("uses the shared title the worker can read without a toast", () => {
    expect(OPERATION_SAVED_TITLE).toBe("Операция сохранена");
  });

  it("adds TORCOVKA quantity in Russian plural", () => {
    expect(torcovkaSavedDetail(1)).toBe("Торцовка сохранена: 1 заготовка");
    expect(torcovkaSavedDetail(4)).toBe("Торцовка сохранена: 4 заготовки");
    expect(torcovkaSavedDetail(5)).toBe("Торцовка сохранена: 5 заготовок");
  });
});

describe("destructive switch copy", () => {
  it("warns that entered data will be reset", () => {
    expect(TORCOVKA_SWITCH_WARNING).toBe("Введённые данные будут сброшены.");
    expect(TORCOVKA_SWITCH_STAY).toBe("Остаться");
    expect(TORCOVKA_SWITCH_RESET).toBe("Сбросить и сменить");
  });
});

describe("shouldShowTorcovkaWastePct", () => {
  it("hides 100% waste when rails are taken but no blanks are picked", () => {
    expect(shouldShowTorcovkaWastePct({ producedM: 0 })).toBe(false);
  });

  it("shows the real waste percentage after at least one blank is picked", () => {
    expect(shouldShowTorcovkaWastePct({ producedM: 1.2 })).toBe(true);
  });
});

describe("shouldSkipTorcovkaDraftPersist", () => {
  it("skips persist after success while the kept batch/lot is still clean", () => {
    expect(
      shouldSkipTorcovkaDraftPersist({
        suppressPostSuccess: true,
        railsTaken: 0,
        pickedCount: 0,
      }),
    ).toBe(true);
  });

  it("does not skip once the worker starts the next rails/picks input", () => {
    expect(
      shouldSkipTorcovkaDraftPersist({
        suppressPostSuccess: true,
        railsTaken: 1,
        pickedCount: 0,
      }),
    ).toBe(false);
  });

  it("does not skip ordinary pre-submit draft saves", () => {
    expect(
      shouldSkipTorcovkaDraftPersist({
        suppressPostSuccess: false,
        railsTaken: 0,
        pickedCount: 0,
      }),
    ).toBe(false);
  });
});

describe("refreshAfterSavedOperation", () => {
  it("does not throw into the submit catch when TerminalData refresh fails", async () => {
    const submitErrors: string[] = [];
    let result: "ok" | "refresh-failed" = "ok";
    try {
      result = await refreshAfterSavedOperation(async () => {
        throw new Error("getTerminalData failed");
      });
    } catch (err) {
      submitErrors.push(err instanceof Error ? err.message : "Ошибка внесения");
    }
    expect(result).toBe("refresh-failed");
    expect(submitErrors).toEqual([]);
  });

  it("returns ok when refresh succeeds", async () => {
    await expect(refreshAfterSavedOperation(async () => undefined)).resolves.toBe("ok");
  });

  it("names the warning as a saved operation with a refresh problem, not a submit failure", () => {
    expect(TERMINAL_REFRESH_AFTER_SAVE_WARNING).toContain("Операция сохранена");
    expect(TERMINAL_REFRESH_AFTER_SAVE_WARNING).not.toBe("Ошибка внесения");
    expect(TERMINAL_REFRESH_AFTER_SAVE_WARNING).not.toContain("Ошибка внесения");
  });
});
