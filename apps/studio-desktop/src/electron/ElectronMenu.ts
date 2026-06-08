import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Electron from "electron";

export interface ElectronMenuShape {
  /**
   * Install a minimal application menu. On macOS this provides the standard
   * App / Edit / View menus so that the About/Quit items and Cmd-based
   * copy/paste/reload/devtools shortcuts work. On other platforms the menu is
   * cleared (the studio SPA owns its own chrome).
   */
  readonly installApplicationMenu: Effect.Effect<void>;
}

export class ElectronMenu extends Context.Service<ElectronMenu, ElectronMenuShape>()(
  "@ax/studio-desktop/electron/ElectronMenu",
) {}

const buildMacApplicationMenuTemplate = (): Electron.MenuItemConstructorOptions[] => {
  const appName = Electron.app.getName();
  return [
    {
      label: appName,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "quit", accelerator: "Command+Q" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
      ],
    },
  ];
};

const make = ElectronMenu.of({
  installApplicationMenu: Effect.sync(() => {
    if (process.platform !== "darwin") {
      Electron.Menu.setApplicationMenu(null);
      return;
    }
    Electron.Menu.setApplicationMenu(
      Electron.Menu.buildFromTemplate(buildMacApplicationMenuTemplate()),
    );
  }),
});

export const layer = Layer.succeed(ElectronMenu, make);
