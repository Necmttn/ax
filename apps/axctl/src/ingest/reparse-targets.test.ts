import { describe, expect, test } from "bun:test";
import {
    applyReparseSelection,
    REPARSE_TARGET_ENV,
    REPARSE_TARGETS,
    resolveReparseTargets,
} from "./reparse-targets.ts";

describe("resolveReparseTargets", () => {
    test("a bare flag means every target", () => {
        const bare = resolveReparseTargets(undefined);
        expect(bare.targets).toEqual(REPARSE_TARGETS);
        expect(bare.unknown).toEqual([]);
        expect(resolveReparseTargets("").targets).toEqual(REPARSE_TARGETS);
        expect(resolveReparseTargets("all").targets).toEqual(REPARSE_TARGETS);
    });

    test("resolves a named subset to its env vars", () => {
        const sel = resolveReparseTargets("claude,git");
        expect(sel.targets).toEqual(["claude", "git"]);
        expect(sel.envVars).toEqual(["AX_REDERIVE_CLAUDE", "AX_REDERIVE_GIT"]);
    });

    test("tolerates spacing, case and duplicates", () => {
        const sel = resolveReparseTargets(" Claude , claude,  GIT ");
        expect(sel.targets).toEqual(["claude", "git"]);
    });

    test("reports unknown names instead of silently ignoring them", () => {
        const sel = resolveReparseTargets("cluade,git");
        expect(sel.unknown).toEqual(["cluade"]);
        expect(sel.targets).toEqual(["git"]);
    });

    test("every target maps to a distinct AX_REDERIVE_* var", () => {
        const vars = REPARSE_TARGETS.map((t) => REPARSE_TARGET_ENV[t]);
        expect(new Set(vars).size).toBe(vars.length);
        for (const v of vars) expect(v).toStartWith("AX_REDERIVE_");
    });

    test("otel-spool is a known target (G: registers the otel-spool ingest stage)", () => {
        expect(REPARSE_TARGET_ENV["otel-spool"]).toBe("AX_REDERIVE_OTEL_SPOOL");
        const sel = resolveReparseTargets("otel-spool");
        expect(sel.targets).toEqual(["otel-spool"]);
        expect(sel.envVars).toEqual(["AX_REDERIVE_OTEL_SPOOL"]);
        expect(sel.unknown).toEqual([]);
    });
});

describe("applyReparseSelection", () => {
    test("sets each env var to 1 on the given env", () => {
        const env: Record<string, string | undefined> = {};
        applyReparseSelection(resolveReparseTargets("claude"), env);
        expect(env).toEqual({ AX_REDERIVE_CLAUDE: "1" });
    });

    test("leaves unrelated vars untouched", () => {
        const env: Record<string, string | undefined> = { PATH: "/bin" };
        applyReparseSelection(resolveReparseTargets("git"), env);
        expect(env.PATH).toBe("/bin");
        expect(env.AX_REDERIVE_GIT).toBe("1");
        expect(env.AX_REDERIVE_CLAUDE).toBeUndefined();
    });
});
