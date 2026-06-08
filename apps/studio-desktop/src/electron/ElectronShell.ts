import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Electron from "electron";

const SAFE_EXTERNAL_PROTOCOLS = new Set(["http:", "https:"]);

export function parseSafeExternalUrl(rawUrl: unknown): Option.Option<string> {
  if (typeof rawUrl !== "string") {
    return Option.none();
  }

  try {
    const url = new URL(rawUrl);
    return SAFE_EXTERNAL_PROTOCOLS.has(url.protocol) ? Option.some(url.href) : Option.none();
  } catch {
    return Option.none();
  }
}

export interface ElectronShellShape {
  /**
   * Open an external URL in the system browser. Returns `false` (without
   * touching the shell) for anything that is not a well-formed http(s) URL,
   * so studio links never escape into arbitrary protocol handlers.
   */
  readonly openExternal: (rawUrl: unknown) => Effect.Effect<boolean>;
}

export class ElectronShell extends Context.Service<ElectronShell, ElectronShellShape>()(
  "@ax/studio-desktop/electron/ElectronShell",
) {}

const make = ElectronShell.of({
  openExternal: (rawUrl) =>
    Option.match(parseSafeExternalUrl(rawUrl), {
      onNone: () => Effect.succeed(false),
      onSome: (externalUrl) =>
        Effect.promise(() =>
          Electron.shell.openExternal(externalUrl).then(
            () => true,
            () => false,
          ),
        ),
    }),
});

export const layer = Layer.succeed(ElectronShell, make);
