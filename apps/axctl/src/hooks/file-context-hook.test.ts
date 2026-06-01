import { describe, expect, test } from "bun:test";
import {
    parseFileContextHookFlags,
    parseFileContextHookStdin,
    renderFileMemoryBlock,
    shouldInjectFileMemory,
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
