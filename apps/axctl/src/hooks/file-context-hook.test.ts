import { describe, expect, test } from "bun:test";
import {
    adaptClaudePayload,
    filterSuppressed,
    finalizeInjection,
    generateLookupCandidates,
    isHighSignalSession,
    isSuppressedPath,
    normalizeSessionId,
    parseFileContextHookFlags,
    parseFileContextHookStdin,
    renderFileMemoryBlock,
    shouldInjectFileMemory,
    type FileContextHookDecision,
} from "./file-context-hook.ts";

interface PriorSessionInit {
    readonly session?: string;
    readonly title?: string | null;
    readonly weight?: number;
    readonly files_touched?: number;
    readonly produced_commits?: number;
    readonly user_turns?: number;
    readonly assistant_turns?: number;
    readonly corrections?: number;
    readonly interruptions?: number;
    readonly merged_to_main?: boolean;
    readonly delivery_status?: string | null;
    readonly review_pain?: string | null;
}

function priorSession(init: PriorSessionInit = {}) {
    return {
        session: init.session ?? "session:abc",
        title: init.title ?? "knowledge route tab bug",
        project: null,
        source: "claude",
        weight: init.weight ?? 5,
        files_touched: init.files_touched ?? 1,
        top_files: [] as readonly string[],
        produced_commits: init.produced_commits ?? 0,
        delivery_status: init.delivery_status ?? null,
        review_pain: init.review_pain ?? null,
        pr_size: null,
        pr_title: null,
        merged_to_main: init.merged_to_main ?? false,
        user_turns: init.user_turns ?? 1,
        assistant_turns: init.assistant_turns ?? 1,
        corrections: init.corrections ?? 0,
        interruptions: init.interruptions ?? 0,
        duration_ms: null,
        hands_free_ms: null,
        last_seen: null,
    };
}

describe("parseFileContextHookFlags", () => {
    test("maps flag values to a hook input", () => {
        const input = parseFileContextHookFlags({
            event: "pre-edit",
            task: "knowledge route tab bug",
            files: ["app/src/routes/_authed/$orgSlug/knowledge/route.tsx"],
            sessionId: "session:abc",
            format: "claude",
        });

        expect(input).toEqual({
            event: "pre-edit",
            task: "knowledge route tab bug",
            files: ["app/src/routes/_authed/$orgSlug/knowledge/route.tsx"],
            sessionId: "session:abc",
            format: "claude",
        });
    });

    test("defaults unknown event and missing fields", () => {
        const input = parseFileContextHookFlags({});
        expect(input.event).toBe("unknown");
        expect(input.task).toBe("");
        expect(input.files).toEqual([]);
        expect(input.sessionId).toBeUndefined();
        expect(input.format).toBe("plain");
    });
});

describe("parseFileContextHookStdin", () => {
    test("parses generic JSON with file + task + event", () => {
        const input = parseFileContextHookStdin(JSON.stringify({
            event: "pre-edit",
            task: "fix bug",
            file: "src/a.ts",
            session_id: "session:abc",
        }));

        expect(input.event).toBe("pre-edit");
        expect(input.task).toBe("fix bug");
        expect(input.files).toEqual(["src/a.ts"]);
        expect(input.sessionId).toBe("session:abc");
    });

    test("parses JSON with files array", () => {
        const input = parseFileContextHookStdin(JSON.stringify({
            event: "search",
            task: "find usages",
            files: ["src/a.ts", "src/b.ts"],
        }));
        expect(input.files).toEqual(["src/a.ts", "src/b.ts"]);
        expect(input.event).toBe("search");
    });

    test("parses Claude Code PreToolUse Edit payload and prefixes session id", () => {
        const input = parseFileContextHookStdin(JSON.stringify({
            session_id: "abc-123",
            transcript_path: "/Users/x/.claude/projects/p/session.jsonl",
            cwd: "/repo",
            hook_event_name: "PreToolUse",
            tool_name: "Edit",
            tool_input: { file_path: "src/a.ts", old_string: "x", new_string: "y" },
        }));
        expect(input.event).toBe("pre-edit");
        expect(input.files).toEqual(["src/a.ts"]);
        // Claude's `session_id` is a bare UUID; adapter must add `session:`.
        expect(input.sessionId).toBe("session:abc-123");
    });

    test("maps Claude Read to event=read", () => {
        const input = parseFileContextHookStdin(JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: "Read",
            tool_input: { file_path: "src/a.ts" },
        }));
        expect(input.event).toBe("read");
        expect(input.files).toEqual(["src/a.ts"]);
    });

    test("maps Claude Grep to event=search", () => {
        const input = parseFileContextHookStdin(JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: "Grep",
            tool_input: { pattern: "foo" },
        }));
        expect(input.event).toBe("search");
        expect(input.files).toEqual([]);
    });

    test("maps Claude MultiEdit to pre-edit with file_path", () => {
        const input = parseFileContextHookStdin(JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: "MultiEdit",
            tool_input: { file_path: "src/b.ts", edits: [] },
        }));
        expect(input.event).toBe("pre-edit");
        expect(input.files).toEqual(["src/b.ts"]);
    });

    test("unknown Claude tool maps to event=unknown", () => {
        const input = parseFileContextHookStdin(JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: { command: "ls" },
        }));
        expect(input.event).toBe("unknown");
    });
});

