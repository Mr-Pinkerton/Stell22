import { describe, expect, it, vi } from "vitest";
import { settleTorcovkaAfterCommit } from "@/lib/torcovka-post-commit";

describe("settleTorcovkaAfterCommit", () => {
  it("returns a plain save when recalc and page refresh succeed", async () => {
    const recalc = vi.fn(async () => undefined);
    const refreshPages = vi.fn();
    const recordFailure = vi.fn(async () => undefined);
    await expect(
      settleTorcovkaAfterCommit({ recalc, refreshPages, recordFailure }),
    ).resolves.toEqual({ status: "CREATED" });
    expect(recalc).toHaveBeenCalledOnce();
    expect(refreshPages).toHaveBeenCalledOnce();
    expect(recordFailure).not.toHaveBeenCalled();
  });

  it("keeps the save when cost recalc throws and records that failure", async () => {
    const failure = new Error("recalc down");
    const recordFailure = vi.fn(async () => undefined);
    await expect(
      settleTorcovkaAfterCommit({
        recalc: async () => {
          throw failure;
        },
        refreshPages: () => undefined,
        recordFailure,
      }),
    ).resolves.toEqual({ status: "CREATED", costRecalc: "FAILED" });
    expect(recordFailure).toHaveBeenCalledWith("cost-recalc", failure);
  });

  it("keeps the save when page refresh throws after a skipped replay recalc", async () => {
    const failure = new Error("revalidate down");
    const recordFailure = vi.fn(async () => undefined);
    await expect(
      settleTorcovkaAfterCommit({
        recalc: null,
        refreshPages: () => {
          throw failure;
        },
        recordFailure,
      }),
    ).resolves.toEqual({ status: "CREATED", pageRefresh: "FAILED" });
    expect(recordFailure).toHaveBeenCalledWith("page-refresh", failure);
  });

  it("reports both failures without throwing", async () => {
    await expect(
      settleTorcovkaAfterCommit({
        recalc: async () => {
          throw new Error("recalc down");
        },
        refreshPages: () => {
          throw new Error("revalidate down");
        },
        recordFailure: async () => undefined,
      }),
    ).resolves.toEqual({ status: "CREATED", costRecalc: "FAILED", pageRefresh: "FAILED" });
  });

  it("still returns the save when the diagnostic record itself fails", async () => {
    await expect(
      settleTorcovkaAfterCommit({
        recalc: async () => {
          throw new Error("recalc down");
        },
        refreshPages: () => undefined,
        recordFailure: async () => {
          throw new Error("log down");
        },
      }),
    ).resolves.toEqual({ status: "CREATED", costRecalc: "FAILED" });
  });
});
