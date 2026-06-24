/**
 * verify-helper-bundle.test.ts - TDD gate for the ax studio helper plist.
 *
 * Asserts that build/LaunchAgents/com.necmttn.ax-studio.helper.plist:
 *   - Has the correct Label / RunAtLoad / KeepAlive / AssociatedBundleIdentifiers
 *   - BundleProgram points at the arch-specific bundled bun binary
 *   - ProgramArguments includes the ax serve flags (serve, --managed-db)
 *   - DOES NOT have StandardOutPath or StandardErrorPath
 *     (macOS 14.4+ rejects SMAppService jobs that set them)
 *
 * Run from apps/studio-desktop/:  bun test scripts/verify-helper-bundle.test.ts
 */
import { describe, expect, it } from "bun:test";
import { parseHelperPlist } from "./verify-helper-bundle.ts";

describe("com.necmttn.ax-studio.helper.plist", () => {
    // Parse once; every assertion below reads from this shared object.
    const plist = parseHelperPlist();

    // ── Identity ────────────────────────────────────────────────────────────

    it("Label == com.necmttn.ax-studio.helper", () => {
        expect(plist["Label"]).toBe("com.necmttn.ax-studio.helper");
    });

    // ── Executable ──────────────────────────────────────────────────────────

    it("BundleProgram is set", () => {
        expect(typeof plist["BundleProgram"]).toBe("string");
    });

    it("BundleProgram ends with /bun", () => {
        expect((plist["BundleProgram"] as string).endsWith("/bun")).toBe(true);
    });

    it("BundleProgram uses full bundle-relative prefix Contents/Resources/bin/(arm64|x64)/bun", () => {
        expect(plist["BundleProgram"] as string).toMatch(/^Contents\/Resources\/bin\/(arm64|x64)\/bun$/);
    });

    // ── ProgramArguments ────────────────────────────────────────────────────

    it("ProgramArguments is an array", () => {
        expect(Array.isArray(plist["ProgramArguments"])).toBe(true);
    });

    it("ProgramArguments contains 'serve'", () => {
        const args = plist["ProgramArguments"] as string[];
        expect(args).toContain("serve");
    });

    it("ProgramArguments contains '--managed-db'", () => {
        const args = plist["ProgramArguments"] as string[];
        expect(args).toContain("--managed-db");
    });

    it("ProgramArguments contains '--port=1738'", () => {
        const args = plist["ProgramArguments"] as string[];
        expect(args).toContain("--port=1738");
    });

    it("ProgramArguments contains '--ingest-every=2m'", () => {
        const args = plist["ProgramArguments"] as string[];
        expect(args).toContain("--ingest-every=2m");
    });

    // ── Lifecycle ───────────────────────────────────────────────────────────

    it("RunAtLoad == true", () => {
        expect(plist["RunAtLoad"]).toBe(true);
    });

    it("KeepAlive is truthy", () => {
        expect(plist["KeepAlive"]).toBeTruthy();
    });

    it("ProcessType == Background", () => {
        expect(plist["ProcessType"]).toBe("Background");
    });

    // ── Headroom ────────────────────────────────────────────────────────────

    it("ThrottleInterval is a positive number", () => {
        const interval = plist["ThrottleInterval"];
        expect(typeof interval).toBe("number");
        expect((interval as number) > 0).toBe(true);
    });

    it("SoftResourceLimits.NumberOfFiles == 65536", () => {
        const limits = plist["SoftResourceLimits"] as Record<string, number>;
        expect(limits).toBeTruthy();
        expect(limits["NumberOfFiles"]).toBe(65536);
    });

    // ── Association ─────────────────────────────────────────────────────────

    it("AssociatedBundleIdentifiers contains com.necmttn.ax-studio", () => {
        const ids = plist["AssociatedBundleIdentifiers"] as string[];
        expect(Array.isArray(ids)).toBe(true);
        expect(ids).toContain("com.necmttn.ax-studio");
    });

    // ── CRITICAL: forbidden keys ─────────────────────────────────────────────
    // macOS 14.4+ rejects SMAppService jobs that set StandardOutPath or
    // StandardErrorPath (SMAppServiceErrorDomain code 22 / status .notFound).

    it("does NOT have StandardOutPath (macOS 14.4+ rejects it on SMAppService jobs)", () => {
        expect(plist["StandardOutPath"]).toBeUndefined();
    });

    it("does NOT have StandardErrorPath (macOS 14.4+ rejects it on SMAppService jobs)", () => {
        expect(plist["StandardErrorPath"]).toBeUndefined();
    });
});
