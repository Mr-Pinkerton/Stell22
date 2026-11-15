/** @vitest-environment happy-dom */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SalesData } from "@/server/marketplace";

const syncMarketplaces = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/server/marketplace", () => ({
  syncMarketplaces,
}));

import { SalesView } from "@/components/sales/sales-view";

const PRODUCTION_FREEZE = "Синхронизация с маркетплейсами отключена: production freeze.";

const emptySales: SalesData = {
  rows: [],
  totalQty: 0,
  totalRevenue: 0,
  lastSyncedAt: null,
};

afterEach(() => {
  cleanup();
  syncMarketplaces.mockReset();
});

describe("sales marketplace sync freeze", () => {
  it("shows a disabled sync action and does not call the server during the production freeze", async () => {
    const user = userEvent.setup();
    render(<SalesView data={emptySales} syncFrozenMessage={PRODUCTION_FREEZE} />);
    const button = screen.getByRole("button", { name: "Синхронизировать с МП" });
    expect(button).toHaveProperty("disabled", true);
    const status = screen.getByText(PRODUCTION_FREEZE);
    expect(status.getAttribute("role")).toBe("status");
    expect(screen.getByText("Продаж нет")).toBeTruthy();
    expect(screen.queryByText(/нажмите «Синхронизировать с МП»/)).toBeNull();
    await user.click(button);
    expect(syncMarketplaces).not.toHaveBeenCalled();
  });

  it("keeps synchronization available when the server does not freeze it", () => {
    render(<SalesView data={emptySales} />);
    expect(screen.getByRole("button", { name: "Синхронизировать с МП" })).toHaveProperty(
      "disabled",
      false,
    );
    expect(screen.queryByText(PRODUCTION_FREEZE)).toBeNull();
    expect(screen.getByText("Продаж нет — нажмите «Синхронизировать с МП»")).toBeTruthy();
  });
});
