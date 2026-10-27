/** @vitest-environment happy-dom */
import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Detail, Material } from "@/types/domain";
import { DetailFormDialog } from "./detail-form-dialog";
import { MaterialFormDialog } from "./material-form-dialog";

afterEach(() => cleanup());

const material: Material = {
  id: "mat-1",
  name: "Берёза",
  sectionWidthMm: 40,
  sectionHeightMm: 20,
  status: "ACTIVE",
  sortOrder: 0,
};

const detail: Detail = {
  id: "det-1",
  name: "Полка",
  materialId: "mat-1",
  detailNumber: 12,
  lengthM: 0.72,
  detailType: "POLKA",
  sort: "SORT1",
  prisadkaTorcevaya: true,
  prisadkaPloskost: false,
  status: "ACTIVE",
};

function field(id: string): HTMLInputElement {
  const el = document.getElementById(id);
  if (!(el instanceof HTMLInputElement)) throw new Error(`missing ${id}`);
  return el;
}

function DetailHarness() {
  const [open, setOpen] = useState(true);
  const [saved, setSaved] = useState(detail);
  return (
    <>
      <button type="button" onClick={() => setOpen(false)}>
        закрыть
      </button>
      <button type="button" onClick={() => setOpen(true)}>
        открыть
      </button>
      <DetailFormDialog
        open={open}
        detail={saved}
        materials={[material]}
        onOpenChange={setOpen}
        onSubmit={async (values) => {
          if (values.detailNumber == null || values.lengthM == null) return;
          setSaved({
            ...saved,
            name: values.name,
            materialId: values.materialId,
            detailNumber: values.detailNumber,
            lengthM: values.lengthM,
            detailType: values.detailType,
            sort: values.sort,
            prisadkaTorcevaya: values.prisadkaTorcevaya,
            prisadkaPloskost: values.prisadkaPloskost,
          });
          setOpen(false);
        }}
      />
    </>
  );
}

describe("detail length input", () => {
  it("submits 0.72 from a dot and a comma, then shows that length again", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const view = render(
      <DetailFormDialog open materials={[material]} onOpenChange={() => {}} onSubmit={onSubmit} />,
    );

    await user.type(field("det-name"), "Полка");
    await user.type(field("det-number"), "12");
    await user.click(field("det-length"));
    await user.paste("0.72");
    expect(field("det-length").value).toBe("0.72");
    await user.click(screen.getByRole("button", { name: "Создать деталь" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ lengthM: 0.72, detailNumber: 12 }));
    view.unmount();

    render(<DetailHarness />);
    expect(field("det-length").value).toBe("0,72");
    const length = field("det-length");
    await user.clear(length);
    await user.type(length, "0,72");
    await user.click(screen.getByRole("button", { name: "Сохранить" }));
    await user.click(screen.getByRole("button", { name: "открыть" }));
    expect(field("det-length").value).toBe("0,72");
  });

  it("does not submit a length with more than 4 decimal places", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<DetailFormDialog open materials={[material]} onOpenChange={() => {}} onSubmit={onSubmit} />);
    await user.type(field("det-name"), "Полка");
    await user.type(field("det-number"), "12");
    await user.type(field("det-length"), "1,23456");
    expect(screen.getByText("Не больше 4 знаков после запятой").textContent).toContain("4");
    await user.click(screen.getByRole("button", { name: "Создать деталь" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("material section input", () => {
  it("submits 40.5 from a comma and a dot", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<MaterialFormDialog open onOpenChange={() => {}} onSubmit={onSubmit} />);
    await user.type(field("mat-name"), "Берёза");
    await user.type(field("mat-sw"), "40,5");
    await user.type(field("mat-sh"), "40.5");
    await user.click(screen.getByRole("button", { name: "Создать материал" }));
    expect(onSubmit).toHaveBeenCalledWith({ name: "Берёза", sectionWidthMm: 40.5, sectionHeightMm: 40.5 });
  });

  it("does not submit a section with more than 2 decimal places", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<MaterialFormDialog open onOpenChange={() => {}} onSubmit={onSubmit} />);
    await user.type(field("mat-name"), "берёза");
    await user.type(field("mat-sw"), "40,555");
    await user.type(field("mat-sh"), "20");
    expect(screen.getByText("Не больше 2 знаков после запятой").textContent).toContain("2");
    await user.click(screen.getByRole("button", { name: "Создать материал" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
