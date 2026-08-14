import { describe, expect, test } from "bun:test";
import { isGlobalIngest } from "./ingest.ts";

// The blob-GC gate (#F2, wave-0 integration finding P1-1): GC deletes any
// bucket blob no session references, so it may run ONLY on a truly global
// ingest whose `session` table is a complete reference set. Any scope
// narrowing - a --since window, repo/project scope, or a --stages subset -
// leaves that table partial and must SKIP GC (else it deletes blobs referenced
// only by out-of-scope repos/sessions).
describe("isGlobalIngest (blob-GC gate)", () => {
    test("a bare global ingest is global -> GC runs", () => {
        expect(isGlobalIngest([])).toBe(true);
        expect(isGlobalIngest(["--verbose"])).toBe(true);
        expect(isGlobalIngest(["--debug", "--progress=plain"])).toBe(true);
    });

    test("a --since= window is NOT global -> GC skips", () => {
        expect(isGlobalIngest(["--since=1"])).toBe(false);
        expect(isGlobalIngest(["--since=7d", "--verbose"])).toBe(false);
    });

    test("a --stages= subset is NOT global -> GC skips", () => {
        expect(isGlobalIngest(["--stages=git"])).toBe(false);
        expect(isGlobalIngest(["--stages=claude,codex"])).toBe(false);
    });

    test("`ax ingest here` (repo/project scope) is NOT global -> GC skips", () => {
        // cmdIngestHere passes repoPaths + claudeProject (and injects --stages=).
        expect(
            isGlobalIngest(["--stages=git,claude"], {
                command: "ingest-here",
                repoPaths: ["/repo"],
                claudeProject: "-repo",
            }),
        ).toBe(false);
        // repoPaths alone (no injected --stages) still narrows scope.
        expect(isGlobalIngest([], { repoPaths: ["/repo"] })).toBe(false);
        expect(isGlobalIngest([], { claudeProject: "-repo" })).toBe(false);
    });
});
