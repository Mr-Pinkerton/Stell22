/** @vitest-environment happy-dom */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { DateFilter, calendarTodayRingClass } from "@/components/date-filter";
import { dayKeyInProjectTz } from "@/lib/format";

afterEach(() => cleanup());

function todayDayNumber(): string {
  return String(Number(dayKeyInProjectTz(new Date()).slice(8)));
}

async function openCalendar() {
  const user = userEvent.setup();
  render(<DateFilter label="Период" />);
  await user.click(screen.getByRole("button", { name: "Период" }));
  return user;
}

describe("DateFilter today outline", () => {
  it("выделяет сегодня в текущем месяце и не выбирает его", async () => {
    await openCalendar();
    const today = screen.getByRole("button", { current: "date" });
    expect(today.textContent).toBe(todayDayNumber());
    expect(today.className).toContain("ring-2");
    expect(today.className).toContain("ring-[#F97316]");
    expect(today.className).toContain(calendarTodayRingClass);
    expect(today.className).not.toContain("text-primary-foreground");
    expect(screen.getAllByRole("button", { current: "date" })).toHaveLength(1);
  });

  it("в месяце без сегодняшнего числа контура нет", async () => {
    const user = await openCalendar();
    await user.click(screen.getByRole("button", { name: "Следующий месяц" }));
    await user.click(screen.getByRole("button", { name: "Следующий месяц" }));
    expect(screen.queryByRole("button", { current: "date" })).toBeNull();
  });

  it("сохраняет заливку, если сегодня — граница диапазона", async () => {
    const user = await openCalendar();
    const day = Number(todayDayNumber());
    const other = day === 10 ? 11 : 10;
    await user.click(screen.getByRole("button", { name: String(other) }));
    await user.click(screen.getByRole("button", { name: String(day), current: "date" }));
    const today = screen.getByRole("button", { current: "date" });
    expect(today.className).toContain("text-primary-foreground");
    expect(today.className).toContain("ring-[#F97316]");
  });

  it("сохраняет заливку диапазона, если сегодня внутри него", async () => {
    const user = await openCalendar();
    const day = Number(todayDayNumber());
    if (day > 10) {
      await user.click(screen.getByRole("button", { name: "10" }));
      await user.click(screen.getByRole("button", { name: "Следующий месяц" }));
      await user.click(screen.getByRole("button", { name: "15" }));
      await user.click(screen.getByRole("button", { name: "Предыдущий месяц" }));
    } else {
      await user.click(screen.getByRole("button", { name: "Предыдущий месяц" }));
      await user.click(screen.getByRole("button", { name: "20" }));
      await user.click(screen.getByRole("button", { name: "Следующий месяц" }));
      await user.click(screen.getByRole("button", { name: "15" }));
    }
    const today = screen.getByRole("button", { current: "date" });
    expect(today.className).toContain("bg-primary/10");
    expect(today.className).not.toContain("text-primary-foreground");
    expect(today.className).toContain("ring-[#F97316]");
  });

  it("сегодня как единственный выбранный день сохраняет заливку и контур", async () => {
    const user = await openCalendar();
    const today = screen.getByRole("button", { current: "date" });
    await user.click(today);
    await user.click(screen.getByRole("button", { current: "date" }));
    const selected = screen.getByRole("button", { current: "date" });
    expect(selected.className).toContain("text-primary-foreground");
    expect(selected.className).toContain("ring-2");
    expect(selected.className).toContain("ring-[#F97316]");
  });

  it("контур один и тот же в светлой и тёмной теме", async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <div className="light">
        <DateFilter label="Период" />
      </div>,
    );
    await user.click(screen.getByRole("button", { name: "Период" }));
    const light = screen.getByRole("button", { current: "date" }).className;
    unmount();

    render(
      <div className="dark">
        <DateFilter label="Период" />
      </div>,
    );
    await user.click(screen.getByRole("button", { name: "Период" }));
    const dark = screen.getByRole("button", { current: "date" }).className;
    expect(light).toContain("ring-[#F97316]");
    expect(dark).toContain("ring-[#F97316]");
    expect(light).not.toMatch(/dark:ring-/);
    expect(dark).not.toMatch(/dark:ring-/);
  });
});
