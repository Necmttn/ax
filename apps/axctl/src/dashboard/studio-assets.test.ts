import { describe, expect, test } from "bun:test";
import { serveStudioAsset, shouldServeSpaFallback } from "./studio-assets.ts";

describe("serveStudioAsset", () => {
    test("returns null for a missing extensioned asset", async () => {
        expect(await serveStudioAsset("/missing-runtime.js")).toBeNull();
        expect(await serveStudioAsset("/missing.css")).toBeNull();
    });

    test("permits fallback only for extensionless client routes", () => {
        expect(shouldServeSpaFallback("/sessions/abc")).toBe(true);
        expect(shouldServeSpaFallback("/missing-runtime.js")).toBe(false);
        expect(shouldServeSpaFallback("/missing.css")).toBe(false);
        expect(shouldServeSpaFallback("/assets/missing")).toBe(false);
    });
});
