/** @vitest-environment happy-dom */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { ProductsTable } from "@/components/nomenclature/products-table";
import { NestedTable, NestedTableCell } from "@/components/reports/expandable-table";
import { ReportCostTab } from "@/components/reports/report-cost-tab";
import { ReportPurchasesTab } from "@/components/reports/report-purchases-tab";
import type { PurchaseReportRow } from "@/mocks/report-fixtures";
import { TableRow } from "@/components/ui/table";
import type { Product } from "@/types/domain";

afterEach(() => cleanup());

function parts(container: HTMLElement) {
  const table = container.querySelector("table");
  return {
    thead: table?.querySelector("thead")?.textContent ?? "",
    tbody: table?.querySelector("tbody")?.textContent ?? "",
  };
}

const purchaseRow: PurchaseReportRow = {
  id: "b1",
  name: "Партия А",
  purchaseDate: "2026-10-01",
  totalCost: 1000,
  volumeM3: 1,
  sortPurchasePct: { sort1: 50, sort2: 50 },
  sortFactPct: { sort1: 50, sort2: 50 },
  avgCostPerM3: 1000,
  status: "IN_WORK",
  packages: [],
};

const product: Product = {
  id: "p1",
  name: "Полка А",
  materialId: "m1",
  skuOzon: "OZ",
  skuWb: "WB",
  sort: "SORT1",
  status: "ACTIVE",
  details: [],
  fastenerIds: [],
  extraIds: [],
};

describe("empty table headers", () => {
  it("keeps NestedTable headers and puts the empty message in tbody", () => {
    const view = render(
      <NestedTable headers={["Деталь", "Кол-во"]} isEmpty empty="Пусто">
        {null}
      </NestedTable>,
    );
    const { thead, tbody } = parts(view.container);
    expect(thead).toContain("Деталь");
    expect(thead).toContain("Кол-во");
    expect(thead).not.toContain("Пусто");
    expect(tbody).toContain("Пусто");
    expect(screen.getByText("Пусто").closest("td")?.getAttribute("colspan")).toBe("2");
  });

  it("renders NestedTable rows in tbody when data exists", () => {
    const view = render(
      <NestedTable headers={["Деталь", "Кол-во"]}>
        <TableRow>
          <NestedTableCell>Полка</NestedTableCell>
          <NestedTableCell>2</NestedTableCell>
        </TableRow>
      </NestedTable>,
    );
    const { thead, tbody } = parts(view.container);
    expect(thead).toContain("Деталь");
    expect(tbody).toContain("Полка");
    expect(tbody).not.toContain("Пусто");
  });

  it("keeps purchase report headers when there are no batches", () => {
    const view = render(<ReportPurchasesTab initialRows={[]} />);
    const { thead, tbody } = parts(view.container);
    expect(thead).toContain("Партия");
    expect(thead).toContain("Статус");
    expect(tbody).toContain("Партии за период не найдены");
    expect(screen.getByText("Партии за период не найдены").closest("td")?.getAttribute("colspan")).toBe(
      "8",
    );
  });

  it("keeps purchase report rows when batches exist", () => {
    const view = render(<ReportPurchasesTab initialRows={[purchaseRow]} />);
    const { thead, tbody } = parts(view.container);
    expect(thead).toContain("Партия");
    expect(tbody).toContain("Партия А");
    expect(tbody).not.toContain("Партии за период не найдены");
  });

  it("keeps product table headers when the list is empty", () => {
    const view = render(
      <ProductsTable
        rows={[]}
        details={[]}
        items={[]}
        empty="Изделия не найдены"
        renderActions={() => null}
      />,
    );
    const { thead, tbody } = parts(view.container);
    expect(thead).toContain("Название");
    expect(tbody).toContain("Изделия не найдены");
    expect(screen.getByText("Изделия не найдены").closest("td")?.getAttribute("colspan")).toBe("6");
  });

  it("keeps a product row when products exist", () => {
    const view = render(
      <ProductsTable
        rows={[product]}
        details={[]}
        items={[]}
        empty="Изделия не найдены"
        renderActions={() => null}
      />,
    );
    const { thead, tbody } = parts(view.container);
    expect(thead).toContain("Название");
    expect(tbody).toContain("Полка А");
    expect(tbody).not.toContain("Изделия не найдены");
  });

  it("keeps cost product headers when the period has no products", async () => {
    const user = userEvent.setup();
    const view = render(<ReportCostTab details={[]} products={[]} />);
    await user.click(screen.getByRole("tab", { name: "Изделия" }));
    const { thead, tbody } = parts(view.container);
    expect(thead).toContain("Изделие");
    expect(tbody).toContain("Изделия за период не найдены");
  });
});
