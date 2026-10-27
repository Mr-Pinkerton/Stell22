/** @vitest-environment happy-dom */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Material } from "@/types/domain";
import type { PurchaseBatchRow } from "@/lib/batch-stats";
import type { BatchPackageEditor } from "@/server/purchases";
import { BatchFormDialog } from "./batch-form-dialog";

afterEach(() => cleanup());

const material: Material = {
  id: "mat-1",
  name: "Берёза",
  sectionWidthMm: 40,
  sectionHeightMm: 20,
  status: "ACTIVE",
  sortOrder: 0,
};

const batch: PurchaseBatchRow = {
  id: "batch-1",
  name: "Партия",
  materialId: "mat-1",
  sectionWidthMm: 40,
  sectionHeightMm: 20,
  purchaseCost: 10000,
  totalCost: 10000,
  priceSort1: 30000,
  priceSort2: 20000,
  status: "IN_WORK",
  purchaseDate: "2026-10-01",
  stats: { railCount: 10, totalLengthM: 24, volumeM3: 0.1, packageCount: 1 },
};

function rail(
  id: string,
  code: string,
  consumed = 0,
  operationCount = 0,
): BatchPackageEditor["rails"][number] {
  return {
    id,
    mode: "package",
    lengthM: 2.4,
    railType: "POLKA",
    sort: "SORT1",
    quantity: 10,
    rows: 2,
    layers: 5,
    code,
    consumed,
    operationCount,
    activeOperationCount: operationCount,
  };
}

function editor(consumed: number, operationCount: number): BatchPackageEditor {
  return {
    fingerprint: "fp",
    rails: [rail("lot-1", "P-01", consumed, operationCount)],
  };
}

function field(id: string): HTMLInputElement {
  const el = document.getElementById(id);
  if (!(el instanceof HTMLInputElement)) throw new Error(`missing ${id}`);
  return el;
}

