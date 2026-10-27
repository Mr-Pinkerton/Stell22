/** @vitest-environment happy-dom */
import type { ReactElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Employee, NomenclatureItem } from "@/types/domain";
import type { FinanceAccount } from "@/mocks/finance-fixtures";
import { AccountFormDialog } from "./account-form-dialog";
import { EmployeeFormDialog } from "@/components/employees/employee-form-dialog";
import { NomenclatureItemFormDialog } from "@/components/nomenclature/nomenclature-item-form-dialog";
import { CashflowFormDialog } from "@/components/finance/cashflow-form-dialog";

afterEach(() => cleanup());

function field(id: string): HTMLInputElement {
  const el = document.getElementById(id);
  if (!(el instanceof HTMLInputElement)) throw new Error(`missing ${id}`);
  return el;
}

function plain(value: string): string {
  return value.replace(/[\s\u00a0\u202f]/g, "");
}

const account: FinanceAccount = {
  id: "acc-1",
  name: "Касса",
  balance: 10.35,
  openingBalance: 10.35,
  openingDate: "2026-10-01",
};

const employee: Employee = {
  id: "emp-1",
  fullName: "Иванов",
  pin: "1234",
  status: "ACTIVE",
  hourlyRate: 12.5,
};

const item: NomenclatureItem = {
  id: "nom-1",
  name: "Саморез",
  type: "FASTENER",
  unitPrice: 0.36,
  status: "ACTIVE",
};

function renderOpened(node: (open: boolean) => ReactElement) {
  const view = render(node(false));
  view.rerender(node(true));
  return view;
}

describe("money edit forms keep kopecks", () => {
  it("opens an account with the exact balance and submits it", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderOpened((open) => (
      <AccountFormDialog open={open} account={account} onOpenChange={() => {}} onSubmit={onSubmit} />
    ));
    expect(plain(field("acc-opening").value)).toBe("10,35");
    await user.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ openingBalance: 10.35 }));
  });

  it("does not save an account balance with a third decimal digit", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderOpened((open) => (
      <AccountFormDialog open={open} account={account} onOpenChange={() => {}} onSubmit={onSubmit} />
    ));
    const input = field("acc-opening");
    await user.clear(input);
    await user.type(input, "10,356");
    await user.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(plain(input.value)).toBe("10,356");
  });

  it("opens an employee rate and a unit price as the stored numbers", async () => {
    const user = userEvent.setup();
    const onEmployee = vi.fn();
    const onItem = vi.fn();
    const employees = render(
      <EmployeeFormDialog open employee={employee} onOpenChange={() => {}} onSubmit={onEmployee} />,
    );
    expect(plain(field("emp-hourly").value)).toBe("12,5");
    await user.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(onEmployee).toHaveBeenCalledWith(expect.objectContaining({ hourlyRate: 12.5 }));
    employees.unmount();

    render(
      <NomenclatureItemFormDialog open type="FASTENER" item={item} onOpenChange={() => {}} onSubmit={onItem} />,
    );
    expect(plain(field("nom-price").value)).toBe("0,36");
    await user.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(onItem).toHaveBeenCalledWith(expect.objectContaining({ unitPrice: 0.36 }));
  });

  it("accepts kopecks in a new cash movement", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderOpened((open) => (
      <CashflowFormDialog
        open={open}
        accounts={[{ id: "acc-1", name: "Касса", balance: 0 }]}
        counterparties={[]}
        articles={[]}
        deals={[]}
        onOpenChange={() => {}}
        onSubmit={onSubmit}
      />
    ));
    await user.type(field("cf-amount"), "0,35");
    await user.type(field("cf-description"), "Копейки");
    await user.click(screen.getByRole("button", { name: "Добавить" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ amount: 0.35 }));
  });
});
