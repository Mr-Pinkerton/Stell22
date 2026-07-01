import { describe, expect, it } from "vitest";
import {
  mapWbSale,
  mapWbIncome,
  mapWbStock,
  mapOzonPosting,
  mapOzonSupplyOrder,
  mapOzonSupplyStatus,
  mapOzonStock,
} from "@/lib/marketplace-map";

describe("mapWbSale", () => {
  it("продажа: положительные кол-во и выручка, externalId = saleID", () => {
    const s = mapWbSale({
      date: "2026-06-20T10:00:00",
      supplierArticle: "ART-001",
      saleID: "S9993700024",
      finishedPrice: 1145,
    });
    expect(s).toMatchObject({
      marketplace: "WB",
      externalId: "S9993700024",
      sku: "ART-001",
      quantity: 1,
      revenue: 1145,
      isReturn: false,
    });
    expect(s.date.toISOString().startsWith("2026-06-20")).toBe(true);
  });

  it("возврат (R…): отрицательные кол-во и выручка", () => {
    const s = mapWbSale({
      date: "2026-06-21T10:00:00",
      supplierArticle: "ART-002",
      saleID: "R123",
      finishedPrice: 500,
    });
    expect(s.isReturn).toBe(true);
    expect(s.quantity).toBe(-1);
    expect(s.revenue).toBe(-500);
  });

  it("падает обратно на priceWithDisc, если finishedPrice = 0 (асинхронное заполнение)", () => {
    const s = mapWbSale({
      date: "2026-06-21",
      supplierArticle: "ART-003",
      saleID: "S1",
      finishedPrice: 0,
      priceWithDisc: 799,
    });
    expect(s.revenue).toBe(799);
  });
});

describe("mapOzonPosting", () => {
  it("раскладывает отправление по товарам, externalId = posting:offer", () => {
    const rows = mapOzonPosting({
      posting_number: "12345-0001-1",
      status: "delivered",
      created_at: "2026-06-19T08:00:00Z",
      products: [
        { offer_id: "ART-001", quantity: 2, price: "1200.00" },
        { offer_id: "ART-002", quantity: 1, price: "900.50" },
      ],
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      marketplace: "OZON",
      externalId: "12345-0001-1:ART-001",
      sku: "ART-001",
      quantity: 2,
      revenue: 2400,
      isReturn: false,
    });
    expect(rows[1].revenue).toBeCloseTo(900.5, 2);
  });

  it("отменённое/возврат — отрицательные кол-во и выручка", () => {
    const rows = mapOzonPosting({
      posting_number: "p2",
      status: "cancelled",
      created_at: "2026-06-19T08:00:00Z",
      products: [{ offer_id: "ART-001", quantity: 3, price: "100" }],
    });
    expect(rows[0].isReturn).toBe(true);
    expect(rows[0].quantity).toBe(-3);
    expect(rows[0].revenue).toBe(-300);
  });
});

describe("поставки", () => {
  it("mapWbIncome: dateClose → ACCEPTED, без него → SHIPPED", () => {
    const accepted = mapWbIncome({
      incomeId: 111,
      number: "INC-1",
      date: "2026-06-01",
      dateClose: "2026-06-03",
      supplierArticle: "ART-001",
      quantity: 30,
      warehouseName: "Коледино",
    });
    expect(accepted).toMatchObject({
      marketplace: "WB",
      externalId: "111",
      number: "INC-1",
      sku: "ART-001",
      quantity: 30,
      status: "ACCEPTED",
      warehouseName: "Коледино",
    });
    expect(accepted.acceptedAt).not.toBeNull();

    const inTransit = mapWbIncome({
      incomeId: 112,
      number: "INC-2",
      date: "2026-06-05",
      dateClose: null,
      supplierArticle: "ART-002",
      quantity: 10,
    });
    expect(inTransit.status).toBe("SHIPPED");
    expect(inTransit.acceptedAt).toBeNull();
  });

  it("mapOzonSupplyStatus нормализует статусы", () => {
    expect(mapOzonSupplyStatus("delivered")).toBe("ACCEPTED");
    expect(mapOzonSupplyStatus("shipped")).toBe("SHIPPED");
    expect(mapOzonSupplyStatus("confirmed")).toBe("SHIPPED");
    expect(mapOzonSupplyStatus("created")).toBe("PENDING");
    expect(mapOzonSupplyStatus("cancelled")).toBe("PENDING");
  });

  it("mapOzonSupplyOrder раскладывает заявку по SKU", () => {
    const rows = mapOzonSupplyOrder({
      supply_order_id: 555,
      status: "confirmed",
      created_at: "2026-06-10T00:00:00Z",
      warehouse_name: "Хоругвино",
      items: [
        { offer_id: "ART-001", quantity: 40 },
        { offer_id: "ART-002", quantity: 15 },
      ],
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      marketplace: "OZON",
      externalId: "555",
      number: "555",
      sku: "ART-001",
      quantity: 40,
      status: "SHIPPED",
    });
    expect(rows[0].acceptedAt).toBeNull();
  });
});

describe("остатки", () => {
  it("mapWbStock: inWayToClient → inWay, inWayFromClient → reserved", () => {
    expect(
      mapWbStock({ supplierArticle: "ART-001", quantity: 33, inWayToClient: 1, inWayFromClient: 2 }),
    ).toEqual({ marketplace: "WB", sku: "ART-001", quantity: 33, reserved: 2, inWay: 1 });
  });

  it("mapOzonStock: present → quantity, reserved", () => {
    expect(mapOzonStock({ offer_id: "ART-002", present: 12, reserved: 3 })).toEqual({
      marketplace: "OZON",
      sku: "ART-002",
      quantity: 12,
      reserved: 3,
      inWay: 0,
    });
  });
});
