import { describe, expect, it } from "vitest";
import {
  filterMpStockRows,
  filterShipmentRows,
  filterWarehouseProductionStock,
  getDefaultMpTableFilters,
  getDefaultShipmentTableFilters,
  isMpExtraFiltersDefault,
  isShipmentExtraFiltersDefault,
  WAREHOUSE_FILTER_ALL,
} from "@/lib/warehouse-table-filters";
import type { MpStockRow, ShipmentRow } from "@/mocks/warehouse-fixtures";
import type { DetailStockRow, ProductionStockRow } from "@/lib/warehouse-stock";

const mp: MpStockRow[] = [
  { id: "1", marketplace: "OZON", sku: "ART-001", productName: "Полка настенная", quantity: 28 },
  { id: "2", marketplace: "OZON", sku: "ART-002", productName: "Полка угловая", quantity: 12 },
  { id: "3", marketplace: "WB", sku: "ART-001", productName: "Полка настенная", quantity: 15 },
  { id: "4", marketplace: "WB", sku: "XYZ-9", productName: "Ящик", quantity: 0 },
];

const shipments: ShipmentRow[] = [
  {
    id: "s1",
    date: "2026-06-01",
    marketplace: "OZON",
    sku: "ART-001",
    productName: "Полка настенная",
    quantity: 10,
    status: "PENDING",
  },
  {
    id: "s2",
    date: "2026-06-02",
    marketplace: "OZON",
    sku: "ART-002",
    productName: "Полка угловая",
    quantity: 4,
    status: "SHIPPED",
  },
  {
    id: "s3",
    date: "2026-06-03",
    marketplace: "WB",
    sku: "ART-001",
    productName: "Полка настенная",
    quantity: 8,
    status: "ACCEPTED",
  },
  {
    id: "s4",
    date: "2026-06-04",
    marketplace: "WB",
    sku: "XYZ-9",
    productName: "Ящик",
    quantity: 2,
    status: "SHIPPED",
  },
];

describe("filterMpStockRows", () => {
  it("empty search + ALL → все", () => {
    expect(filterMpStockRows(mp, getDefaultMpTableFilters())).toEqual(mp);
  });

  it("search SKU", () => {
    expect(filterMpStockRows(mp, { ...getDefaultMpTableFilters(), search: "ART-002" }).map((r) => r.id)).toEqual([
      "2",
    ]);
  });

  it("search productName", () => {
    expect(filterMpStockRows(mp, { ...getDefaultMpTableFilters(), search: "угловая" }).map((r) => r.id)).toEqual([
      "2",
    ]);
  });

  it("case-insensitive", () => {
    expect(filterMpStockRows(mp, { ...getDefaultMpTableFilters(), search: "art-001" }).map((r) => r.id)).toEqual([
      "1",
      "3",
    ]);
  });

  it("whitespace trim", () => {
    expect(filterMpStockRows(mp, { ...getDefaultMpTableFilters(), search: "  Ящик  " }).map((r) => r.id)).toEqual([
      "4",
    ]);
  });

  it("marketplace OZON", () => {
    expect(
      filterMpStockRows(mp, { ...getDefaultMpTableFilters(), marketplace: "OZON" }).every((r) => r.marketplace === "OZON"),
    ).toBe(true);
  });

  it("marketplace WB", () => {
    expect(
      filterMpStockRows(mp, { ...getDefaultMpTableFilters(), marketplace: "WB" }).map((r) => r.id),
    ).toEqual(["3", "4"]);
  });

  it("search + marketplace = AND", () => {
    expect(
      filterMpStockRows(mp, { search: "ART-001", marketplace: "WB" }).map((r) => r.id),
    ).toEqual(["3"]);
  });

  it("nullable sku / productName не падают", () => {
    const rows: MpStockRow[] = [
      { id: "n", marketplace: "OZON", sku: null as unknown as string, productName: null as unknown as string, quantity: 1 },
    ];
    expect(() => filterMpStockRows(rows, { search: "полка", marketplace: WAREHOUSE_FILTER_ALL })).not.toThrow();
    expect(filterMpStockRows(rows, { search: "полка", marketplace: WAREHOUSE_FILTER_ALL })).toEqual([]);
  });
});

describe("filterShipmentRows", () => {
  it("ALL/ALL + empty search → все", () => {
    expect(filterShipmentRows(shipments, getDefaultShipmentTableFilters())).toEqual(shipments);
  });

  it("search SKU", () => {
    expect(filterShipmentRows(shipments, { ...getDefaultShipmentTableFilters(), search: "XYZ-9" }).map((r) => r.id)).toEqual([
      "s4",
    ]);
  });

  it("search productName", () => {
    expect(
      filterShipmentRows(shipments, { ...getDefaultShipmentTableFilters(), search: "угловая" }).map((r) => r.id),
    ).toEqual(["s2"]);
  });

  it("marketplace", () => {
    expect(
      filterShipmentRows(shipments, { ...getDefaultShipmentTableFilters(), marketplace: "OZON" }).map((r) => r.id),
    ).toEqual(["s1", "s2"]);
  });

  it("каждый status", () => {
    expect(
      filterShipmentRows(shipments, { ...getDefaultShipmentTableFilters(), status: "PENDING" }).map((r) => r.id),
    ).toEqual(["s1"]);
    expect(
      filterShipmentRows(shipments, { ...getDefaultShipmentTableFilters(), status: "SHIPPED" }).map((r) => r.id),
    ).toEqual(["s2", "s4"]);
    expect(
      filterShipmentRows(shipments, { ...getDefaultShipmentTableFilters(), status: "ACCEPTED" }).map((r) => r.id),
    ).toEqual(["s3"]);
  });

  it("marketplace + status", () => {
    expect(
      filterShipmentRows(shipments, {
        ...getDefaultShipmentTableFilters(),
        marketplace: "WB",
        status: "SHIPPED",
      }).map((r) => r.id),
    ).toEqual(["s4"]);
  });

  it("search + marketplace + status = AND", () => {
    expect(
      filterShipmentRows(shipments, {
        search: "полка",
        marketplace: "OZON",
        status: "PENDING",
      }).map((r) => r.id),
    ).toEqual(["s1"]);
  });
});

