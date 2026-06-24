import { describe, it, expect } from "bun:test";
import { Duration } from "effect";
import { resolveManagedSurrealPath, parseDurationString } from "./managed-db.ts";

describe("resolveManagedSurrealPath", () => {
    it("resolves surreal as a sibling of the bun execPath", () => {
        expect(resolveManagedSurrealPath("/Applications/ax studio.app/Contents/Resources/bin/arm64/bun"))
            .toBe("/Applications/ax studio.app/Contents/Resources/bin/arm64/surreal");
    });

    it("works for x64 arch", () => {
        expect(resolveManagedSurrealPath("/Applications/ax studio.app/Contents/Resources/bin/x64/bun"))
            .toBe("/Applications/ax studio.app/Contents/Resources/bin/x64/surreal");
    });
});

describe("parseDurationString", () => {
    it("parses '2m' as 2 minutes", () => {
        const d = parseDurationString("2m");
        expect(d).not.toBeNull();
        expect(Duration.toMillis(d!)).toBe(2 * 60 * 1000);
    });

    it("parses '30s' as 30 seconds", () => {
        const d = parseDurationString("30s");
        expect(d).not.toBeNull();
        expect(Duration.toMillis(d!)).toBe(30 * 1000);
    });

    it("parses '1h' as 1 hour", () => {
        const d = parseDurationString("1h");
        expect(d).not.toBeNull();
        expect(Duration.toMillis(d!)).toBe(60 * 60 * 1000);
    });

    it("parses '500ms' as 500 milliseconds", () => {
        const d = parseDurationString("500ms");
        expect(d).not.toBeNull();
        expect(Duration.toMillis(d!)).toBe(500);
    });

    it("returns null for unrecognised format", () => {
        expect(parseDurationString("bad")).toBeNull();
        expect(parseDurationString("2 minutes")).toBeNull();
        expect(parseDurationString("")).toBeNull();
    });
});
