import { describe, expect, it } from "vitest";
import {
  terminalDialogScrollBodyClass,
  terminalDialogShellClass,
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
});
