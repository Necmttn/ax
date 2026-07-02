import { describe, expect, test } from "bun:test";
import { initForesight } from "./init.ts";

const installWindowShim = () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: {
            matchMedia: () => ({ matches: false }),
        },
    });

    return () => {
        if (previous) {
            Object.defineProperty(globalThis, "window", previous);
        } else {
            delete (globalThis as Record<string, unknown>)["window"];
        }
    };
};

const importFreshInit = async () => {
    const mod = await import(`./init.ts?test=${crypto.randomUUID()}`);
    return mod.initForesight as typeof initForesight;
};

describe("initForesight", () => {
    test("no-ops on the server (no window) and returns false", () => {
        expect(typeof window).toBe("undefined");
        expect(initForesight()).toBe(false);
    });

    test("repeat calls also return false", () => {
        expect(initForesight()).toBe(false);
        expect(initForesight({ dev: true })).toBe(false);
    });

    test("runs the supplied devtools loader only when devtools are enabled", async () => {
        const restoreWindow = installWindowShim();
        let loadCount = 0;
        let initializeCount = 0;
        const devtoolsLoader = () => {
            loadCount++;
            initializeCount++;
        };

        try {
            const initDisabled = await importFreshInit();
            expect(initDisabled({ devtools: false, devtoolsLoader })).toBe(true);
            await Promise.resolve();
            expect(loadCount).toBe(0);
            expect(initializeCount).toBe(0);

            const initEnabled = await importFreshInit();
            expect(initEnabled({ devtools: true, devtoolsLoader })).toBe(true);
            await Promise.resolve();
            expect(loadCount).toBe(1);
            expect(initializeCount).toBe(1);
        } finally {
            restoreWindow();
        }
    });
});
