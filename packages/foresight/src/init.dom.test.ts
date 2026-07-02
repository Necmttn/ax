import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import type { CallbackCompletedEvent, ForesightElementState } from "js.foresight";
import type { LedgerSnapshot } from "./ledger.ts";

type AxForesightWindow = Window & {
    __axForesight?: () => LedgerSnapshot;
};

const browserWindow = new HappyWindow({ url: "http://127.0.0.1/" });
const browserGlobals = {
    window: browserWindow,
    document: browserWindow.document,
    navigator: browserWindow.navigator,
    HTMLElement: browserWindow.HTMLElement,
    Element: browserWindow.Element,
    DOMRect: browserWindow.DOMRect,
    IntersectionObserver: browserWindow.IntersectionObserver,
    NodeList: browserWindow.NodeList,
    MutationObserver: browserWindow.MutationObserver,
    ResizeObserver: browserWindow.ResizeObserver,
    requestAnimationFrame: browserWindow.requestAnimationFrame.bind(browserWindow),
    cancelAnimationFrame: browserWindow.cancelAnimationFrame.bind(browserWindow),
};
const previousGlobals = new Map<keyof typeof browserGlobals, unknown>();

type ForesightManagerWithCleanup = {
    removeGlobalListeners?: () => void;
};

function installBrowserGlobals(): void {
    for (const [key, value] of Object.entries(browserGlobals) as [
        keyof typeof browserGlobals,
        unknown,
    ][]) {
        previousGlobals.set(key, globalThis[key]);
        Object.defineProperty(globalThis, key, {
            configurable: true,
            writable: true,
            value,
        });
    }
}

function restoreBrowserGlobals(): void {
    for (const [key, value] of previousGlobals) {
        if (value === undefined) {
            Reflect.deleteProperty(globalThis, key);
        } else {
            Object.defineProperty(globalThis, key, {
                configurable: true,
                writable: true,
                value,
            });
        }
    }
    previousGlobals.clear();
}

async function waitForForesightStartup(
    getLoaded: () => { desktopHandler: boolean; touchHandler: boolean },
): Promise<void> {
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
        const loaded = getLoaded();
        if (loaded.desktopHandler || loaded.touchHandler) return;
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
}

function installBrowserPolyfills(): void {
    if (typeof window.matchMedia === "function") return;

    Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: (query: string): MediaQueryList => ({
            matches: false,
            media: query,
            onchange: null,
            addEventListener: () => {},
            removeEventListener: () => {},
            addListener: () => {},
            removeListener: () => {},
            dispatchEvent: () => false,
        }),
    });
}

function readAxSnapshot(): LedgerSnapshot {
    const getSnapshot = (window as AxForesightWindow).__axForesight;
    if (typeof getSnapshot !== "function") {
        throw new Error("window.__axForesight was not installed");
    }
    return getSnapshot();
}

function eventFor(name: string, status: CallbackCompletedEvent["status"]): CallbackCompletedEvent {
    const element = document.createElement("a");
    const state = {
        id: "foresight-test",
        name,
        meta: {},
        hitSlop: { top: 0, right: 0, bottom: 0, left: 0 },
        isLimitedConnection: false,
        isIntersectingWithViewport: true,
        isRegistered: true,
        isActive: false,
        isParked: false,
        isEnabled: true,
        isPredicted: true,
        isCallbackRunning: false,
        hitCount: 1,
        registerCount: 1,
        durationMs: 1,
        status,
        error: status === "error" ? "boom" : null,
        reactivateAfter: Infinity,
    } satisfies ForesightElementState;

    return {
        type: "callbackCompleted",
        timestamp: Date.now(),
        element,
        state,
        hitType: { kind: "mouse", subType: "hover" },
        elapsed: 1,
        status,
        errorMessage: status === "error" ? "boom" : null,
        wasLastActiveElement: true,
    };
}

beforeAll(() => {
    installBrowserGlobals();
    installBrowserPolyfills();
});

afterAll(async () => {
    const { ForesightManager } = await import("js.foresight");
    if (ForesightManager.isInitiated) {
        await waitForForesightStartup(
            () => ForesightManager.instance.getManagerData.loadedModules,
        );
        (ForesightManager.instance as unknown as ForesightManagerWithCleanup)
            .removeGlobalListeners?.();
    }
    restoreBrowserGlobals();
});

describe("initForesight in a browser", () => {
    test("initializes once and exposes dev ledger updates from callbackCompleted", async () => {
        const { ForesightManager } = await import("js.foresight");
        const { initForesight } = await import(`./init.ts?dom=${Date.now()}`);
        const initialListenerCount = ForesightManager.isInitiated
            ? (ForesightManager.instance.getManagerData.eventListeners.get("callbackCompleted")
                  ?.length ?? 0)
            : 0;

        expect(initForesight({ dev: true })).toBe(true);
        expect(initForesight({ dev: true })).toBe(false);
        expect(readAxSnapshot()).toEqual({
            fired: 0,
            hits: 0,
            errors: 0,
            navigations: 0,
            hitRate: 0,
        });

        const listener = ForesightManager.instance.getManagerData.eventListeners.get(
            "callbackCompleted",
        )?.[initialListenerCount];
        expect(typeof listener).toBe("function");

        listener?.(eventFor("/sessions/abc", "success"));
        listener?.(eventFor("/sessions/error", "error"));

        expect(readAxSnapshot()).toEqual({
            fired: 1,
            hits: 0,
            errors: 1,
            navigations: 0,
            hitRate: 0,
        });
    });
});
