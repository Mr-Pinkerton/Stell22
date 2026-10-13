import { describe, expect, it } from "vitest";
import {
  terminalAppShellClass,
  terminalConfirmBarClass,
  terminalDialogContentClass,
  terminalDialogScrollBodyClass,
  terminalDialogShellClass,
  terminalOperationBodyClass,
  terminalOperationScreenClass,
  terminalStickyOperationClass,
} from "@/lib/scroll-classes";

describe("terminal dialog scroll classes", () => {
  it("keeps overflow-y-auto off the transformed DialogContent shell", () => {
    expect(terminalDialogShellClass).toContain("overflow-hidden");
    expect(terminalDialogShellClass).toContain("max-h-[min(90vh,40rem)]");
    expect(terminalDialogShellClass).toContain("min-h-0");
    expect(terminalDialogShellClass).toMatch(/\bflex\b/);
    expect(terminalDialogShellClass).not.toMatch(/overflow-y-auto/);
    expect(terminalDialogShellClass).not.toMatch(/overflow-y-scroll/);
  });

  it("puts native vertical pan on the inner scroll body", () => {
    expect(terminalDialogScrollBodyClass).toContain("overflow-y-auto");
    expect(terminalDialogScrollBodyClass).toContain("min-h-0");
    expect(terminalDialogScrollBodyClass).toContain("touch-pan-y");
    expect(terminalDialogScrollBodyClass).toContain("overscroll-contain");
    expect(terminalDialogScrollBodyClass).toContain("scrollbar-touch-y");
  });

  it("keeps short dialogs at the shared 32rem width without a scroll shell", () => {
    expect(terminalDialogContentClass).toContain("sm:max-w-[32rem]");
    expect(terminalDialogContentClass).not.toMatch(/overflow-y-auto/);
    expect(terminalDialogContentClass).not.toMatch(/max-h-/);
  });
});

describe("terminal operation layout classes", () => {
  it("bounds the app shell to the viewport so operation footers can dock", () => {
    expect(terminalAppShellClass).toContain("h-dvh");
    expect(terminalAppShellClass).toContain("min-h-0");
    expect(terminalAppShellClass).toContain("overflow-hidden");
    expect(terminalAppShellClass).toMatch(/\bflex\b/);
    expect(terminalAppShellClass).toContain("flex-col");
  });

  it("gives TORCOVKA a flex column with a scrollable body and room for a docked footer", () => {
    expect(terminalOperationScreenClass).toContain("flex-1");
    expect(terminalOperationScreenClass).toContain("min-h-0");
    expect(terminalOperationScreenClass).toContain("flex-col");
    expect(terminalOperationBodyClass).toContain("overflow-y-auto");
    expect(terminalOperationBodyClass).toContain("flex-1");
    expect(terminalOperationBodyClass).toContain("min-h-0");
    expect(terminalOperationBodyClass).toContain("scrollbar-touch-y");
  });

  it("keeps PRISADKA/UPAKOVKA confirm bars sticky and TORCOVKA docked without overlay", () => {
    const sticky = terminalConfirmBarClass("sticky");
    const docked = terminalConfirmBarClass("docked");
    expect(sticky).toContain("sticky");
    expect(sticky).toContain("bottom-0");
    expect(sticky).toContain("z-10");
    expect(docked).not.toContain("sticky");
    expect(docked).toContain("flex-none");
    expect(terminalStickyOperationClass).toContain("overflow-y-auto");
    expect(terminalStickyOperationClass).toContain("min-h-0");
    expect(terminalStickyOperationClass).toContain("flex-1");
  });

  it("stacks the docked Torcovka footer below lg and restores the row at lg", () => {
    const docked = terminalConfirmBarClass("docked");
    expect(docked).toContain("flex-col");
    expect(docked).toContain("items-stretch");
    expect(docked).toContain("lg:flex-row");
    expect(docked).toContain("lg:items-center");
    expect(docked).toContain("max-lg:[&>button]:w-full");
    expect(docked).toContain("flex-none");
    expect(docked).not.toContain("sticky");
    expect(docked).not.toContain("bottom-0");
    expect(docked).not.toContain("z-10");
    expect(docked).not.toMatch(/(?:^|\s)-mx-6(?:\s|$)/);
    expect(docked).not.toMatch(/(?:^|\s)-mb-6(?:\s|$)/);
    expect(terminalOperationBodyClass).toContain("overflow-y-auto");
    expect(terminalOperationBodyClass).toContain("min-h-0");
    expect(terminalOperationBodyClass).toContain("flex-1");
  });

  it("keeps the sticky confirm bar on one centered row", () => {
    expect(terminalConfirmBarClass("sticky")).toBe(
      "bg-card flex items-center justify-between gap-4 border-t px-6 py-4 sticky bottom-0 z-10 -mx-6 -mb-6 mt-auto",
    );
    expect(terminalConfirmBarClass()).toBe(terminalConfirmBarClass("sticky"));
  });
});
