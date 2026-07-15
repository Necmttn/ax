import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { layerTestFileSystem } from "@ax/lib/testing/test-filesystem";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import {
  isDesktopAssetRequest,
  resolveDesktopProtocolRequest,
} from "./ElectronProtocol.ts";

const environmentInput: DesktopEnvironment.MakeDesktopEnvironmentInput = {
  dirname: "/app/dist-electron",
  repoRoot: "/repo",
  isDevelopment: false,
  resourcesPath: "/app/resources",
  userDataDir: "/user-data",
  platform: "darwin",
  processArch: "arm64",
  surrealBinaryPath: "surreal",
  bunBinaryPath: "bun",
  homeDir: "/home/test",
  axDataDirOverride: undefined,
};

function resolveRequest(requestUrl: string) {
  const files = {
    "/static/index.html": "<html></html>",
    "/static/assets/app.js": "export {};",
  };

  return Effect.runPromise(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      return yield* resolveDesktopProtocolRequest("/static", requestUrl).pipe(
        Effect.provideService(
          DesktopEnvironment.DesktopEnvironment,
          DesktopEnvironment.make(environmentInput, path),
        ),
      );
    }).pipe(Effect.provide(Layer.merge(layerTestFileSystem(files), Path.layer))),
  );
}

test("only requests under /assets/ are treated as hard-404 assets", () => {
  expect(isDesktopAssetRequest("ax://studio/assets/app.js")).toBe(true);
  expect(isDesktopAssetRequest("ax://studio/assets/fonts/doto.woff2?cache=1")).toBe(true);

  expect(isDesktopAssetRequest("ax://studio/studio/index.html")).toBe(false);
  expect(isDesktopAssetRequest("ax://studio/sessions/session.with.dots")).toBe(false);
});

test("protocol requests use the SPA shell except for missing bundled assets", async () => {
  expect(await resolveRequest("ax://studio/sessions/session.with.dots")).toEqual({
    path: "/static/index.html",
  });
  expect(await resolveRequest("ax://studio/assets/app.js")).toEqual({
    path: "/static/assets/app.js",
  });
  expect(await resolveRequest("ax://studio/assets/missing.js")).toEqual({ error: -6 });
  expect(await resolveRequest("ax://studio/assets/missing")).toEqual({ error: -6 });
});
