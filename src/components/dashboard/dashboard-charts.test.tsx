/** @vitest-environment happy-dom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DashboardChartsRow } from "@/components/dashboard/dashboard-charts";

describe("DashboardChartsRow", () => {
  it("называет график поступлений, а не выручкой", () => {
    render(<DashboardChartsRow production={[]} revenue={[]} expense={[]} waste={[]} />);
    expect(screen.getByText("Поступления vs прошлый месяц")).toBeTruthy();
    expect(screen.queryByText("Выручка vs прошлый месяц")).toBeNull();
  });
});
