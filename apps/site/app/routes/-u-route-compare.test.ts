import { describe, expect, test } from "bun:test";

const src = await Bun.file(new URL("./u.$login.tsx", import.meta.url)).text();

describe("/u/$login multi-profile compare route", () => {
    test("normalizes comma-separated vs search with the shared parser", () => {
        expect(src).toContain("parseCompareLogins");
        expect(src).toMatch(/parseCompareLogins\(search\.vs\)/);
    });

    test("filters the primary profile out before fetching peers", () => {
        expect(src).toContain("exclude: login");
    });

    test("stores per-peer compare states so one failed profile can degrade alone", () => {
        expect(src).toContain("kind: \"multi\"");
        expect(src).toContain("peers:");
        expect(src).toContain("updatePeer");
    });
});
