import { describe, expect, test } from "bun:test";
import { initForesight } from "./init.ts";

describe("initForesight", () => {
    test("no-ops on the server (no window) and returns false", () => {
        expect(typeof window).toBe("undefined");
        expect(initForesight()).toBe(false);
    });

    test("repeat calls also return false", () => {
        expect(initForesight()).toBe(false);
        expect(initForesight({ dev: true })).toBe(false);
    });
});
