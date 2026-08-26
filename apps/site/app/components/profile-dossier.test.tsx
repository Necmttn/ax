import { describe, expect, test } from "bun:test";

// Repo-root `bun test` cannot resolve this component's `~/` import chain.
// Follow the site source-contract convention used by the adjacent dossier tests.
const src = await Bun.file(new URL("./profile-dossier.tsx", import.meta.url)).text();

describe("buildInsightCards duration labels", () => {
    test("defines capped session spans and session-start peak hour", () => {
        expect(src).toContain('q: "Longest capped span?"');
        expect(src).toContain('s: "longest capped session span - each session is capped at 24h');
        expect(src).toContain('q: "Peak session-start hour?"');
        expect(src).toContain('s: "peak session-start hour - most sessions kick off around here"');
        expect(src).toContain('q: "Total capped session spans?"');
        expect(src).toContain('s: "sum of per-session spans, each capped at 24h"');
    });
});
