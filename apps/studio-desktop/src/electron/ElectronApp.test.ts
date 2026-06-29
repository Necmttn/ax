/**
 * TDD: Task 5 - register background helper via Electron SMAppService agentService API.
 *
 * Tests the three new ElectronApp methods:
 *   - registerBackgroundHelper
 *   - unregisterBackgroundHelper
 *   - helperStatus
 *
 * Uses `makeFrom(stub)` to inject a test double instead of the real Electron app,
 * keeping tests electron-free and runnable outside an Electron process.
 */
import { beforeEach, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  BACKGROUND_HELPER_SERVICE_NAME,
  ElectronApp,
  type AgentServiceStatus,
  type ElectronAppLike,
  makeFrom,
} from "./ElectronApp.ts";

// ---------------------------------------------------------------------------
// Stub electron app
// ---------------------------------------------------------------------------

type LoginItemCall = {
  type?: string;
  serviceName?: string;
  openAtLogin?: boolean;
};

let setLoginItemSettingsCalls: LoginItemCall[] = [];
let stubStatus: AgentServiceStatus = "not-registered";

const makeStubApp = (): ElectronAppLike => ({
  getName: () => "ax studio",
  getVersion: () => "0.0.0-test",
  on: () => stubApp,
  removeListener: () => stubApp,
  quit: () => {},
  exit: () => {},
  relaunch: () => {},
  whenReady: () => Promise.resolve(),
  requestSingleInstanceLock: () => true,
  setLoginItemSettings: (opts) => {
    setLoginItemSettingsCalls.push(opts as LoginItemCall);
  },
  getLoginItemSettings: (opts) => ({
    openAtLogin: false,
    status: stubStatus,
    type: opts?.type,
    serviceName: opts?.serviceName,
  }),
});

// Re-create the stub before each test so call log is clean.
let stubApp: ElectronAppLike;
let testLayer: Layer.Layer<ElectronApp>;

beforeEach(() => {
  setLoginItemSettingsCalls = [];
  stubStatus = "not-registered";
  stubApp = makeStubApp();
  testLayer = Layer.succeed(ElectronApp, makeFrom(stubApp));
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const run = <A>(effect: Effect.Effect<A, never, ElectronApp>) =>
  Effect.runPromise(effect.pipe(Effect.provide(testLayer)));

// ---------------------------------------------------------------------------
// Tests (TDD: these were written BEFORE the methods were added to ElectronApp)
// ---------------------------------------------------------------------------

test("[RED→GREEN] registerBackgroundHelper calls setLoginItemSettings with agentService + openAtLogin:true", async () => {
  await run(
    Effect.gen(function* () {
      const ea = yield* ElectronApp;
      yield* ea.registerBackgroundHelper;
    }),
  );

  // Only called on darwin; in CI (linux/macOS) the platform guard runs
  if (process.platform === "darwin") {
    expect(setLoginItemSettingsCalls).toHaveLength(1);
    expect(setLoginItemSettingsCalls[0]).toEqual({
      type: "agentService",
      serviceName: BACKGROUND_HELPER_SERVICE_NAME,
      openAtLogin: true,
    });
  } else {
    // non-darwin: no-op, no calls
    expect(setLoginItemSettingsCalls).toHaveLength(0);
  }
});

test("[RED→GREEN] unregisterBackgroundHelper calls setLoginItemSettings with openAtLogin:false", async () => {
  await run(
    Effect.gen(function* () {
      const ea = yield* ElectronApp;
      yield* ea.unregisterBackgroundHelper;
    }),
  );

  if (process.platform === "darwin") {
    expect(setLoginItemSettingsCalls).toHaveLength(1);
    expect(setLoginItemSettingsCalls[0]).toEqual({
      type: "agentService",
      serviceName: BACKGROUND_HELPER_SERVICE_NAME,
      openAtLogin: false,
    });
  } else {
    expect(setLoginItemSettingsCalls).toHaveLength(0);
  }
});

test("[RED→GREEN] helperStatus maps status from getLoginItemSettings", async () => {
  stubStatus = "requires-approval";
  stubApp = makeStubApp();
  testLayer = Layer.succeed(ElectronApp, makeFrom(stubApp));

  const status = await run(
    Effect.gen(function* () {
      const ea = yield* ElectronApp;
      return yield* ea.helperStatus;
    }),
  );

  if (process.platform === "darwin") {
    expect(status).toBe("requires-approval");
  } else {
    expect(status).toBe("not-registered");
  }
});

test("helperStatus maps 'enabled' status", async () => {
  stubStatus = "enabled";
  stubApp = makeStubApp();
  testLayer = Layer.succeed(ElectronApp, makeFrom(stubApp));

  const status = await run(
    Effect.gen(function* () {
      const ea = yield* ElectronApp;
      return yield* ea.helperStatus;
    }),
  );

  if (process.platform === "darwin") {
    expect(status).toBe("enabled");
  } else {
    expect(status).toBe("not-registered");
  }
});

test("helperStatus maps 'not-found' status (plist missing from bundle)", async () => {
  stubStatus = "not-found";
  stubApp = makeStubApp();
  testLayer = Layer.succeed(ElectronApp, makeFrom(stubApp));

  const status = await run(
    Effect.gen(function* () {
      const ea = yield* ElectronApp;
      return yield* ea.helperStatus;
    }),
  );

  if (process.platform === "darwin") {
    expect(status).toBe("not-found");
  } else {
    expect(status).toBe("not-registered");
  }
});

test("existing setOpenAtLogin still works (regression guard)", async () => {
  await run(
    Effect.gen(function* () {
      const ea = yield* ElectronApp;
      yield* ea.setOpenAtLogin(true);
    }),
  );

  // setOpenAtLogin always calls setLoginItemSettings (no platform guard)
  expect(setLoginItemSettingsCalls).toHaveLength(1);
  expect(setLoginItemSettingsCalls[0]).toMatchObject({
    type: "mainAppService",
    openAtLogin: true,
  });
});

test("registerBackgroundHelper and setOpenAtLogin are independent (both work together)", async () => {
  if (process.platform !== "darwin") return; // agentService only on darwin

  await run(
    Effect.gen(function* () {
      const ea = yield* ElectronApp;
      yield* ea.setOpenAtLogin(true);
      yield* ea.registerBackgroundHelper;
    }),
  );

  expect(setLoginItemSettingsCalls).toHaveLength(2);
  expect(setLoginItemSettingsCalls[0]).toMatchObject({ type: "mainAppService", openAtLogin: true });
  expect(setLoginItemSettingsCalls[1]).toMatchObject({
    type: "agentService",
    serviceName: BACKGROUND_HELPER_SERVICE_NAME,
    openAtLogin: true,
  });
});
