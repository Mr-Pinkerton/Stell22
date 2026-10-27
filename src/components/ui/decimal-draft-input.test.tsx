/** @vitest-environment happy-dom */
import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { DecimalDraftInput, MeasuredCommitInput } from "./decimal-draft-input";

afterEach(() => cleanup());

function LengthDraft() {
  const [text, setText] = useState("");
  const [value, setValue] = useState<number | null>(null);
  return (
    <>
      <DecimalDraftInput
        aria-label="длина"
        scale={4}
        value={text}
        onDraftChange={(draft) => {
          setText(draft.text);
          setValue(draft.complete && draft.error == null ? draft.value : null);
        }}
      />
      <output aria-label="значение">{value == null ? "null" : String(value)}</output>
    </>
  );
}

function CommitHarness({ initial = 2.4, disabled = false }: { initial?: number; disabled?: boolean }) {
  const [saved, setSaved] = useState(initial);
  const [dirty, setDirty] = useState(false);
  return (
    <>
      <MeasuredCommitInput
        aria-label="длина пакета"
        scale={4}
        disabled={disabled}
        value={saved}
        onCommit={setSaved}
        onUncommittedChange={setDirty}
      />
      <output aria-label="сохранено">{String(saved)}</output>
      <output aria-label="черновик">{dirty ? "dirty" : "clean"}</output>
    </>
  );
}

function textbox(name: string): HTMLInputElement {
  const el = screen.getByRole("textbox", { name });
  if (!(el instanceof HTMLInputElement)) throw new Error(name);
  return el;
}

describe("decimal draft input", () => {
  it("keeps a pasted dot and does not drop it into an integer", async () => {
    const user = userEvent.setup();
    render(<LengthDraft />);
    const input = textbox("длина");
    await user.click(input);
    await user.paste("0.72");
    expect(input.value).toBe("0.72");
    expect(screen.getByLabelText("значение").textContent).toBe("0.72");
  });

  it("keeps a comma draft, including an unfinished separator", async () => {
    const user = userEvent.setup();
    render(<LengthDraft />);
    const input = textbox("длина");
    await user.type(input, "0,");
    expect(input.value).toBe("0,");
    expect(screen.getByLabelText("значение").textContent).toBe("null");
    await user.type(input, "72");
    expect(input.value).toBe("0,72");
    expect(screen.getByLabelText("значение").textContent).toBe("0.72");
  });
});

describe("MeasuredCommitInput", () => {
  it("does not change the saved number on each key and commits a valid blur", async () => {
    const user = userEvent.setup();
    render(<CommitHarness />);
    const input = textbox("длина пакета");
    expect(input.value).toBe("2,4");

    await user.clear(input);
    await user.type(input, "0,35");
    expect(screen.getByLabelText("сохранено").textContent).toBe("2.4");
    expect(screen.getByLabelText("черновик").textContent).toBe("dirty");

    await user.tab();
    expect(screen.getByLabelText("сохранено").textContent).toBe("0.35");
    expect(input.value).toBe("0,35");
    expect(screen.getByLabelText("черновик").textContent).toBe("clean");
  });

  it("keeps the saved number when blur is invalid, including an emptied field", async () => {
    const user = userEvent.setup();
    render(<CommitHarness />);
    const input = textbox("длина пакета");
    await user.clear(input);
    await user.type(input, "1,23456");
    await user.tab();
    expect(screen.getByLabelText("сохранено").textContent).toBe("2.4");
    expect(screen.getByLabelText("черновик").textContent).toBe("dirty");
    expect(input.getAttribute("aria-invalid")).toBe("true");

    await user.clear(input);
    expect(screen.getByLabelText("черновик").textContent).toBe("dirty");
    expect(screen.getByLabelText("сохранено").textContent).toBe("2.4");
  });

  it("replaces the whole value and supports Backspace before commit", async () => {
    const user = userEvent.setup();
    render(<CommitHarness initial={1} />);
    const input = textbox("длина пакета");
    await user.clear(input);
    await user.type(input, "2,475");
    await user.keyboard("{Backspace}");
    expect(input.value).toBe("2,47");
    expect(screen.getByLabelText("сохранено").textContent).toBe("1");
    await user.tab();
    expect(screen.getByLabelText("сохранено").textContent).toBe("2.47");
  });

  it("does not edit a locked package length", () => {
    render(<CommitHarness disabled />);
    const input = textbox("длина пакета");
    expect(input.disabled).toBe(true);
    expect(input.value).toBe("2,4");
    expect(screen.getByLabelText("сохранено").textContent).toBe("2.4");
  });
});
