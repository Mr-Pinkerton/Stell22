/** @vitest-environment happy-dom */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { WarehouseProductionTab } from "@/components/warehouse/warehouse-production-tab";
import type { WarehouseStock } from "@/server/warehouse";

const stock: WarehouseStock = {
  products: [],
  blanks: [{ id: "pool-1", name: "Сосна · 0.6 м · полка · 1 сорт", quantity: 10 }],
  details: [
    { id: "ready", name: "Полка готовая", quantity: 3, ready: 3, pendingPrisadka: 0 },
    { id: "partial", name: "Полка в работе", quantity: 4, ready: 0, pendingPrisadka: 4 },
  ],
  fasteners: [],
  packaging: [],
  other: [],
};

describe("WarehouseProductionTab", () => {
  it("показывает общий пул заготовок один раз и физические остатки деталей", async () => {
    const user = userEvent.setup();
    render(<WarehouseProductionTab stock={stock} />);

    await user.click(screen.getByRole("tab", { name: "Заготовки" }));
    expect(screen.getByText("Сосна · 0.6 м · полка · 1 сорт")).toBeTruthy();
    expect(screen.getByText("10")).toBeTruthy();
    expect(screen.queryByText("20")).toBeNull();

    await user.click(screen.getByRole("tab", { name: "Детали" }));
    expect(screen.getAllByText("3").length).toBeGreaterThan(0);
    expect(screen.getAllByText("4").length).toBeGreaterThan(0);
    expect(screen.queryByText("10")).toBeNull();
    expect(screen.queryByText("20")).toBeNull();
  });
});
