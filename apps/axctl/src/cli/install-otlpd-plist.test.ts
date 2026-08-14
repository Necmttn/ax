import { describe, expect, it } from "bun:test";
import { otlpdPlist, resolveTelemetryConsent } from "./install.ts";

describe("otlpd install wiring", () => {
    it("builds a standalone LaunchAgent for ax otlpd", () => {
        const plist = otlpdPlist("/Users/test/.local/bin/ax");

        expect(plist).toContain("<string>com.necmttn.ax-otlpd</string>");
        expect(plist).toContain('exec "/Users/test/.local/bin/ax" otlpd');
        expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
        expect(plist).toContain("otlpd.out");
        expect(plist).toContain("otlpd.err");
    });

    it("requires explicit telemetry consent", () => {
        expect(resolveTelemetryConsent(false, false)).toBe(false);
        expect(resolveTelemetryConsent(true, false)).toBe(true);
        expect(resolveTelemetryConsent(false, true)).toBe(false);
        expect(() => resolveTelemetryConsent(true, true)).toThrow(
            "--telemetry and --no-telemetry cannot be used together",
        );
    });
});