describe("shouldInjectFileMemory", () => {
    test("suppresses lockfiles", () => {
        const result = shouldInjectFileMemory({
            files: ["bun.lock"],
            priorFileSessions: [priorSession({ weight: 10, corrections: 5 })],
        });
        expect(result.inject).toBe(false);
        expect(result.reason).toBe("suppressed_path");
    });

    test("suppresses node_modules paths", () => {
        const result = shouldInjectFileMemory({
            files: ["node_modules/foo/index.js"],
            priorFileSessions: [priorSession({ weight: 10, corrections: 5 })],
        });
        expect(result.inject).toBe(false);
        expect(result.reason).toBe("suppressed_path");
    });

    test("suppresses generated route trees", () => {
        const result = shouldInjectFileMemory({
            files: ["app/src/routeTree.gen.ts"],
            priorFileSessions: [priorSession({ weight: 10, corrections: 5 })],
        });
        expect(result.inject).toBe(false);
        expect(result.reason).toBe("suppressed_path");
    });

    test("suppresses when no prior file sessions", () => {
        const result = shouldInjectFileMemory({
            files: ["src/a.ts"],
            priorFileSessions: [],
        });
        expect(result.inject).toBe(false);
        expect(result.reason).toBe("no_prior_sessions");
    });

    test("suppresses when only low-signal sessions", () => {
        const result = shouldInjectFileMemory({
            files: ["src/a.ts"],
            priorFileSessions: [
                priorSession({ weight: 1, corrections: 0, produced_commits: 0, merged_to_main: false, review_pain: null }),
            ],
        });
        expect(result.inject).toBe(false);
        expect(result.reason).toBe("low_signal_only");
    });

    test("injects when prior session has weight>=3", () => {
        const result = shouldInjectFileMemory({
            files: ["src/a.ts"],
            priorFileSessions: [priorSession({ weight: 3 })],
        });
        expect(result.inject).toBe(true);
    });

    test("injects when prior session has corrections>0", () => {
        const result = shouldInjectFileMemory({
            files: ["src/a.ts"],
            priorFileSessions: [priorSession({ weight: 1, corrections: 1 })],
        });
        expect(result.inject).toBe(true);
    });

    test("injects when prior session merged_to_main", () => {
        const result = shouldInjectFileMemory({
            files: ["src/a.ts"],
            priorFileSessions: [priorSession({ weight: 1, merged_to_main: true })],
        });
        expect(result.inject).toBe(true);
    });

    test("injects when prior session produced commits", () => {
        const result = shouldInjectFileMemory({
            files: ["src/a.ts"],
            priorFileSessions: [priorSession({ weight: 1, produced_commits: 1 })],
        });
        expect(result.inject).toBe(true);
    });

    test("suppresses when alreadyInjectedPaths covers all usable files", () => {
        const result = shouldInjectFileMemory({
            files: ["src/a.ts"],
            priorFileSessions: [priorSession({ weight: 10, corrections: 5 })],
            alreadyInjectedPaths: new Set(["src/a.ts"]),
        });
        expect(result.inject).toBe(false);
        expect(result.reason).toBe("session_already_injected");
    });

    test("injects when alreadyInjectedPaths covers some but not all files", () => {
        const result = shouldInjectFileMemory({
            files: ["src/a.ts", "src/b.ts"],
            priorFileSessions: [priorSession({ weight: 10 })],
            alreadyInjectedPaths: new Set(["src/a.ts"]),
        });
        expect(result.inject).toBe(true);
    });

    test("suppressed_path still wins over session_already_injected", () => {
        const result = shouldInjectFileMemory({
            files: ["bun.lock"],
            priorFileSessions: [priorSession({ weight: 10 })],
            alreadyInjectedPaths: new Set(["bun.lock"]),
        });
        expect(result.inject).toBe(false);
        expect(result.reason).toBe("suppressed_path");
    });
});

