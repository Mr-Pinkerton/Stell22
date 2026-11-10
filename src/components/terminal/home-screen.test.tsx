/** @vitest-environment happy-dom */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeScreen } from "@/components/terminal/home-screen";

vi.mock("@/server/terminal", () => ({
  getEmployeeEntries: vi.fn(async () => []),
}));

afterEach(() => cleanup());

const ACTIONS = [
  ["Торцовка", "torcovka"],
  ["Присадка", "prisadka"],
  ["Упаковка", "upakovka"],
  ["Рабочие часы", "hours"],
] as const;

function renderHome(onSelect = vi.fn()) {
  render(
    <HomeScreen
      birthdaysToday={[]}
      employee={{ id: "emp-1", fullName: "Иванов", hourlyRate: null }}
      onSelect={onSelect}
    />,
  );
  return onSelect;
}

describe("домашние действия терминала — кнопки", () => {
  it("четыре действия доступны как кнопки с именами", () => {
    renderHome();
    for (const [name] of ACTIONS) {
      const button = screen.getByRole("button", { name });
      expect(button.tagName).toBe("BUTTON");
      expect(button.getAttribute("type")).toBe("button");
      expect(button.className).toContain("focus-visible:ring-2");
    }
  });

  it("клик и клавиатура вызывают onSelect и не вкладывают кнопку в кнопку", async () => {
    const user = userEvent.setup();
    const onSelect = renderHome();

    await user.click(screen.getByRole("button", { name: "Упаковка" }));
    expect(onSelect).toHaveBeenCalledWith("upakovka");

    const torcovka = screen.getByRole("button", { name: "Торцовка" });
    torcovka.focus();
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith("torcovka");

    const prisadka = screen.getByRole("button", { name: "Присадка" });
    prisadka.focus();
    await user.keyboard(" ");
    expect(onSelect).toHaveBeenCalledWith("prisadka");

    const hours = screen.getByRole("button", { name: "Рабочие часы" });
    hours.focus();
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith("hours");

    for (const [name] of ACTIONS) {
      const button = screen.getByRole("button", { name });
      expect(button.querySelector("button")).toBeNull();
      expect(button.closest("button")).toBe(button);
    }
  });
});
