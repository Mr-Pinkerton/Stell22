/** @vitest-environment happy-dom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FinanceArticlesTab } from "@/components/finance/finance-articles-tab";
import { WarehouseInventoryTab } from "@/components/warehouse/warehouse-inventory-tab";
import type { InventoryDocRow } from "@/mocks/warehouse-fixtures";

vi.mock("@/server/warehouse", () => ({
  conductInventory: vi.fn(),
  createInventoryDraft: vi.fn(),
  deleteInventoryDraft: vi.fn(),
  updateInventoryLineActual: vi.fn(),
}));

afterEach(() => cleanup());

function expectHeaderLine(gap: Element | null) {
  expect(gap).toBeTruthy();
  expect(gap?.className).toContain("h-[16px]");
  expect(gap?.className).toContain("border-b");
  expect(gap?.className).toContain("border-border");
  expect(gap?.textContent).toBe("");
  expect(gap?.closest("[data-slot=card]")?.className).not.toMatch(/\bborder-b\b/);
}

describe("unfiltered page tables", () => {
  it("draws the header line above empty article tables", () => {
    render(<FinanceArticlesTab articles={[]} />);
    const gaps = document.querySelectorAll("[data-slot=table-top-gap]");
    expect(gaps).toHaveLength(2);
    for (const gap of gaps) expectHeaderLine(gap);
    expect(screen.getAllByText("Статей нет")).toHaveLength(2);
    for (const header of document.querySelectorAll("th")) {
      expect(header.className).toContain("h-[49px]");
    }
  });

  it("draws the header line above empty inventory tables", () => {
    const draft: InventoryDocRow = {
      id: "draft-empty",
      date: "2026-11-06",
      status: "DRAFT",
      lines: [],
    };
    render(<WarehouseInventoryTab docs={[draft]} onDocsChange={() => {}} />);
    const gaps = document.querySelectorAll("[data-slot=table-top-gap]");
    expect(gaps).toHaveLength(2);
    for (const gap of gaps) expectHeaderLine(gap);
    expect(screen.getByText("Строк нет")).toBeTruthy();
    expect(screen.getByText("Проведённых инвентаризаций нет")).toBeTruthy();
    for (const header of document.querySelectorAll("th")) {
      expect(header.className).toContain("h-[49px]");
    }
  });
});