describe("batch form numeric input", () => {
  it("submits a new rail from comma, dot, and four-decimal lengths with an integer count", async () => {
    const user = userEvent.setup();
    const onSubmitBatch = vi.fn();
    render(
      <BatchFormDialog
        open
        materials={[material]}
        items={[]}
        onOpenChange={() => {}}
        onSubmitBatch={onSubmitBatch}
      />,
    );

    await user.type(field("batch-name"), "Партия");
    await user.type(field("batch-cost"), "10000");
    await user.type(field("batch-p1"), "0,35");
    await user.type(field("batch-p2"), "0.35");

    await user.type(field("rail-len"), "0,35");
    await user.type(field("rail-qty-pkg"), "4");
    await user.click(screen.getByRole("button", { name: "Добавить" }));

    await user.type(field("rail-len"), "0.35");
    await user.type(field("rail-qty-pkg"), "1");
    await user.click(screen.getByRole("button", { name: "Добавить" }));

    await user.type(field("rail-len"), "2,475");
    await user.type(field("rail-qty-pkg"), "2");
    await user.click(screen.getByRole("button", { name: "Добавить" }));

    await user.type(field("rail-len"), "0,0001");
    await user.type(field("rail-qty-pkg"), "3");
    await user.click(screen.getByRole("button", { name: "Добавить" }));

    await user.click(screen.getByRole("button", { name: "Добавить партию" }));

    expect(onSubmitBatch).toHaveBeenCalledTimes(1);
    const values = onSubmitBatch.mock.calls[0]![0];
    expect(values.purchaseCost).toBe(10000);
    expect(values.priceSort1).toBe(0.35);
    expect(values.priceSort2).toBe(0.35);
    expect(values.rails.map((rail: { lengthM: number; quantity: number }) => [rail.lengthM, rail.quantity])).toEqual([
      [0.35, 4],
      [0.35, 1],
      [2.475, 2],
      [0.0001, 3],
    ]);
  });

  it("does not add a fractional quantity, row, or layer", async () => {
    const user = userEvent.setup();
    render(<BatchFormDialog open materials={[material]} items={[]} onOpenChange={() => {}} />);

    await user.type(field("rail-len"), "2,4");
    await user.type(field("rail-qty-pkg"), "1,5");
    await user.click(screen.getByRole("button", { name: "Добавить" }));
    expect(screen.getByText("Количество — целое число").textContent).toContain("целое");
    expect(screen.queryByText(/\d шт/)).toBeNull();

    await user.clear(field("rail-qty-pkg"));
    await user.type(field("rail-rows"), "1.5");
    await user.type(field("rail-layers"), "2");
    await user.click(screen.getByRole("button", { name: "Добавить" }));
    expect(screen.getByText("Ряды — целое число").textContent).toContain("целое");
    expect(screen.queryByText(/\d шт/)).toBeNull();
  });

  it("keeps an edited package length until blur and does not unlock a used package", async () => {
    const user = userEvent.setup();
    const onSubmitBatch = vi.fn();
    const view = render(
      <BatchFormDialog
        open
        batch={batch}
        materials={[material]}
        items={[]}
        packages={editor(0, 0)}
        onOpenChange={() => {}}
        onSubmitBatch={onSubmitBatch}
      />,
    );

    const length = field("len-lot-1");
    expect(length.value).toBe("2,4");
    await user.clear(length);
    await user.type(length, "0,");
    await user.type(field("batch-edit-reason"), "уточнение");
    await user.click(screen.getByRole("button", { name: "Сохранить партию" }));
    expect(onSubmitBatch).not.toHaveBeenCalled();

    await user.type(length, "35");
    await user.tab();
    await user.click(screen.getByRole("button", { name: "Сохранить партию" }));
    expect(onSubmitBatch).toHaveBeenCalledTimes(1);
    expect(onSubmitBatch.mock.calls[0]![0].rails[0].lengthM).toBe(0.35);
    view.unmount();

    render(
      <BatchFormDialog
        open
        batch={batch}
        materials={[material]}
        items={[]}
        packages={editor(3, 1)}
        onOpenChange={() => {}}
      />,
    );
    expect(field("len-lot-1").disabled).toBe(true);
    expect(field("len-lot-1").value).toBe("2,4");
    const lockedDelete = screen.getByRole("button", { name: "Удаление недоступно" });
    expect((lockedDelete as HTMLButtonElement).disabled).toBe(true);
  });

  it("drops the dirty flag of a removed package and submits the one that remains", async () => {
    const user = userEvent.setup();
    const onSubmitBatch = vi.fn();
    render(
      <BatchFormDialog
        open
        batch={batch}
        materials={[material]}
        items={[]}
        packages={{
          fingerprint: "fp-two",
          rails: [rail("lot-keep", "P-01"), rail("lot-bad", "P-02")],
        }}
        onOpenChange={() => {}}
        onSubmitBatch={onSubmitBatch}
      />,
    );

    await user.type(field("batch-edit-reason"), "убрать пакет");
    const badLength = field("len-lot-bad");
    await user.clear(badLength);
    await user.type(badLength, "1,23456");
    await user.click(screen.getByRole("button", { name: "Сохранить партию" }));
    expect(onSubmitBatch).not.toHaveBeenCalled();

    const deleteButtons = screen.getAllByRole("button", { name: "Удалить" });
    expect(deleteButtons).toHaveLength(2);
    await user.click(deleteButtons[1]!);
    expect(document.getElementById("len-lot-bad")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Сохранить партию" }));
    expect(onSubmitBatch).toHaveBeenCalledTimes(1);
    const values = onSubmitBatch.mock.calls[0]![0];
    expect(values.expectedPackageFingerprint).toBe("fp-two");
    expect(values.editPackages).toBe(true);
    expect(values.packageEditReason).toBe("убрать пакет");
    expect(values.rails.map((row: { id: string; lengthM: number }) => [row.id, row.lengthM])).toEqual([
      ["lot-keep", 2.4],
    ]);
  });
});
