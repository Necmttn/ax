import { describe, expect, it } from "bun:test";
import { servePlist } from "./install.ts";

describe("servePlist", () => {
    const BIN_PATH = "/Users/test/.local/share/ax/bin/axctl";
    const plist = servePlist(BIN_PATH);

    it("has the correct Label", () => {
        expect(plist).toContain("<string>com.necmttn.ax-serve</string>");
    });

    it("includes serve --port=1738", () => {
        expect(plist).toContain("serve --port=1738");
    });

    it("has RunAtLoad true", () => {
        const runAtLoad = plist.indexOf("<key>RunAtLoad</key>");
        expect(runAtLoad).toBeGreaterThan(-1);
        // The <true/> must follow <key>RunAtLoad</key>
        const afterKey = plist.slice(runAtLoad);
        expect(afterKey).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    });

    it("has KeepAlive dict", () => {
        expect(plist).toContain("<key>KeepAlive</key>");
        expect(plist).toContain("<key>SuccessfulExit</key>");
        expect(plist).toContain("<key>Crashed</key>");
    });

    it("contains the binPath passed in", () => {
        expect(plist).toContain(BIN_PATH);
    });

    it("has standard log paths", () => {
        expect(plist).toContain("serve.out");
        expect(plist).toContain("serve.err");
    });
});