describe("warehouse extra filter defaults", () => {
  it("MP dirty только при marketplace != ALL", () => {
    expect(isMpExtraFiltersDefault(getDefaultMpTableFilters())).toBe(true);
    expect(isMpExtraFiltersDefault({ search: "ART", marketplace: WAREHOUSE_FILTER_ALL })).toBe(true);
    expect(isMpExtraFiltersDefault({ search: "", marketplace: "WB" })).toBe(false);
  });

  it("shipment dirty при marketplace или status != ALL; Reset extra → default", () => {
    expect(isShipmentExtraFiltersDefault(getDefaultShipmentTableFilters())).toBe(true);
    expect(
      isShipmentExtraFiltersDefault({ ...getDefaultShipmentTableFilters(), marketplace: "OZON" }),
    ).toBe(false);
    expect(
      isShipmentExtraFiltersDefault({ ...getDefaultShipmentTableFilters(), status: "SHIPPED" }),
    ).toBe(false);
    expect(isShipmentExtraFiltersDefault(getDefaultShipmentTableFilters())).toBe(true);
  });
});

function item(id: string, name: string, extra: Partial<ProductionStockRow> = {}): ProductionStockRow {
  return { id, name, quantity: 1, ...extra };
}

function detail(id: string, name: string): DetailStockRow {
  return { id, name, quantity: 2, ready: 1, pendingPrisadka: 1 };
}

const productionStock = {
  products: [
    item("p1", "Полка настенная", { sku: "ART-001" }),
    item("p2", "Ящик", { sku: "BOX-2" }),
  ],
  details: [detail("d1", "Полка 600"), detail("d2", "Канавка 720")],
  fasteners: [item("f1", "Саморез 4x40"), item("f2", "Винт М6")],
  packaging: [item("k1", "Коробка стандарт"), item("k2", "Плёнка")],
  other: [item("o1", "Перчатки"), item("o2", "Маркер")],
  blanks: [item("b1", "Сосна · 2.4 м · полка · 1 сорт")],
};

describe("filterWarehouseProductionStock", () => {
  it("products: name, SKU, case-insensitive, trim", () => {
    expect(filterWarehouseProductionStock(productionStock, "настенная").products.map((r) => r.id)).toEqual(["p1"]);
    expect(filterWarehouseProductionStock(productionStock, "art-001").products.map((r) => r.id)).toEqual(["p1"]);
    expect(filterWarehouseProductionStock(productionStock, "  ЯЩИК  ").products.map((r) => r.id)).toEqual(["p2"]);
  });

  it("details: name", () => {
    expect(filterWarehouseProductionStock(productionStock, "канавка").details.map((r) => r.id)).toEqual(["d2"]);
  });

  it("fasteners: name", () => {
    expect(filterWarehouseProductionStock(productionStock, "винт").fasteners.map((r) => r.id)).toEqual(["f2"]);
  });

  it("packaging: name", () => {
    expect(filterWarehouseProductionStock(productionStock, "коробка").packaging.map((r) => r.id)).toEqual(["k1"]);
  });

  it("other: name", () => {
    expect(filterWarehouseProductionStock(productionStock, "перчат").other.map((r) => r.id)).toEqual(["o1"]);
  });

  it("search применяется ко всем пяти visible collections", () => {
    const next = filterWarehouseProductionStock(productionStock, "полка");
    expect(next.products.map((r) => r.id)).toEqual(["p1"]);
    expect(next.details.map((r) => r.id)).toEqual(["d1"]);
    expect(next.fasteners).toEqual([]);
    expect(next.packaging).toEqual([]);
    expect(next.other).toEqual([]);
    // blanks name contains «полка», but UI/export do not show blanks — same array ref
    expect(next.blanks).toBe(productionStock.blanks);
  });

  it("пустой search возвращает те же строки; source не мутируется; blanks без изменений", () => {
    const snapshot = {
      products: productionStock.products.map((r) => r.id),
      details: productionStock.details.map((r) => r.id),
      fasteners: productionStock.fasteners.map((r) => r.id),
      packaging: productionStock.packaging.map((r) => r.id),
      other: productionStock.other.map((r) => r.id),
      blanks: productionStock.blanks.map((r) => r.id),
    };
    const next = filterWarehouseProductionStock(productionStock, "   ");
    expect(next.products.map((r) => r.id)).toEqual(snapshot.products);
    expect(next.details.map((r) => r.id)).toEqual(snapshot.details);
    expect(next.fasteners.map((r) => r.id)).toEqual(snapshot.fasteners);
    expect(next.packaging.map((r) => r.id)).toEqual(snapshot.packaging);
    expect(next.other.map((r) => r.id)).toEqual(snapshot.other);
    expect(next.blanks).toBe(productionStock.blanks);

    next.products.push(item("p-mut", "X"));
    expect(productionStock.products.map((r) => r.id)).toEqual(snapshot.products);
  });
});
