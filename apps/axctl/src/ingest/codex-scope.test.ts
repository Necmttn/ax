import { describe, expect, test } from "bun:test";
import { cwdInRepoScope, codexCwdFromMetaLine } from "./codex-scope.ts";

describe("cwdInRepoScope", () => {
    const roots = ["/Users/x/Projects/ax"];

    test("keeps a session whose cwd IS the repo root", () => {
        expect(cwdInRepoScope("/Users/x/Projects/ax", roots)).toBe(true);
    });
    test("keeps a session inside the repo root", () => {
        expect(cwdInRepoScope("/Users/x/Projects/ax/apps/axctl", roots)).toBe(true);
    });
    test("EXCLUDES an out-of-repo rollout", () => {
        expect(cwdInRepoScope("/Users/x/Projects/other", roots)).toBe(false);
    });
    test("does not match a sibling with a shared prefix", () => {
        // /Users/x/Projects/ax-extra must NOT be considered inside /…/ax
        expect(cwdInRepoScope("/Users/x/Projects/ax-extra", roots)).toBe(false);
    });
    test("null cwd is out of scope", () => {
        expect(cwdInRepoScope(null, roots)).toBe(false);
    });
    test("tolerates trailing slashes on the root", () => {
        expect(cwdInRepoScope("/Users/x/Projects/ax/apps", ["/Users/x/Projects/ax/"])).toBe(true);
    });
});

describe("codexCwdFromMetaLine", () => {
    test("extracts cwd from a session_meta line", () => {
        const line = JSON.stringify({
            type: "session_meta",
            payload: { id: "abc", cwd: "/Users/x/Projects/ax", cli_version: "1" },
        });
        expect(codexCwdFromMetaLine(line)).toBe("/Users/x/Projects/ax");
    });
    test("null for a non-session_meta line", () => {
        expect(codexCwdFromMetaLine(JSON.stringify({ type: "turn_context", payload: {} }))).toBeNull();
    });
    test("null for a session_meta line without cwd", () => {
        expect(codexCwdFromMetaLine(JSON.stringify({ type: "session_meta", payload: { id: "a" } }))).toBeNull();
    });
    test("null for malformed json", () => {
        expect(codexCwdFromMetaLine("{not json")).toBeNull();
        expect(codexCwdFromMetaLine("")).toBeNull();
    });
});
