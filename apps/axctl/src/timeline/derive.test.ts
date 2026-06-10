import { describe, expect, it } from "bun:test";
import {
    buildTimeline,
    deriveCheckpointEvents,
    deriveDecisionEvents,
    deriveFailureEvents,
    deriveFileEvents,
    deriveToolEvents,
    editDelta,
    pairRecoveries,
    shellTitle,
    type TimelineInputs,
} from "./derive.ts";
import type { ToolCallRow, EditRow } from "./queries.ts";

const tc = (over: Partial<ToolCallRow>): ToolCallRow => ({
    seq: 0, ts: "2026-06-07T00:00:00Z", name: "Bash", command_norm: null,
    command_text: null, output_excerpt: null, error_text: null, has_error: false, call_id: null, ...over,
});
const NO_EDGES = new Set<number>();

describe("deriveToolEvents", () => {
    it("keeps notable successes, drops errors and read-noise", () => {
        const events = deriveToolEvents([
            tc({ seq: 1, name: "Bash", command_norm: "bun test" }),
            tc({ seq: 2, name: "Read" }), // noise -> dropped
            tc({ seq: 3, name: "Bash", command_norm: "x", has_error: true }), // error -> failure, not here
        ], "claude", NO_EDGES);
        expect(events.map((e) => e.title)).toEqual(["bun test"]);
        expect(events[0]?.kind).toBe("tool_call");
        expect(events[0]?.status).toBe("ok");
    });

    it("surfaces codex exec_command as a tool (provider-aware)", () => {
        const events = deriveToolEvents([
            tc({ seq: 1, name: "exec_command", command_norm: "git status" }),
        ], "codex", NO_EDGES);
        expect(events[0]?.kind).toBe("tool_call");
        expect(events[0]?.title).toBe("git status");
    });

    it("classifies a codex shell edit (sed) as file_edit", () => {
        const events = deriveToolEvents([
            tc({ seq: 1, name: "exec_command", command_norm: "sed", command_text: "sed -i s/a/b/ x.ts" }),
        ], "codex", NO_EDGES);
        expect(events[0]?.kind).toBe("file_edit");
    });

    it("lets the edited edge own claude file edits (skips tool_call dupes)", () => {
        const events = deriveToolEvents([
            tc({ seq: 5, name: "Edit" }),
        ], "claude", new Set([5]));
        expect(events).toHaveLength(0); // seq 5 covered by the edge
    });

    it("does not classify claude Bash heredocs/redirects as file edits", () => {
        const events = deriveToolEvents([
            tc({ seq: 1, name: "Bash", command_norm: "git add", command_text: '{"command": "git add -A && echo done > /tmp/log"}' }),
            tc({ seq: 2, name: "Bash", command_norm: "bun run", command_text: '{"command": "bun run x <<\'EOF\'\\n...\\nEOF"}' }),
        ], "claude", NO_EDGES);
        expect(events.map((e) => e.kind)).toEqual(["tool_call", "tool_call"]);
    });

    it("titles wrapper commands (echo) with the real pipeline segment + intent", () => {
        const events = deriveToolEvents([
            tc({
                seq: 3,
                name: "Bash",
                command_norm: "echo",
                command_text: '{"command": "echo ===; bun run typecheck 2>&1", "description": "Typecheck the CLI"}',
            }),
        ], "claude", NO_EDGES);
        expect(events[0]?.title).toBe("bun run typecheck 2>&1 - Typecheck the CLI");
    });

    it("titles Agent dispatches with the description, not the bare tool name", () => {
        const events = deriveToolEvents([
            tc({ seq: 7, name: "Agent", command_text: '{"description": "Implement Task 3: stage registry", "prompt": "You are imp' }),
            tc({ seq: 8, name: "Agent", command_text: '{"subagent_type": "general-purpose", "prompt": "Review th' }),
            tc({ seq: 9, name: "Agent" }), // no input captured -> bare name
        ], "claude", NO_EDGES);
        expect(events.map((e) => e.title)).toEqual([
            "Agent: Implement Task 3: stage registry",
            "Agent: general-purpose",
            "Agent",
        ]);
    });
});

describe("editDelta + deriveFileEvents", () => {
    it("counts +/- lines from Edit and Write inputs", () => {
        expect(editDelta("Edit", JSON.stringify({ old_string: "a\nb\nc", new_string: "a\nB" })))
            .toEqual({ added: 2, removed: 3 });
        expect(editDelta("Write", JSON.stringify({ content: "l1\nl2\nl3\nl4" })))
            .toEqual({ added: 4, removed: 0 });
        expect(editDelta("Edit", '{"old_string": "trunc')).toBeNull(); // truncated -> no delta
    });

    it("appends +/- to file_edit titles when a delta is known", () => {
        const edits: EditRow[] = [
            { seq: 4, ts: "2026-06-07T00:00:01Z", path: "src/a.ts", edit_kind: "update", tool: "Edit" },
            { seq: 9, ts: "2026-06-07T00:00:02Z", path: "src/b.ts", edit_kind: "update", tool: "Edit" },
        ];
        const events = deriveFileEvents(edits, new Map([[4, { added: 12, removed: 3 }]]));
        expect(events[0]?.title).toBe("src/a.ts  +12/-3");
        expect(events[1]?.title).toBe("src/b.ts");
    });

    it("shellTitle returns null when there is nothing better", () => {
        expect(shellTitle('{"command": "echo hello"}')).toBeNull();
    });
});

