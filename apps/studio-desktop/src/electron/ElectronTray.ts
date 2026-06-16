import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import * as Electron from "electron";

import { makeComponentLogger } from "../app/DesktopObservability.ts";

const { logInfo: logTrayInfo } = makeComponentLogger("electron-tray");

/** Actions a tray menu item can dispatch. */
export type TrayAction = "open" | "toggle-login" | "quit";

/** A platform-agnostic tray menu entry (kept electron-free so it is unit-testable). */
export type TrayMenuItem =
  | { readonly kind: "item"; readonly id: TrayAction; readonly label: string; readonly checked?: boolean }
  | { readonly kind: "separator" };

/**
 * Build the tray context-menu structure. Pure: maps state -> descriptors; the
 * service layer turns these into electron MenuItems with click handlers.
 */
export const buildTrayMenuTemplate = (state: {
  readonly openAtLogin: boolean;
}): ReadonlyArray<TrayMenuItem> => [
  { kind: "item", id: "open", label: "Open ax studio" },
  { kind: "separator" },
  { kind: "item", id: "toggle-login", label: "Start at Login", checked: state.openAtLogin },
  { kind: "separator" },
  { kind: "item", id: "quit", label: "Quit ax studio" },
];

/** Sync callbacks the tray dispatches (the caller bridges these to Effects). */
export interface TrayHandlers {
  readonly onOpen: () => void;
  readonly onToggleLogin: () => void;
  readonly onQuit: () => void;
}

export interface ElectronTrayInstallArgs {
  /** Absolute path to the template PNG (macOS recolors a template image per theme). */
  readonly iconPath: string;
  /** Current launch-at-login state, used to check the toggle. */
  readonly openAtLogin: boolean;
  readonly handlers: TrayHandlers;
}

export interface ElectronTrayShape {
  /**
   * Create the menubar tray with the icon + a context menu reflecting
   * `openAtLogin`. Scoped: the Tray is destroyed when the scope closes (app
   * shutdown), preventing a leaked menubar icon.
   */
  readonly install: (
    args: ElectronTrayInstallArgs,
  ) => Effect.Effect<void, never, Scope.Scope>;
}

export class ElectronTray extends Context.Service<ElectronTray, ElectronTrayShape>()(
  "@ax/studio-desktop/electron/ElectronTray",
) {}

const dispatch = (id: TrayAction, handlers: TrayHandlers): void => {
  if (id === "open") return handlers.onOpen();
  if (id === "toggle-login") return handlers.onToggleLogin();
  return handlers.onQuit();
};

const toElectronTemplate = (
  args: ElectronTrayInstallArgs,
): Array<Electron.MenuItemConstructorOptions> =>
  buildTrayMenuTemplate({ openAtLogin: args.openAtLogin }).map(
    (item): Electron.MenuItemConstructorOptions => {
      if (item.kind === "separator") return { type: "separator" };
      const click = () => dispatch(item.id, args.handlers);
      return item.id === "toggle-login"
        ? { label: item.label, type: "checkbox", checked: item.checked ?? false, click }
        : { label: item.label, type: "normal", click };
    },
  );

const make = ElectronTray.of({
  install: (args) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const image = Electron.nativeImage.createFromPath(args.iconPath);
        image.setTemplateImage(true);
        const tray = new Electron.Tray(image);
        tray.setToolTip("ax studio");
        tray.setContextMenu(Electron.Menu.buildFromTemplate(toElectronTemplate(args)));
        return tray;
      }),
      (tray) => Effect.sync(() => tray.destroy()),
    ).pipe(
      Effect.tap(() => logTrayInfo("menubar tray installed", { iconPath: args.iconPath })),
      Effect.asVoid,
    ),
});

export const layer = Layer.succeed(ElectronTray, make);
