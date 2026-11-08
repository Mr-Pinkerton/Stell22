/** @vitest-environment happy-dom */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TableFilterSlot, TableSurface } from "@/components/table-surface";

afterEach(() => cleanup());

describe("table top gap", () => {
  it("adds a 16px white strip above an unfiltered table", () => {
    const { container } = render(
      <TableSurface>
        <table>
          <thead>
            <tr>
              <th>Дата</th>
            </tr>
          </thead>
        </table>
      </TableSurface>,
    );
    const gap = container.querySelector("[data-slot=table-top-gap]");
    expect(gap).toBeTruthy();
    expect(gap?.textContent).toBe("");
    expect(gap?.getAttribute("aria-hidden")).toBe("true");
    expect(gap?.className).toContain("h-[16px]");
    expect(gap?.className).toContain("bg-card");
    expect(gap?.className).toContain("border-b");
    expect(gap?.className).toContain("border-border");
    expect(gap?.className).not.toMatch(/\bborder-t\b|\bborder-x\b|\bborder-2\b/);
    const card = container.querySelector("[data-slot=card]");
    expect(card?.className).not.toMatch(/\bborder-b\b/);
    const content = container.querySelector("[data-slot=card-content]");
    expect(content?.firstElementChild).toBe(gap);
    expect(gap?.nextElementSibling?.tagName).toBe("TABLE");
    const header = container.querySelector("th");
    expect(header?.className).toBe("");
  });

  it("keeps the 1px line above an empty table", () => {
    const { container } = render(
      <TableSurface>
        <table>
          <thead>
            <tr>
              <th className="h-[49px]">Период</th>
            </tr>
          </thead>
          <tbody />
        </table>
      </TableSurface>,
    );
    const gap = container.querySelector("[data-slot=table-top-gap]");
    expect(gap?.className).toContain("h-[16px]");
    expect(gap?.className).toContain("border-b");
    expect(gap?.className).toContain("border-border");
    expect(gap?.textContent).toBe("");
    expect(gap?.nextElementSibling?.querySelector("tbody")?.childElementCount).toBe(0);
    expect(container.querySelector("th")?.className).toBe("h-[49px]");
    expect(container.querySelectorAll("[data-slot=table-top-gap]")).toHaveLength(1);
  });

  it("does not add the strip when filters are present", () => {
    const { container } = render(
      <TableFilterSlot filters={<div>Поиск</div>} />,
    );
    expect(container.querySelector("[data-slot=table-top-gap]")).toBeNull();
    expect(container.textContent).toContain("Поиск");
  });
});
