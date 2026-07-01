import { describe, expect, it } from "vitest";
import { formatMpSyncMessage, mpSyncLogLevel, type MpSyncReport } from "@/lib/system-log";

const baseReport = (): MpSyncReport => ({
  since: "2026-06-01T00:00:00.000Z",
  to: "2026-06-08T00:00:00.000Z",
  ok: true,
  durationMs: 1200,
  sources: { wb: "api", ozon: "stub" },
  wb: { mode: "api", sales: 10, supplies: 2, stocks: 5, durationMs: 800 },
  ozon: { mode: "stub", sales: 3, supplies: 1, stocks: 4, durationMs: 0 },
  warnings: [],
  totals: { sales: 13, supplies: 3, stocks: 9 },
});

describe("mpSyncLogLevel", () => {
  it("ERROR при провале", () => {
    expect(mpSyncLogLevel({ ok: false, warnings: [], totals: { sales: 0, supplies: 0, stocks: 0 } })).toBe(
      "ERROR",
    );
  });

  it("WARN при предупреждениях", () => {
    const r = baseReport();
    r.warnings = ["WB: HTTP 429"];
    expect(mpSyncLogLevel(r)).toBe("WARN");
  });

  it("INFO при успехе", () => {
    expect(mpSyncLogLevel(baseReport())).toBe("INFO");
  });
});

describe("formatMpSyncMessage", () => {
  it("успех с режимами", () => {
    const msg = formatMpSyncMessage(baseReport());
    expect(msg).toContain("продажи 13");
    expect(msg).toContain("WB:api");
  });

  it("ошибка", () => {
    const r = baseReport();
    r.ok = false;
    r.error = "WB: HTTP 429";
    expect(formatMpSyncMessage(r)).toBe("WB: HTTP 429");
  });
});
