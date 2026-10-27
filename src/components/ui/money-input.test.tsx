/** @vitest-environment happy-dom */
import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

afterEach(() => cleanup());
import { MoneyInput } from "./money-input";

function plain(value: string): string {
  return value.replace(/[\s\u00a0\u202f]/g, "");
}

function Controlled({ initial = null as number | null, decimals = 2 }: { initial?: number | null; decimals?: number }) {
  const [value, setValue] = useState<number | null>(initial);
  return (
    <>
      <MoneyInput aria-label="сумма" decimals={decimals} value={value} onValueChange={setValue} />
      <output aria-label="значение">{value == null ? "null" : String(value)}</output>
      <button type="button" onClick={() => setValue(12.5)}>
        задать
      </button>
      <button type="button" onClick={() => setValue(null)}>
        сбросить
      </button>
    </>
  );
}

describe("MoneyInput", () => {
  it("keeps the draft while typing through zero and a trailing separator", async () => {
    const user = userEvent.setup();
    render(<Controlled />);
    const input = screen.getByLabelText("сумма");

    await user.type(input, "0");
    expect((input as HTMLInputElement).value).toBe("0");
    expect(screen.getByLabelText("значение").textContent).toBe("0");

    await user.type(input, ",");
    expect((input as HTMLInputElement).value).toBe("0,");
    expect(screen.getByLabelText("значение").textContent).toBe("0");

    await user.type(input, "3");
    expect((input as HTMLInputElement).value).toBe("0,3");
    expect(screen.getByLabelText("значение").textContent).toBe("0.3");

    await user.type(input, "5");
    expect((input as HTMLInputElement).value).toBe("0,35");
    expect(screen.getByLabelText("значение").textContent).toBe("0.35");
  });

  it("accepts a dot, a grouped paste, Backspace, and an empty field", async () => {
    const user = userEvent.setup();
    render(<Controlled />);
    const input = screen.getByLabelText("сумма");

    await user.click(input);
    await user.paste("0.35");
    expect(screen.getByLabelText("значение").textContent).toBe("0.35");
    await user.tab();
    expect(plain((input as HTMLInputElement).value)).toBe("0,35");

    await user.click(input);
    await user.keyboard("{Backspace}");
    expect(plain((input as HTMLInputElement).value)).toBe("0,3");
    expect(screen.getByLabelText("значение").textContent).toBe("0.3");

    await user.clear(input);
    expect((input as HTMLInputElement).value).toBe("");
    expect(screen.getByLabelText("значение").textContent).toBe("null");

    await user.click(input);
    await user.paste("1234,56");
    expect(plain((input as HTMLInputElement).value)).toBe("1234,56");
    expect(screen.getByLabelText("значение").textContent).toBe("1234.56");
  });

  it("replaces a selected value and follows an external controlled update", async () => {
    const user = userEvent.setup();
    render(<Controlled initial={10} />);
    const input = screen.getByLabelText("сумма");
    expect(plain((input as HTMLInputElement).value)).toBe("10");

    await user.clear(input);
    await user.type(input, "0,35");
    expect(screen.getByLabelText("значение").textContent).toBe("0.35");

    await user.click(screen.getByRole("button", { name: "задать" }));
    expect(plain((input as HTMLInputElement).value)).toBe("12,5");
    expect(screen.getByLabelText("значение").textContent).toBe("12.5");
  });

  it("reports extra precision and does not truncate it to a shorter number", async () => {
    const user = userEvent.setup();
    render(<Controlled />);
    const input = screen.getByLabelText("сумма");
    await user.click(input);
    await user.paste("0,369");
    expect(plain((input as HTMLInputElement).value)).toBe("0,369");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("Не больше 2 знаков после запятой").textContent).toContain("2");
    expect(screen.getByLabelText("значение").textContent).toBe("null");
  });

  it("distinguishes an empty draft from numeric zero", async () => {
    const user = userEvent.setup();
    render(<Controlled initial={0} />);
    const input = screen.getByLabelText("сумма");
    expect((input as HTMLInputElement).value).toBe("0");
    expect(screen.getByLabelText("значение").textContent).toBe("0");

    await user.clear(input);
    expect((input as HTMLInputElement).value).toBe("");
    expect(screen.getByLabelText("значение").textContent).toBe("null");
  });

  it("does not turn a fractional integer-money draft into a stripped integer", async () => {
    const user = userEvent.setup();
    render(<Controlled decimals={0} />);
    const input = screen.getByLabelText("сумма");
    await user.click(input);
    await user.paste("1,5");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByLabelText("значение").textContent).toBe("null");
  });
});
