/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Detail, Material, NomenclatureItem, Product } from "@/types/domain";
import { ProductFormDialog } from "./product-form-dialog";

afterEach(() => cleanup());

const material: Material = {
  id: "mat-1",
  name: "Берёза",
  sectionWidthMm: 40,
  sectionHeightMm: 20,
  status: "ACTIVE",
  sortOrder: 0,
};

const shelf: Detail = {
  id: "det-1",
  name: "Полка",
  materialId: "mat-1",
  detailNumber: 1,
  lengthM: 1,
  detailType: "POLKA",
  sort: "SORT1",
  prisadkaTorcevaya: false,
  prisadkaPloskost: false,
  status: "ACTIVE",
};

const side: Detail = {
  ...shelf,
  id: "det-2",
  name: "Боковина",
  detailNumber: 2,
};

const fastener: NomenclatureItem = {
  id: "fast-1",
  name: "Шуруп",
  type: "FASTENER",
  unitPrice: 2,
  status: "ACTIVE",
};

const product: Product = {
  id: "prod-1",
  name: "Полка",
  materialId: "mat-1",
  skuOzon: "OZ-1",
  skuWb: "WB-1",
  sort: "SORT1",
  packagingId: null,
  status: "ACTIVE",
  details: [{ detailId: "det-1", quantity: 1 }],
  fastenerIds: [{ nomenclatureId: "fast-1", quantity: 1 }],
  extraIds: [],
};

const DETAIL_QTY_ERROR = "Количество детали в составе должно быть целым числом не меньше 1";
const FASTENER_QTY_ERROR = "Количество крепежа в составе должно быть целым числом не меньше 1";

function inputById(id: string): HTMLInputElement {
  const el = document.getElementById(id);
  if (!(el instanceof HTMLInputElement)) throw new Error(`missing ${id}`);
  return el;
}

function fastenerQty(): HTMLInputElement {
  const el = document.querySelector('input[id^="fast-qty-"]');
  if (!(el instanceof HTMLInputElement)) throw new Error("missing fastener qty");
  return el;
}

function detailQtyInputs(): HTMLInputElement[] {
  return screen.getAllByRole("spinbutton").filter((el): el is HTMLInputElement => {
    return (
      el instanceof HTMLInputElement &&
      el.id !== "prod-det-qty" &&
      !el.id.startsWith("fast-qty-")
    );
  });
}

function setQty(input: HTMLInputElement, value: string) {
  fireEvent.change(input, { target: { value } });
}

function renderEdit() {
  const onSubmit = vi.fn();
  render(
    <ProductFormDialog
      open
      product={product}
      details={[shelf, side]}
      items={[fastener]}
      materials={[material]}
      onOpenChange={() => {}}
      onSubmit={onSubmit}
    />,
  );
  return onSubmit;
}

async function choose(label: RegExp, option: string) {
  const user = userEvent.setup();
  await user.click(screen.getByLabelText(label));
  await user.click(await screen.findByRole("option", { name: option }));
}

describe("количество уже добавленной детали", () => {
  it.each(["1", "5"])("сохраняет %s и отправляет его числом", async (value) => {
    const user = userEvent.setup();
    const onSubmit = renderEdit();
    const input = detailQtyInputs()[0]!;
    setQty(input, value);
    expect(input.value).toBe(value);
    await user.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        details: [{ detailId: "det-1", quantity: Number(value) }],
        fasteners: [{ nomenclatureId: "fast-1", quantity: 1 }],
      }),
    );
  });

  it.each(["0", "-1", "1.5", ""])("не превращает %j в 1 и не отправляет состав", async (value) => {
    const user = userEvent.setup();
    const onSubmit = renderEdit();
    const input = detailQtyInputs()[0]!;
    setQty(input, value);
    expect(input.value).toBe(value);
    await user.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(DETAIL_QTY_ERROR).textContent).toContain("целым числом");
  });
});

describe("количество крепежа", () => {
  it.each(["1", "5"])("сохраняет %s и отправляет его числом", async (value) => {
    const user = userEvent.setup();
    const onSubmit = renderEdit();
    const input = fastenerQty();
    setQty(input, value);
    expect(input.value).toBe(value);
    await user.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        fasteners: [{ nomenclatureId: "fast-1", quantity: Number(value) }],
      }),
    );
  });

  it.each(["0", "-1", "1.5", ""])("не превращает %j в 1 и не отправляет состав", async (value) => {
    const user = userEvent.setup();
    const onSubmit = renderEdit();
    const input = fastenerQty();
    setQty(input, value);
    expect(input.value).toBe(value);
    await user.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(FASTENER_QTY_ERROR).textContent).toContain("целым числом");
  });
});

describe("добавление детали", () => {
  it.each(["1", "5"])("добавляет строку с количеством %s", async (value) => {
    const user = userEvent.setup();
    const onSubmit = renderEdit();
    await choose(/Выберите деталь/, "№2 · Боковина");
    setQty(inputById("prod-det-qty"), value);
    expect(inputById("prod-det-qty").value).toBe(value);
    await user.click(screen.getByRole("button", { name: "Добавить" }));
    expect(inputById("prod-det-qty").value).toBe("1");
    expect(detailQtyInputs().map((el) => el.value)).toEqual(["1", value]);
    await user.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        details: [
          { detailId: "det-1", quantity: 1 },
          { detailId: "det-2", quantity: Number(value) },
        ],
      }),
    );
  });

  it.each(["0", "-1", "1.5", ""])("не превращает %j в 1 и не добавляет строку", async (value) => {
    const user = userEvent.setup();
    renderEdit();
    await choose(/Выберите деталь/, "№2 · Боковина");
    setQty(inputById("prod-det-qty"), value);
    await user.click(screen.getByRole("button", { name: "Добавить" }));
    expect(inputById("prod-det-qty").value).toBe(value);
    expect(detailQtyInputs().map((el) => el.value)).toEqual(["1"]);
    expect(screen.getByText(DETAIL_QTY_ERROR).textContent).toContain("целым числом");
  });
});

describe("создание изделия", () => {
  it("отправляет введённые количества и оставляет 1 у новой строки крепежа", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <ProductFormDialog
        open
        details={[shelf, side]}
        items={[fastener]}
        materials={[material]}
        onOpenChange={() => {}}
        onSubmit={onSubmit}
      />,
    );

    await user.type(inputById("prod-name"), "Полка");
    await user.type(inputById("prod-sku-ozon"), "OZ-1");
    await user.type(inputById("prod-sku-wb"), "WB-1");
    await choose(/^Сорт/, "Сорт 1");
    await user.click(screen.getByRole("button", { name: "Добавить крепёж" }));
    expect(fastenerQty().value).toBe("1");
    setQty(fastenerQty(), "5");
    await choose(/Выберите деталь/, "№1 · Полка");
    expect(inputById("prod-det-qty").value).toBe("1");
    await user.click(screen.getByRole("button", { name: "Добавить" }));
    await user.click(screen.getByRole("button", { name: "Создать изделие" }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        details: [{ detailId: "det-1", quantity: 1 }],
        fasteners: [{ nomenclatureId: "fast-1", quantity: 5 }],
      }),
    );
  });
});
