/** @vitest-environment happy-dom */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FinanceAccount } from "@/mocks/finance-fixtures";

vi.mock("@/server/finance", () => ({
  createAccount: vi.fn(),
  deleteAccount: vi.fn(),
  setAccountConfirmed: vi.fn(),
  setAccountPrimary: vi.fn(),
  updateAccount: vi.fn(),
}));

import { SettingsAccountsTab } from "@/components/settings/settings-accounts-tab";

afterEach(() => cleanup());

const accounts: FinanceAccount[] = [
  {
    id: "primary",
    name: "Расчётный Альфа",
    balance: 5000,
    openingBalance: 5000,
    openingDate: "2026-09-06",
    balanceMismatch: true,
    confirmed: true,
    isPrimary: true,
  },
  {
    id: "plain",
    name: "Касса",
    balance: 0,
    openingBalance: 0,
    confirmed: false,
    isPrimary: false,
  },
];

describe("account icon actions", () => {
  it("names every icon action and keeps them in tab order", async () => {
    const user = userEvent.setup();
    render(<SettingsAccountsTab accounts={accounts} onAccountsChange={() => {}} />);

    expect(screen.getByRole("button", { name: "Убрать из основных" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Снять подтверждение" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Редактировать" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Удалить" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Сделать основным" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Подтвердить счёт" })).toBeTruthy();
    expect(screen.getByLabelText("Расхождение остатка")).toBeTruthy();

    const alfa = screen.getByText("Расчётный Альфа").closest("tr");
    const primary = alfa?.querySelector("button");
    expect(primary).toBe(screen.getByRole("button", { name: "Убрать из основных" }));
    primary?.focus();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Снять подтверждение" }));
    await user.tab();
    expect(document.activeElement).toBe(alfa?.querySelector('[aria-label="Редактировать"]'));
    await user.tab();
    expect(document.activeElement).toBe(alfa?.querySelector('[aria-label="Удалить"]'));
  });
});
