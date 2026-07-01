import { describe, expect, it } from "vitest";
import { mapOzonSupplyGetToRaw, parseOzonSupplyOrderItems } from "@/lib/ozon-api";
import { buildWbNmIdMap, mapWbSupplyStatusFromId } from "@/lib/wb-api";

describe("parseOzonSupplyOrderItems", () => {
  it("собирает товары из products и supplies", () => {
    const items = parseOzonSupplyOrderItems({
      products: [{ offer_id: "A-1", quantity: 2 }],
      supplies: [
        {
          products: [{ offer_id: "A-2", quantity: 3 }],
          bundle: { items: [{ offer_id: "A-3", quantity: 1 }] },
        },
      ],
    });
    expect(items).toEqual([
      { offer_id: "A-1", quantity: 2 },
      { offer_id: "A-2", quantity: 3 },
      { offer_id: "A-3", quantity: 1 },
    ]);
  });
});

describe("mapOzonSupplyGetToRaw", () => {
  it("маппит заявку с составом", () => {
    const raw = mapOzonSupplyGetToRaw({
      supply_order_id: 42,
      status: "shipped",
      created_at: "2026-06-01T10:00:00Z",
      warehouse_name: "Хоругвино",
      products: [{ offer_id: "SKU-1", quantity: 5 }],
    });
    expect(raw).toMatchObject({
      supply_order_id: 42,
      status: "shipped",
      items: [{ offer_id: "SKU-1", quantity: 5 }],
    });
  });

  it("null без id или без товаров", () => {
    expect(mapOzonSupplyGetToRaw({ created_at: "2026-06-01" })).toBeNull();
    expect(
      mapOzonSupplyGetToRaw({ supply_order_id: 1, created_at: "2026-06-01", products: [] }),
    ).toBeNull();
  });

  it("маппит v3 заявку с bundle_id", () => {
    const bundles = new Map([
      ["b1", [{ offer_id: "SKU-1", quantity: 5 }]],
    ]);
    const raw = mapOzonSupplyGetToRaw(
      {
        order_id: 42,
        state: "COMPLETED",
        created_date: "2026-06-01T10:00:00Z",
        drop_off_warehouse: { name: "Хоругвино" },
        supplies: [{ state: "COMPLETED", bundle_id: "b1" }],
      },
      bundles,
    );
    expect(raw).toMatchObject({
      supply_order_id: 42,
      status: "COMPLETED",
      items: [{ offer_id: "SKU-1", quantity: 5 }],
    });
  });
});

describe("mapWbSupplyStatusFromId", () => {
  it("нормализует statusID FBW", () => {
    expect(mapWbSupplyStatusFromId(5)).toBe("ACCEPTED");
    expect(mapWbSupplyStatusFromId(4)).toBe("SHIPPED");
    expect(mapWbSupplyStatusFromId(1)).toBe("PENDING");
  });
});

describe("buildWbNmIdMap", () => {
  it("строит карту nmId → артикул", () => {
    const map = buildWbNmIdMap([
      { nmId: 111, supplierArticle: "ART-1", date: "", saleID: "S1", finishedPrice: 100 },
      { nmId: 222, supplierArticle: "ART-2", date: "", saleID: "S2", finishedPrice: 200 },
      { date: "", supplierArticle: "ART-3", saleID: "S3", finishedPrice: 0 },
    ]);
    expect(map.get(111)).toBe("ART-1");
    expect(map.get(222)).toBe("ART-2");
    expect(map.size).toBe(2);
  });
});
