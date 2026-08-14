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
    it("default install (no flags) preserves prior consent - never touches the plist", () => {
        // Whether the plist was previously written+loaded (prior --telemetry
        // consent) or is absent, "preserve" always no-ops either way - the
        // decision does not even need to know which case it's in.
        expect(resolveOtlpdPlistDecision("preserve", { serveAgentManaged: false }))
            .toEqual({ action: "noop" });
        expect(resolveOtlpdPlistDecision("preserve", { serveAgentManaged: true }))
            .toEqual({ action: "noop" });
    });

    it("explicit --telemetry writes and loads when no serve LaunchAgent owns the port (IDE model)", () => {
        expect(resolveOtlpdPlistDecision("grant", { serveAgentManaged: false }))
            .toEqual({ action: "write-and-load" });
    });

    it("explicit --telemetry writes but defers loading while ax serve owns the OTLP port", () => {
        const decision = resolveOtlpdPlistDecision("grant", { serveAgentManaged: true });
        expect(decision.action).toBe("write-only");
        expect(decision).toMatchObject({
            note: expect.stringContaining("ax serve currently owns the OTLP receiver"),
        });
    });

    it("explicit --no-telemetry always unloads, regardless of serve ownership", () => {
        expect(resolveOtlpdPlistDecision("revoke", { serveAgentManaged: false }))
            .toEqual({ action: "unload" });
        expect(resolveOtlpdPlistDecision("revoke", { serveAgentManaged: true }))
            .toEqual({ action: "unload" });
    });
});
