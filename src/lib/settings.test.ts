import { describe, expect, it } from "vitest";
import { maskApiKey } from "@/lib/settings";

describe("maskApiKey", () => {
  it("маскирует середину ключа", () => {
    const masked = maskApiKey("ozon_live_8f3a2c91");
    expect(masked.startsWith("ozon")).toBe(true);
    expect(masked.endsWith("2c91")).toBe(true);
    expect(masked).toContain("•");
  });

  it("короткий ключ полностью скрыт", () => {
    expect(maskApiKey("short")).toBe("••••••••");
  });
});
