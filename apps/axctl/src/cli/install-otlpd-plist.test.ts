import { describe, expect, it } from "bun:test";
import {
    otlpdPlist,
    resolveOtlpdPlistDecision,
    resolveTelemetryConsent,
    telemetryConsentConflict,
} from "./install.ts";

describe("otlpd install wiring", () => {
    it("builds a standalone LaunchAgent for ax otlpd", () => {
        const plist = otlpdPlist("/Users/test/.local/bin/ax");

        expect(plist).toContain("<string>com.necmttn.ax-otlpd</string>");
        expect(plist).toContain('exec "/Users/test/.local/bin/ax" otlpd');
        expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
        expect(plist).toContain("otlpd.out");
        expect(plist).toContain("otlpd.err");
    });
});

describe("telemetryConsentConflict (pure flag validation)", () => {
    it("flags --telemetry and --no-telemetry together", () => {
        expect(telemetryConsentConflict(true, true)).toBe(
            "axctl install: --telemetry and --no-telemetry cannot be used together",
        );
    });
    it("no conflict for every other combination", () => {
        expect(telemetryConsentConflict(false, false)).toBeNull();
        expect(telemetryConsentConflict(true, false)).toBeNull();
        expect(telemetryConsentConflict(false, true)).toBeNull();
    });
});

describe("resolveTelemetryConsent (tri-state, #findings-1)", () => {
    it("--telemetry grants consent", () => {
        expect(resolveTelemetryConsent(true, false)).toBe("grant");
    });
    it("--no-telemetry revokes consent", () => {
        expect(resolveTelemetryConsent(false, true)).toBe("revoke");
    });
    it("no flag at all preserves whatever consent state already exists", () => {
        // This is the load-bearing case: a plain `ax install` re-run must
        // NOT read as "--no-telemetry" (that used to unload a previously
        // consented otlpd agent - see resolveOtlpdPlistDecision below).
        expect(resolveTelemetryConsent(false, false)).toBe("preserve");
    });
});

describe("resolveOtlpdPlistDecision (cmdInstall's otlpd plist state machine)", () => {
    // The old "ax serve owns the OTLP port" contention case is gone - ax
    // otlpd is the only LaunchAgent ax installs, so there is no serve
    // LaunchAgent left to contend with it. One case per consent value.
    it("default install (no flags) preserves prior consent - never touches the plist", () => {
        // Whether the plist was previously written+loaded (prior --telemetry
        // consent) or is absent, "preserve" always no-ops either way - the
        // decision does not even need to know which case it's in.
        expect(resolveOtlpdPlistDecision("preserve")).toEqual({ action: "noop" });
    });

    it("explicit --telemetry always writes and loads", () => {
        expect(resolveOtlpdPlistDecision("grant")).toEqual({ action: "write-and-load" });
    });

    it("explicit --no-telemetry always unloads", () => {
        expect(resolveOtlpdPlistDecision("revoke")).toEqual({ action: "unload" });
    });
});
