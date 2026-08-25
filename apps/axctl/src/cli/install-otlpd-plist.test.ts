import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    escapeXmlText,
    otlpdPlist,
    resolveOtlpdPlistDecision,
    resolveTelemetryConsent,
    telemetryConsentConflict,
} from "./install.ts";

/** Best-effort well-formedness check via whichever validator is on PATH. */
function assertWellFormedXml(xml: string): void {
    const plutil = spawnSync("plutil", ["-lint", "-"], { input: xml, encoding: "utf8" });
    if (plutil.error === undefined && plutil.status !== null) {
        expect(plutil.status).toBe(0);
        return;
    }
    const xmllint = spawnSync("xmllint", ["--noout", "-"], { input: xml, encoding: "utf8" });
    if (xmllint.error === undefined && xmllint.status !== null) {
        expect(xmllint.status).toBe(0);
    }
}

describe("otlpd install wiring", () => {
    it("builds a standalone LaunchAgent for ax otlpd", () => {
        const plist = otlpdPlist("/Users/test/.local/bin/ax");

        expect(plist).toContain("<string>com.necmttn.ax-otlpd</string>");
        expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
        expect(plist).toContain("otlpd.out");
        expect(plist).toContain("otlpd.err");
    });

    it("uses direct ProgramArguments - no shell, no bash -lc wrapper", () => {
        const plist = otlpdPlist("/Users/test/.local/bin/ax");

        expect(plist).not.toContain("/bin/bash");
        expect(plist).not.toContain("-lc");
        expect(plist).not.toContain("exec ");
        expect(plist).toMatch(
            /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/Users\/test\/\.local\/bin\/ax<\/string>\s*<string>otlpd<\/string>\s*<\/array>/,
        );
    });

    it("keeps working for the source-checkout bin\\/axctl wrapper path", () => {
        const plist = otlpdPlist("/Users/test/repo/apps/axctl/bin/axctl");

        expect(plist).toMatch(
            /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/Users\/test\/repo\/apps\/axctl\/bin\/axctl<\/string>\s*<string>otlpd<\/string>\s*<\/array>/,
        );
        assertWellFormedXml(plist);
    });

    it("keeps working for the compiled-binary execPath", () => {
        const plist = otlpdPlist("/Users/test/.local/bin/axctl");

        expect(plist).toMatch(
            /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/Users\/test\/\.local\/bin\/axctl<\/string>\s*<string>otlpd<\/string>\s*<\/array>/,
        );
        assertWellFormedXml(plist);
    });

    it("escapes an ampersand in binPath so the plist stays well-formed", () => {
        const plist = otlpdPlist("/Users/a&b/bin/ax");

        expect(plist).toContain("<string>/Users/a&amp;b/bin/ax</string>");
        expect(plist).not.toContain("/Users/a&b/bin/ax");
        assertWellFormedXml(plist);
    });

    it("escapes a less-than sign in binPath so the plist stays well-formed", () => {
        const plist = otlpdPlist("/Users/a<b/bin/ax");

        expect(plist).toContain("<string>/Users/a&lt;b/bin/ax</string>");
        expect(plist).not.toContain("<b/bin/ax<");
        assertWellFormedXml(plist);
    });

    it("escapes quotes in binPath", () => {
        const plist = otlpdPlist(`/Users/a"b'c/bin/ax`);

        expect(plist).toContain("<string>/Users/a&quot;b&apos;c/bin/ax</string>");
        assertWellFormedXml(plist);
    });

    it("carries shell metacharacters through as inert literal text, never as a command", () => {
        const dangerous = "/Users/$(rm -rf /);`id`|bin/ax";
        const plist = otlpdPlist(dangerous);

        // No shell wrapper exists to interpret these - they must appear as
        // plain escaped XML text inside a single <string> element.
        expect(plist).toContain(escapeXmlText(dangerous));
        expect(plist).not.toContain("/bin/bash");
        assertWellFormedXml(plist);
    });

    it("escapes an optional AX_OTLP_SPOOL_DIR env value", () => {
        const prev = process.env.AX_OTLP_SPOOL_DIR;
        process.env.AX_OTLP_SPOOL_DIR = "/Users/spool&<dir>";
        try {
            const plist = otlpdPlist("/Users/test/.local/bin/ax");
            expect(plist).toContain("<key>AX_OTLP_SPOOL_DIR</key>");
            expect(plist).toContain("<string>/Users/spool&amp;&lt;dir&gt;</string>");
            assertWellFormedXml(plist);
        } finally {
            if (prev === undefined) delete process.env.AX_OTLP_SPOOL_DIR;
            else process.env.AX_OTLP_SPOOL_DIR = prev;
        }
    });

    it("omits AX_OTLP_SPOOL_DIR entirely when unset", () => {
        const prev = process.env.AX_OTLP_SPOOL_DIR;
        delete process.env.AX_OTLP_SPOOL_DIR;
        try {
            const plist = otlpdPlist("/Users/test/.local/bin/ax");
            expect(plist).not.toContain("AX_OTLP_SPOOL_DIR");
        } finally {
            if (prev === undefined) delete process.env.AX_OTLP_SPOOL_DIR;
            else process.env.AX_OTLP_SPOOL_DIR = prev;
        }
    });
});

describe("escapeXmlText", () => {
    it("escapes ampersand first so entities are not double-escaped", () => {
        expect(escapeXmlText("a & b")).toBe("a &amp; b");
    });
    it("escapes less-than and greater-than", () => {
        expect(escapeXmlText("<tag>")).toBe("&lt;tag&gt;");
    });
    it("escapes double and single quotes", () => {
        expect(escapeXmlText(`"quoted" 'single'`)).toBe("&quot;quoted&quot; &apos;single&apos;");
    });
    it("leaves plain text untouched", () => {
        expect(escapeXmlText("/Users/test/.local/bin/ax")).toBe("/Users/test/.local/bin/ax");
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