describe("deriveFailureEvents", () => {
    it("surfaces has_error rows with the error's first line", () => {
        const events = deriveFailureEvents([
            tc({ seq: 5, name: "Bash", has_error: true, error_text: "Blocked: bad command\nmore" }),
            tc({ seq: 6, name: "Read" }),
        ]);
        expect(events).toHaveLength(1);
        expect(events[0]?.title).toBe("Bash: Blocked: bad command");
        expect(events[0]?.status).toBe("error");
        expect(events[0]?.recovered_by_seq).toBeNull();
    });
});

describe("pairRecoveries", () => {
    it("pairs a failure to the next same-command success within the window", () => {
        const rows = [
            tc({ seq: 10, name: "Bash", command_norm: "bun test", has_error: true, error_text: "fail", call_id: "c10" }),
            tc({ seq: 14, name: "Bash", command_norm: "bun test", has_error: false, call_id: "c14" }),
        ];
        const [failure] = pairRecoveries(deriveFailureEvents(rows), rows, []);
        expect(failure?.recovered_by_seq).toBe(14);
    });

    it("does not pair beyond the recovery window", () => {
        const rows = [
            tc({ seq: 10, name: "Bash", command_norm: "x", has_error: true, call_id: "c10" }),
            tc({ seq: 100, name: "Bash", command_norm: "x", has_error: false, call_id: "c100" }),
        ];
        const [failure] = pairRecoveries(deriveFailureEvents(rows), rows, []);
        expect(failure?.recovered_by_seq).toBeNull();
    });

    it("falls back to an edit on a file named in the error text", () => {
        const rows = [
            tc({ seq: 10, name: "Edit", has_error: true, error_text: "type error in registry.ts", call_id: "c10" }),
        ];
        const edits: EditRow[] = [
            { seq: 12, ts: "2026-06-07T00:01:00Z", path: "src/ingest/registry.ts", edit_kind: "edit", tool: "Edit" },
        ];
        const [failure] = pairRecoveries(deriveFailureEvents(rows), rows, edits);
        expect(failure?.recovered_by_seq).toBe(12);
    });
});

describe("deriveDecisionEvents", () => {
    it("uses summary, else the first plan item, else a fallback", () => {
        const events = deriveDecisionEvents([
            { ts: "2026-06-07T00:00:00Z", summary: "Split into layers", items: null },
            { ts: "2026-06-07T00:01:00Z", summary: null, items: JSON.stringify([{ content: "step one" }, { content: "step two" }]) },
            { ts: "2026-06-07T00:02:00Z", summary: null, items: "not json" },
        ]);
        expect(events.map((e) => e.title)).toEqual(["Split into layers", "step one", "plan updated"]);
        expect(events[1]?.detail).toBe("2 steps");
    });
});

describe("deriveCheckpointEvents", () => {
    it("renders a short sha + commit subject", () => {
        const [e] = deriveCheckpointEvents([
            { ts: "2026-06-07T00:00:00Z", sha: "0febe0dabcdef", message: "release 0.12.0\n\nbody" },
        ]);
        expect(e?.title).toBe("committed 0febe0d · release 0.12.0");
        expect(e?.refs[0]).toEqual({ type: "commit", id: "0febe0dabcdef" });
    });
});

describe("buildTimeline", () => {
    const base: TimelineInputs = {
        sessionId: "s1", source: "claude", health: null, overview: null, cost: null,
        toolCalls: [], edits: [], skills: [], corrections: [], plans: [], commits: [],
        asks: [], compactions: [], lastAssistant: null,
    };

    it("orders events by ts and tallies event_counts", () => {
        const tl = buildTimeline({
            ...base,
            toolCalls: [
                tc({ seq: 2, ts: "2026-06-07T00:00:02Z", command_norm: "second" }),
                tc({ seq: 1, ts: "2026-06-07T00:00:01Z", command_norm: "first" }),
            ],
            commits: [{ ts: "2026-06-07T00:00:03Z", sha: "abc1234", message: "c" }],
        });
        expect(tl.events.map((e) => e.title)).toEqual(["first", "second", "committed abc1234 · c"]);
        expect(tl.highlights.event_counts.tool_call).toBe(2);
        expect(tl.highlights.event_counts.checkpoint).toBe(1);
    });

    it("counts distinct files changed from edits", () => {
        const tl = buildTimeline({
            ...base,
            edits: [
                { seq: 1, ts: "2026-06-07T00:00:01Z", path: "a.ts", edit_kind: "edit", tool: "Edit" },
                { seq: 2, ts: "2026-06-07T00:00:02Z", path: "a.ts", edit_kind: "edit", tool: "Edit" },
                { seq: 3, ts: "2026-06-07T00:00:03Z", path: "b.ts", edit_kind: "write", tool: "Write" },
            ],
        });
        expect(tl.highlights.files_changed).toBe(2);
    });
});
