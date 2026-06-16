import { expect, test } from "bun:test";

import { buildTrayMenuTemplate } from "./ElectronTray.ts";

test("tray menu offers open, a login toggle reflecting state, and quit", () => {
    const menu = buildTrayMenuTemplate({ openAtLogin: true });

    const items = menu.filter((m) => m.kind === "item");
    expect(items.map((i) => i.id)).toEqual(["open", "toggle-login", "quit"]);

    // First action opens the window, last quits.
    expect(menu[0]).toMatchObject({ kind: "item", id: "open" });
    expect(menu[menu.length - 1]).toMatchObject({ kind: "item", id: "quit" });

    // The login toggle is checked when launch-at-login is enabled.
    const toggle = items.find((i) => i.id === "toggle-login");
    expect(toggle?.checked).toBe(true);
});

test("login toggle is unchecked when launch-at-login is disabled", () => {
    const menu = buildTrayMenuTemplate({ openAtLogin: false });
    const toggle = menu.find((m) => m.kind === "item" && m.id === "toggle-login");
    expect(toggle && toggle.kind === "item" ? toggle.checked : undefined).toBe(false);
});