describe("renderFileMemoryBlock", () => {
    test("renders a corrections-first block with refs and dig-deeper footer", () => {
        const block = renderFileMemoryBlock({
            filePath: "src/cli/install.ts",
            priorFileSessions: [],
            corrections: [
                {
                    turn_id: "turn:01h2k7abc",
                    session_id: "session:01g9z4xyz",
                    ts: "2026-03-12T10:00:00.000Z",
                    text: "no don't mock the DB here, last time it masked the migration bug",
                    delivery_status: "merged_to_main",
                    pr_title: "Codex ingest fix",
                },
            ],
            commits: [
                {
                    commit_id: "commit:ab12cd34",
                    sha: "ab12cd34deadbeef",
                    message: "fix: install.ts daemon start race",
                    ts: "2026-05-10T12:00:00.000Z",
                },
            ],
            coTouched: [
                { path: "schema/schema.surql", co_sessions: 8, total_sessions: 10 },
            ],
        });

        expect(block.startsWith("<ax_file_memory>")).toBe(true);
        expect(block.endsWith("</ax_file_memory>")).toBe(true);
        expect(block).toContain("File: src/cli/install.ts");
        expect(block).toContain("Corrections targeting this file (1):");
        expect(block).toContain('"no don\'t mock the DB here, last time it masked the migration bug"');
        expect(block).toContain("ref: turn:01h2k7abc · session:01g9z4xyz · 2026-03-12 · merged_to_main · pr \"Codex ingest fix\"");
        expect(block).toContain("Recent commits touching this file:");
        expect(block).toContain('ab12cd34de  "fix: install.ts daemon start race"  (2026-05-10)');
        expect(block).toContain("Co-touched files");
        expect(block).toContain("schema/schema.surql (8/10)");
        expect(block).toContain("Dig deeper:");
    });

    test("falls back to session list only when no concrete signals exist", () => {
        const block = renderFileMemoryBlock({
            filePath: "src/a.ts",
            priorFileSessions: [priorSession({ title: "previous work", weight: 5, produced_commits: 1 })],
            corrections: [],
            commits: [],
            coTouched: [],
        });
        expect(block).toContain("Prior sessions touching this file (no specific corrections recorded):");
        expect(block).toContain('"previous work"');
        // No "Dig deeper" footer when nothing concrete to dig into.
        expect(block).not.toContain("Dig deeper:");
    });

    test("returns an empty string when no evidence is present", () => {
        const block = renderFileMemoryBlock({
            filePath: "src/a.ts",
            priorFileSessions: [],
            corrections: [],
            commits: [],
            coTouched: [],
        });
        expect(block).toBe("");
    });
});

