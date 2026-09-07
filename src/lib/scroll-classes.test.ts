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
});
