/** @vitest-environment happy-dom */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({
  verify: vi.fn(),
  save: vi.fn(),
}));

vi.mock("@/server/settings", () => ({
  verifyApiCredentialsPassword: actions.verify,
  saveApiCredentials: actions.save,
}));

import { SettingsApiTab } from "@/components/settings/settings-api-tab";
import { SettingsView } from "@/components/settings/settings-view";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("settings API tab", () => {
  it("shows field definitions and no stored secret before unlock", async () => {
    const user = userEvent.setup();
    render(
      <SettingsView
        logs={[]}
        appSettings={{ wasteThresholdPct: 10 }}
        minStock={[]}
      />,
    );
    await user.click(screen.getByRole("tab", { name: "API-ключи" }));
    expect(screen.getByText("Ozon Seller API")).toBeTruthy();
    expect(screen.getByText(/Client-Id/)).toBeTruthy();
    expect(screen.getByText("Wildberries API")).toBeTruthy();
    expect(document.body.textContent).not.toContain("stored-wb-secret");
  });

  it("loads values after the correct password and clears them on lock", async () => {
    const user = userEvent.setup();
    actions.verify.mockResolvedValue({
      ok: true,
      values: {
        "ozon.clientId": "client-1",
        "ozon.apiKey": "ozon-secret",
        "wb.token": "stored-wb-secret",
      },
    });
    render(<SettingsApiTab />);
    await user.type(screen.getByLabelText("Пароль"), "correct-admin-password");
    await user.click(screen.getByRole("button", { name: "Разблокировать" }));
    expect(await screen.findByDisplayValue("stored-wb-secret")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Заблокировать" }));
    expect(screen.queryByDisplayValue("stored-wb-secret")).toBeNull();
    expect(screen.queryByDisplayValue("ozon-secret")).toBeNull();
    expect((screen.getByLabelText("Пароль") as HTMLInputElement).value).toBe("");
    expect(document.body.textContent).not.toContain("stored-wb-secret");
  });
});