// ---------------------------------------------------------------------------
// isSuppressedPath - characterization tests
// ---------------------------------------------------------------------------
describe("isSuppressedPath", () => {
    test("empty string is suppressed", () => {
        expect(isSuppressedPath("")).toBe(true);
    });

    test("lockfile basenames are suppressed", () => {
        expect(isSuppressedPath("bun.lock")).toBe(true);
        expect(isSuppressedPath("package-lock.json")).toBe(true);
        expect(isSuppressedPath("yarn.lock")).toBe(true);
        expect(isSuppressedPath("pnpm-lock.yaml")).toBe(true);
        expect(isSuppressedPath("go.sum")).toBe(true);
    });

    test("lockfile inside a subdir: basename match still fires", () => {
        expect(isSuppressedPath("repo/packages/bun.lock")).toBe(true);
    });

    test("node_modules/ substring suppresses", () => {
        expect(isSuppressedPath("/repo/node_modules/lodash/index.js")).toBe(true);
    });

    test("relative path with node_modules/ suppresses via leading-slash normalization", () => {
        // relative "node_modules/foo" → normalized to "/node_modules/foo" which matches
        expect(isSuppressedPath("node_modules/foo/index.js")).toBe(true);
    });

    test("dist/ substring suppresses", () => {
        expect(isSuppressedPath("/repo/dist/index.js")).toBe(true);
    });

    test(".gen.ts suffix suppresses", () => {
        expect(isSuppressedPath("src/routeTree.gen.ts")).toBe(true);
        expect(isSuppressedPath("apps/site/routeTree.gen.ts")).toBe(true);
    });

    test(".map suffix suppresses", () => {
        expect(isSuppressedPath("dist/bundle.js.map")).toBe(true);
    });

    test(".min.js suffix suppresses", () => {
        expect(isSuppressedPath("public/vendor.min.js")).toBe(true);
    });

    test("ordinary source file is not suppressed", () => {
        expect(isSuppressedPath("src/a.ts")).toBe(false);
        expect(isSuppressedPath("/repo/apps/axctl/src/cli/index.ts")).toBe(false);
    });

    test("path containing 'dist' in a component name is not suppressed", () => {
        // Only the /dist/ substring (with surrounding slashes) suppresses, not any 'dist' occurrence
        expect(isSuppressedPath("src/distribute.ts")).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// filterSuppressed - delegates correctly
// ---------------------------------------------------------------------------
describe("filterSuppressed", () => {
    test("removes suppressed paths, keeps unsuppressed ones", () => {
        const result = filterSuppressed(["src/a.ts", "bun.lock", "node_modules/x/y.js", "src/b.ts"]);
        expect(result).toEqual(["src/a.ts", "src/b.ts"]);
    });

    test("empty input returns empty array", () => {
        expect(filterSuppressed([])).toEqual([]);
    });

    test("all suppressed returns empty array", () => {
        expect(filterSuppressed(["bun.lock", "dist/index.js"])).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// normalizeSessionId
// ---------------------------------------------------------------------------
describe("normalizeSessionId", () => {
    test("null input returns null", () => {
        expect(normalizeSessionId(null)).toBeNull();
    });

    test("bare UUID gets prefixed with session:", () => {
        expect(normalizeSessionId("abc-def-123")).toBe("session:abc-def-123");
    });

    test("already-prefixed id is returned as-is", () => {
        expect(normalizeSessionId("session:abc-def-123")).toBe("session:abc-def-123");
    });

    test("other table prefixes are passed through", () => {
        expect(normalizeSessionId("turn:xyz")).toBe("turn:xyz");
    });
});

// ---------------------------------------------------------------------------
// generateLookupCandidates - includes undertested relative-path case
// ---------------------------------------------------------------------------
describe("generateLookupCandidates", () => {
    test("null cwd returns []", () => {
        expect(generateLookupCandidates("/repo/src/a.ts", null)).toEqual([]);
    });

    test("relative filePath (no leading slash) does not match any cwd → returns []", () => {
        // This is the undertested case flagged by the spec: the existing test at
        // line 103 uses "src/a.ts" with cwd "/repo" and never asserts lookupPaths.
        // "src/a.ts".startsWith("/repo/") is false → [].
        expect(generateLookupCandidates("src/a.ts", "/repo")).toEqual([]);
    });

    test("path that does not start with cwd prefix returns []", () => {
        expect(generateLookupCandidates("/other/src/a.ts", "/repo")).toEqual([]);
    });

    test("absolute path with matching cwd returns cwd-relative path", () => {
        const candidates = generateLookupCandidates("/repo/src/a.ts", "/repo");
        expect(candidates).toContain("src/a.ts");
    });

    test("monorepo: absolute path returns up to 4 parent-stripped candidates", () => {
        // /a/b/c/d/e.ts with cwd /a/b/c yields: d/e.ts, b/c/d/e.ts, a/b/c/d/e.ts ... up to 3 parent climbs
        const candidates = generateLookupCandidates("/a/b/c/d/e.ts", "/a/b/c");
        expect(candidates).toContain("d/e.ts");
        // parent climb: /a/b → a/b/c/d/e.ts (if it still startsWith)... etc.
        // Actually /a/b is shorter than /a/b/c so /a/b/c/d/e.ts starts with /a/b/
        expect(candidates).toContain("c/d/e.ts");
        // No duplicates
        expect(new Set(candidates).size).toBe(candidates.length);
    });

    test("deep monorepo: all candidates are distinct sub-paths of the file", () => {
        const filePath = "/Users/necmttn/Projects/ax/apps/axctl/src/hooks/file-context-hook.ts";
        const cwd = "/Users/necmttn/Projects/ax/apps/axctl";
        const candidates = generateLookupCandidates(filePath, cwd);
        // Closest: src/hooks/file-context-hook.ts
        expect(candidates[0]).toBe("src/hooks/file-context-hook.ts");
        // All entries must be relative (no leading slash)
        expect(candidates.every((c) => !c.startsWith("/"))).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// adaptClaudePayload - includes lookupPaths assertion
// ---------------------------------------------------------------------------
describe("adaptClaudePayload", () => {
    test("Edit tool_name maps to pre-edit event", () => {
        const out = adaptClaudePayload({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "/repo/src/a.ts" } });
        expect(out.event).toBe("pre-edit");
    });

    test("Write tool_name maps to pre-edit event", () => {
        const out = adaptClaudePayload({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "/repo/src/a.ts" } });
        expect(out.event).toBe("pre-edit");
    });

    test("MultiEdit tool_name maps to pre-edit event", () => {
        const out = adaptClaudePayload({ hook_event_name: "PreToolUse", tool_name: "MultiEdit", tool_input: { file_path: "/repo/src/a.ts" } });
        expect(out.event).toBe("pre-edit");
    });

    test("bare UUID session_id is prefixed with session:", () => {
        const out = adaptClaudePayload({ hook_event_name: "PreToolUse", tool_name: "Edit", session_id: "uuid-123", tool_input: { file_path: "/f.ts" } });
        expect(out.sessionId).toBe("session:uuid-123");
    });

    test("already-prefixed session_id is passed through unchanged", () => {
        const out = adaptClaudePayload({ hook_event_name: "PreToolUse", tool_name: "Edit", session_id: "session:uuid-123", tool_input: { file_path: "/f.ts" } });
        expect(out.sessionId).toBe("session:uuid-123");
    });

    test("missing tool_input → empty files and empty lookupPaths", () => {
        const out = adaptClaudePayload({ hook_event_name: "PreToolUse", tool_name: "Edit" });
        expect(out.files).toEqual([]);
        expect(out.lookupPaths).toEqual([]);
    });

    test("absolute file_path + cwd generates lookupPaths (not empty)", () => {
        const out = adaptClaudePayload({
            hook_event_name: "PreToolUse",
            tool_name: "Edit",
            session_id: "uuid-abc",
            cwd: "/repo",
            tool_input: { file_path: "/repo/apps/axctl/src/a.ts" },
        });
        expect(out.files).toEqual(["/repo/apps/axctl/src/a.ts"]);
        // lookupPaths must contain the cwd-relative path
        expect(out.lookupPaths).toContain("apps/axctl/src/a.ts");
    });

    test("relative file_path produces empty lookupPaths (cwd-prefix miss)", () => {
        // This pins the behaviour the original test at line 103 left unasserted.
        const out = adaptClaudePayload({
            hook_event_name: "PreToolUse",
            tool_name: "Edit",
            cwd: "/repo",
            tool_input: { file_path: "src/a.ts" },  // relative - no leading /
        });
        expect(out.files).toEqual(["src/a.ts"]);
        expect(out.lookupPaths).toEqual([]);  // generateLookupCandidates returns [] for relative paths
    });

    test("format is always claude", () => {
        const out = adaptClaudePayload({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/f.ts" } });
        expect(out.format).toBe("claude");
    });
});

// ---------------------------------------------------------------------------
// isHighSignalSession - boundary conditions
// ---------------------------------------------------------------------------
describe("isHighSignalSession", () => {
    const base = {
        session: "session:abc",
        title: null,
        project: null,
        source: "claude",
        weight: 1,
        files_touched: 1,
        top_files: [] as readonly string[],
        produced_commits: 0,
        delivery_status: null,
        review_pain: null,
        pr_size: null,
        pr_title: null,
        merged_to_main: false,
        user_turns: 1,
        assistant_turns: 1,
        corrections: 0,
        interruptions: 0,
        duration_ms: null,
        hands_free_ms: null,
        last_seen: null,
    };

    test("weight < 3, no other signals → false", () => {
        expect(isHighSignalSession({ ...base, weight: 2 })).toBe(false);
    });

    test("weight exactly 3 → true", () => {
        expect(isHighSignalSession({ ...base, weight: 3 })).toBe(true);
    });

    test("weight > 3 → true", () => {
        expect(isHighSignalSession({ ...base, weight: 10 })).toBe(true);
    });

    test("corrections > 0 → true regardless of weight", () => {
        expect(isHighSignalSession({ ...base, weight: 1, corrections: 1 })).toBe(true);
    });

    test("produced_commits > 0 → true", () => {
        expect(isHighSignalSession({ ...base, produced_commits: 1 })).toBe(true);
    });

    test("merged_to_main → true", () => {
        expect(isHighSignalSession({ ...base, merged_to_main: true })).toBe(true);
    });

    test("review_pain non-empty string → true", () => {
        expect(isHighSignalSession({ ...base, review_pain: "it was rough" })).toBe(true);
    });

    test("review_pain empty string → false (falsy check)", () => {
        expect(isHighSignalSession({ ...base, review_pain: "" })).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// finalizeInjection - contract for both branches
// ---------------------------------------------------------------------------
describe("finalizeInjection", () => {
    const injectDecision: FileContextHookDecision = { inject: true, reason: "high_signal" };
    const noInjectDecision: FileContextHookDecision = { inject: false, reason: "no_prior_sessions" };

    test("inject:true + non-empty rendered → inject:true, reason=decision.reason", () => {
        const result = finalizeInjection(injectDecision, "<ax_file_memory>some content</ax_file_memory>");
        expect(result.inject).toBe(true);
        expect(result.reason).toBe("high_signal");
    });

    test("inject:true + empty rendered → inject:false, reason='empty_render'", () => {
        // This is the defensive branch: shouldInjectFileMemory said inject:true but
        // renderFileMemoryBlock returned "". Keep as defensive - whether this can
        // happen in practice is an open question, but the contract is mandatory.
        const result = finalizeInjection(injectDecision, "");
        expect(result.inject).toBe(false);
        expect(result.reason).toBe("empty_render");
    });

    test("inject:false + empty rendered → inject:false, reason=decision.reason (no override)", () => {
        const result = finalizeInjection(noInjectDecision, "");
        expect(result.inject).toBe(false);
        expect(result.reason).toBe("no_prior_sessions");
    });

    test("inject:false + non-empty rendered → still inject:false (rendered irrelevant when decision=false)", () => {
        // rendered is only non-empty when decision.inject was true, but the pure fn
        // doesn't depend on that invariant holding - it gates correctly either way.
        const result = finalizeInjection(noInjectDecision, "some content");
        expect(result.inject).toBe(false);
        expect(result.reason).toBe("no_prior_sessions");
    });
});
