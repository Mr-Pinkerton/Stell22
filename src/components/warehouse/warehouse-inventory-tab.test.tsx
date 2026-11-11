/** @vitest-environment happy-dom */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InventoryDocRow } from "@/mocks/warehouse-fixtures";

const updateInventoryLineActual = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@/server/warehouse", () => ({
  updateInventoryLineActual,
  conductInventory: vi.fn(),
  createInventoryDraft: vi.fn(),
  deleteInventoryDraft: vi.fn(),
}));

import { WarehouseInventoryTab } from "@/components/warehouse/warehouse-inventory-tab";

const draft: InventoryDocRow = {
  id: "inv-1",
  date: "2026-11-11",
  status: "DRAFT",
  lines: [
    {
      id: "line-1",
      refType: "PRODUCT",
      refId: "prod-1",
      name: "Полка",
      accountedQty: 4,
      actualQty: 4,
      unitCost: 10,
      deviation: 0,
      deviationSum: 0,
    },
  ],
};

beforeEach(() => {
  updateInventoryLineActual.mockClear();
});

describe("поле факта инвентаризации", () => {
  it("отправляет целое количество и не отправляет дробное", () => {
    render(<WarehouseInventoryTab docs={[draft]} onDocsChange={() => {}} />);
    const input = screen.getByRole("spinbutton");

    fireEvent.change(input, { target: { value: "1.5" } });
    expect(updateInventoryLineActual).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "1" } });
    expect(updateInventoryLineActual).toHaveBeenCalledWith("line-1", 1);

    fireEvent.change(input, { target: { value: "0" } });
    expect(updateInventoryLineActual).toHaveBeenCalledWith("line-1", 0);
  });
});
