import { describe, expect, test } from "bun:test";
import {
    buildSessionMapLanes,
    fetchShareArtifact,
    fetchShareFile,
    fetchShareManifest,
    gistRawUrl,
    inspectPayloadFromShare,
    isShareManifest,
    rawSessionFileUrl,
    SESSION_MAP_MIN_LANE_W,
    spanKindForShareTurn,
    type ShareManifest,
    type ShareSubagentCard,
} from "./share-inspect.tsx";

type ShareTurn = Parameters<typeof spanKindForShareTurn>[0];

function turn(partial: Partial<ShareTurn>): ShareTurn {
    return {
        id: "turn:test",
        seq: 1,
        role: "user",
        text: "hello",
        ...partial,
    };
}

describe("spanKindForShareTurn", () => {
    test("uses intent_kind to keep slash-command wrappers out of user input", () => {
        expect(spanKindForShareTurn(turn({
            message_kind: "task",
            intent_kind: "wrapper_instruction",
            text: "## Your task\nReview the diff.",
        }))).toBe("wrapper_instruction");
    });

    test("uses intent_kind to preserve skill context exported as user role rows", () => {
        expect(spanKindForShareTurn(turn({
            message_kind: "context",
            intent_kind: "skill_context",
            text: "Base directory for this skill: ~/.claude/skills/review-all",
        }))).toBe("skill_context");
    });

    test("plain user tasks remain user input", () => {
        expect(spanKindForShareTurn(turn({
            message_kind: "task",
            intent_kind: "organic_task",
            text: "lets run review all command",
        }))).toBe("user_input");
    });
});

describe("fetchShareArtifact", () => {
    test("loads ax-session.json directly from gist raw content", async () => {
        const calls: string[] = [];
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            calls.push(String(input));
            return new Response(JSON.stringify({
                schema_version: 1,
                exported_at: "2026-05-31T00:00:00.000Z",
                session: { id: "session-1", source: "codex" },
                stats: {
                    turns: 1,
                    tool_calls: 0,
                    files_changed: 0,
                    skills_used: 0,
                    failures: 0,
                },
                turns: [{
                    id: "turn-1",
                    seq: 1,
                    role: "user",
                    text: "hello",
                }],
            }), {
                headers: { "content-type": "application/json" },
            });
        }) as typeof fetch;

        try {
            const artifact = await fetchShareArtifact("Necmttn", "abc123");

            expect(artifact.session.id).toBe("session-1");
            expect(calls).toEqual([rawSessionFileUrl("Necmttn", "abc123")]);
            expect(calls[0]).not.toContain("api.github.com");
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});

describe("isShareManifest", () => {
    test("accepts a v3 manifest, rejects a session artifact", () => {
        expect(isShareManifest({
            schema_version: 3,
            kind: "manifest",
            session: { id: "s1", source: "claude" },
            totals: { cost_usd: null, duration_ms: null, tool_calls: 0, turns: 0, subagents: 0, failures: 0 },
            root_file: "session.json",
            subagents: [],
        })).toBe(true);
        expect(isShareManifest({ schema_version: 3, session: { id: "s1" }, turns: [] })).toBe(false);
    });

    test("accepts a v4 manifest (current CLI export version)", () => {
        expect(isShareManifest({
            schema_version: 4,
            kind: "manifest",
            session: { id: "s1", source: "claude" },
            totals: { cost_usd: null, duration_ms: null, tool_calls: 0, turns: 0, subagents: 0, failures: 0 },
            root_file: "session.json",
            subagents: [],
        })).toBe(true);
        expect(isShareManifest({ schema_version: 5, kind: "manifest", session: { id: "s1" }, totals: {}, root_file: "session.json", subagents: [] })).toBe(false);
    });
});

describe("fetchShareManifest", () => {
    const withFetch = async (
        handler: (url: string) => Response,
        run: () => Promise<void>,
    ) => {
        const original = globalThis.fetch;
        globalThis.fetch = (async (input: RequestInfo | URL) => handler(String(input))) as typeof fetch;
        try {
            await run();
        } finally {
            globalThis.fetch = original;
        }
    };

    test("fetches index.json from gist raw content", async () => {
        const manifest = {
            schema_version: 3,
            kind: "manifest",
            exported_at: "2026-06-01T00:00:00.000Z",
            session: { id: "root1", source: "claude" },
            stats: { turns: 1, tool_calls: 0, files_changed: 0, skills_used: 0, failures: 0 },
            root_file: "session.json",
            totals: { cost_usd: 1.5, duration_ms: 1000, tool_calls: 0, turns: 1, subagents: 1, failures: 0 },
            subagents: [],
        };
        await withFetch(
            (url) => {
                expect(url).toBe(gistRawUrl("Necmttn", "abc123", "index.json"));
                return new Response(JSON.stringify(manifest), { headers: { "content-type": "application/json" } });
            },
            async () => {
                const result = await fetchShareManifest("Necmttn", "abc123");
                expect(result?.totals.cost_usd).toBe(1.5);
                expect(result?.root_file).toBe("session.json");
            },
        );
    });

    test("returns null for a legacy gist with no manifest (404)", async () => {
        await withFetch(
            () => new Response("Not Found", { status: 404 }),
            async () => {
                expect(await fetchShareManifest("Necmttn", "legacy")).toBeNull();
            },
        );
    });

    test("fetchShareFile loads a named subagent file", async () => {
        await withFetch(
            (url) => {
                expect(url).toBe(gistRawUrl("Necmttn", "abc123", "subagent-x.json"));
                return new Response(JSON.stringify({
                    schema_version: 3,
                    exported_at: "2026-06-01T00:00:00.000Z",
                    session: { id: "claude-subagent-x", source: "claude-subagent" },
                    stats: { turns: 2, tool_calls: 0, files_changed: 0, skills_used: 0, failures: 0 },
                    turns: [],
                }), { headers: { "content-type": "application/json" } });
            },
            async () => {
                const artifact = await fetchShareFile("Necmttn", "abc123", "subagent-x.json");
                expect(artifact.session.id).toBe("claude-subagent-x");
                expect(artifact.schema_version).toBe(3);
            },
        );
    });
});

const mapStats = (failures = 0): ShareSubagentCard["stats"] => ({
    turns: 1,
    tool_calls: 0,
    files_changed: 0,
    skills_used: 0,
    failures,
});

function mapCard(partial: Partial<ShareSubagentCard> & { readonly file: string }): ShareSubagentCard {
    return {
        id: `claude-subagent-${partial.file}`,
        parent_id: "root-1",
        depth: 1,
        spawn_turn_seq: null,
        source: "claude-subagent",
        duration_ms: null,
        stats: mapStats(),
        cost_usd: null,
        estimated_tokens: null,
        had_error: false,
        ...partial,
    };
}

function mapManifest(
    subagents: ReadonlyArray<ShareSubagentCard>,
    session: Partial<ShareManifest["session"]> = {},
    totals: Partial<ShareManifest["totals"]> = {},
): ShareManifest {
    return {
        schema_version: 4,
        kind: "manifest",
        exported_at: "2026-06-01T02:00:00.000Z",
        session: { id: "root-1", source: "claude", ...session },
        stats: mapStats(),
        root_file: "session.json",
        totals: {
            cost_usd: null,
            duration_ms: null,
            tool_calls: 0,
            turns: 0,
            subagents: subagents.length,
            failures: 0,
            ...totals,
        },
        subagents,
    };
}

const laneFor = (model: ReturnType<typeof buildSessionMapLanes>, file: string) => {
    const lane = model?.lanes.find((l) => l.file === file);
    if (!lane) throw new Error(`no lane for ${file}`);
    return lane;
};

describe("buildSessionMapLanes", () => {
    test("places by spawn_turn_seq normalized over the seq range when every card has one", () => {
        // Wide bars keep the strip covered so gap compression stays out of
        // this test's way.
        const model = buildSessionMapLanes(mapManifest([
            mapCard({ file: "a.json", spawn_turn_seq: 0, duration_ms: 1000 }),
            mapCard({ file: "b.json", spawn_turn_seq: 25, duration_ms: 1000 }),
            mapCard({ file: "c.json", spawn_turn_seq: 50, duration_ms: 1000 }),
            mapCard({ file: "d.json", spawn_turn_seq: 75, duration_ms: 1000 }),
            mapCard({ file: "e.json", spawn_turn_seq: 100, duration_ms: 1000 }),
        ]));
        expect(model?.axis).toBe("seq");
        expect(model?.gaps).toHaveLength(0);
        const a = laneFor(model, "a.json");
        const c = laneFor(model, "c.json");
        const e = laneFor(model, "e.json");
        expect(a.x).toBeCloseTo(0, 5);
        expect(c.x).toBeCloseTo(0.5, 5);
        // The last bar is clamped so it stays inside the strip.
        expect(e.x).toBeCloseTo(1 - e.w, 5);
    });

    test("falls back to start time over the root window when any seq is missing", () => {
        const model = buildSessionMapLanes(mapManifest(
            [
                mapCard({ file: "a.json", spawn_turn_seq: 5, started_at: "2026-06-01T00:00:00.000Z", duration_ms: 1_800_000 }),
                mapCard({ file: "b.json", started_at: "2026-06-01T00:30:00.000Z", duration_ms: 900_000 }),
                mapCard({ file: "c.json", started_at: "2026-06-01T00:45:00.000Z", duration_ms: 900_000 }),
            ],
            { started_at: "2026-06-01T00:00:00.000Z", ended_at: "2026-06-01T01:00:00.000Z" },
        ));
        expect(model?.axis).toBe("time");
        expect(model?.rootDurationMs).toBe(3_600_000);
        expect(laneFor(model, "a.json").x).toBeCloseTo(0, 5);
        expect(laneFor(model, "b.json").x).toBeCloseTo(0.5, 5);
        expect(laneFor(model, "c.json").x).toBeCloseTo(0.75, 5);
    });

    test("uses root started_at + totals.duration_ms as the window when ended_at is missing", () => {
        const model = buildSessionMapLanes(mapManifest(
            [
                mapCard({ file: "a.json", started_at: "2026-06-01T00:00:00.000Z", duration_ms: 1_800_000 }),
                mapCard({ file: "b.json", started_at: "2026-06-01T00:30:00.000Z", duration_ms: 1_800_000 }),
            ],
            { started_at: "2026-06-01T00:00:00.000Z" },
            { duration_ms: 3_600_000 },
        ));
        expect(model?.axis).toBe("time");
        expect(laneFor(model, "b.json").x).toBeCloseTo(0.5, 5);
    });

    test("falls back to stable even-spaced order when no seqs and no usable root window", () => {
        const model = buildSessionMapLanes(mapManifest([
            mapCard({ file: "a.json" }),
            mapCard({ file: "b.json" }),
            mapCard({ file: "c.json" }),
        ]));
        expect(model?.axis).toBe("order");
        expect(laneFor(model, "a.json").x).toBeCloseTo(0, 5);
        expect(laneFor(model, "b.json").x).toBeCloseTo(1 / 3, 5);
        expect(laneFor(model, "c.json").x).toBeCloseTo(2 / 3, 5);
    });

    test("applies the minimum bar width for null and tiny durations", () => {
        // Filler cards keep every uncovered span under the compression
        // threshold so the raw widths survive untouched.
        const fillers = Array.from({ length: 7 }, (_, i) =>
            mapCard({ file: `filler-${i}.json`, spawn_turn_seq: i + 3 }));
        const model = buildSessionMapLanes(mapManifest(
            [
                mapCard({ file: "half.json", spawn_turn_seq: 0, duration_ms: 1_800_000 }),
                mapCard({ file: "tiny.json", spawn_turn_seq: 1, duration_ms: 1 }),
                mapCard({ file: "null.json", spawn_turn_seq: 2 }),
                ...fillers,
            ],
            { started_at: "2026-06-01T00:00:00.000Z", ended_at: "2026-06-01T01:00:00.000Z" },
        ));
        expect(model?.gaps).toHaveLength(0);
        expect(laneFor(model, "null.json").w).toBe(SESSION_MAP_MIN_LANE_W);
        expect(laneFor(model, "tiny.json").w).toBe(SESSION_MAP_MIN_LANE_W);
        expect(laneFor(model, "half.json").w).toBeCloseTo(0.5, 5);
    });

    test("scales cost intensity relative to the max subagent cost", () => {
        const model = buildSessionMapLanes(mapManifest([
            mapCard({ file: "a.json", cost_usd: 2 }),
            mapCard({ file: "b.json", cost_usd: 1 }),
            mapCard({ file: "c.json", cost_usd: null }),
        ]));
        expect(laneFor(model, "a.json").intensity).toBeCloseTo(1, 5);
        expect(laneFor(model, "b.json").intensity).toBeCloseTo(0.5, 5);
        expect(laneFor(model, "c.json").intensity).toBeCloseTo(0, 5);
    });

    test("uses flat neutral coloring (null intensity) when no card has a positive cost", () => {
        const model = buildSessionMapLanes(mapManifest([
            mapCard({ file: "a.json", cost_usd: null }),
            mapCard({ file: "b.json", cost_usd: 0 }),
        ]));
        expect(laneFor(model, "a.json").intensity).toBeNull();
        expect(laneFor(model, "b.json").intensity).toBeNull();
    });

    test("carries the failure flag and count into the lane and tooltip", () => {
        const model = buildSessionMapLanes(mapManifest([
            mapCard({ file: "ok.json" }),
            mapCard({
                file: "bad.json",
                stats: mapStats(2),
                task_label: "fix the parser",
                model: "claude-opus-4",
                cost_usd: 1.25,
                duration_ms: 120_000,
            }),
        ]));
        const ok = laneFor(model, "ok.json");
        const bad = laneFor(model, "bad.json");
        expect(ok.failed).toBe(false);
        expect(bad.failed).toBe(true);
        expect(bad.failures).toBe(2);
        expect(bad.title).toContain("fix the parser");
        expect(bad.title).toContain("claude-opus-4");
        expect(bad.title).toContain("$1.25");
        expect(bad.title).toContain("2m");
        expect(bad.title).toContain("2 failures");
    });

    test("packs overlapping bars onto separate rows", () => {
        const model = buildSessionMapLanes(mapManifest([
            mapCard({ file: "a.json", spawn_turn_seq: 5, duration_ms: 1000 }),
            mapCard({ file: "b.json", spawn_turn_seq: 5, duration_ms: 1000 }),
            mapCard({ file: "c.json", spawn_turn_seq: 5, duration_ms: 1000 }),
        ]));
        expect(model?.axis).toBe("seq");
        expect(model?.rows).toBe(3);
        expect(laneFor(model, "a.json").row).toBe(0);
        expect(laneFor(model, "b.json").row).toBe(1);
        expect(laneFor(model, "c.json").row).toBe(2);
    });

    test("clamps overflow collisions onto the last row instead of growing past the cap", () => {
        const model = buildSessionMapLanes(mapManifest(
            ["a", "b", "c", "d", "e", "f"].map((name) =>
                mapCard({ file: `${name}.json`, spawn_turn_seq: 5, duration_ms: 1000 })),
        ));
        expect(model?.rows).toBe(4);
        expect(model?.lanes.filter((lane) => lane.row === 3)).toHaveLength(3);
        expect(model?.lanes.every((lane) => lane.row <= 3)).toBe(true);
    });

    test("rejects the seq axis when any card is nested (spawn seqs are parent-local)", () => {
        const cards = [
            mapCard({ file: "a.json", spawn_turn_seq: 3, started_at: "2026-06-01T00:00:00.000Z", duration_ms: 1_800_000 }),
            mapCard({
                file: "b.json",
                spawn_turn_seq: 7,
                depth: 2,
                parent_id: "claude-subagent-a.json",
                started_at: "2026-06-01T00:30:00.000Z",
                duration_ms: 1_800_000,
            }),
        ];
        const withWindow = buildSessionMapLanes(mapManifest(
            cards,
            { started_at: "2026-06-01T00:00:00.000Z", ended_at: "2026-06-01T01:00:00.000Z" },
        ));
        expect(withWindow?.axis).toBe("time");
        expect(laneFor(withWindow, "b.json").x).toBeCloseTo(0.5, 5);
        const withoutWindow = buildSessionMapLanes(mapManifest(cards));
        expect(withoutWindow?.axis).toBe("order");
    });

    test("treats an inverted root window (ended_at before started_at) as unusable", () => {
        const model = buildSessionMapLanes(mapManifest(
            [mapCard({ file: "a.json" }), mapCard({ file: "b.json" })],
            { started_at: "2026-06-01T01:00:00.000Z", ended_at: "2026-06-01T00:00:00.000Z" },
        ));
        expect(model?.axis).toBe("order");
        expect(model?.rootDurationMs).toBeNull();
    });

    test("compresses a wide mid-session gap and labels it with the wall-clock span", () => {
        const model = buildSessionMapLanes(mapManifest(
            [
                mapCard({ file: "a.json", started_at: "2026-06-01T00:00:00.000Z", duration_ms: 360_000 }),
                mapCard({ file: "b.json", started_at: "2026-06-01T00:48:00.000Z", duration_ms: 360_000 }),
            ],
            { started_at: "2026-06-01T00:00:00.000Z", ended_at: "2026-06-01T01:00:00.000Z" },
        ));
        expect(model?.axis).toBe("time");
        expect(model?.gaps).toHaveLength(1);
        const gap = model!.gaps[0]!;
        // Domain gap [0.1, 0.8] (42 of 60 minutes) collapses to the fixed
        // break width; covered segments stretch by (1-0.04)/0.3 = 3.2.
        expect(gap.label).toBe("42m");
        expect(gap.w).toBeCloseTo(0.04, 5);
        expect(gap.x).toBeCloseTo(0.32, 5);
        const b = laneFor(model, "b.json");
        expect(b.x).toBeCloseTo(0.36, 5);
        expect(b.w).toBeCloseTo(0.32, 5);
    });

    test("leaves gaps below the threshold untouched", () => {
        const model = buildSessionMapLanes(mapManifest(
            [
                mapCard({ file: "a.json", started_at: "2026-06-01T00:00:00.000Z", duration_ms: 1_620_000 }),
                mapCard({ file: "b.json", started_at: "2026-06-01T00:30:00.000Z", duration_ms: 1_800_000 }),
            ],
            { started_at: "2026-06-01T00:00:00.000Z", ended_at: "2026-06-01T01:00:00.000Z" },
        ));
        // Uncovered span is 0.05 of the strip - under the threshold.
        expect(model?.gaps).toHaveLength(0);
        expect(laneFor(model, "b.json").x).toBeCloseTo(0.5, 5);
        expect(laneFor(model, "b.json").w).toBeCloseTo(0.5, 5);
    });

    test("compresses two separate gaps and keeps bar order", () => {
        const model = buildSessionMapLanes(mapManifest(
            [
                mapCard({ file: "a.json", started_at: "2026-06-01T00:00:00.000Z", duration_ms: 1_800_000 }),
                mapCard({ file: "b.json", started_at: "2026-06-01T04:00:00.000Z", duration_ms: 1_800_000 }),
                mapCard({ file: "c.json", started_at: "2026-06-01T08:00:00.000Z", duration_ms: 1_800_000 }),
            ],
            { started_at: "2026-06-01T00:00:00.000Z", ended_at: "2026-06-01T10:00:00.000Z" },
        ));
        expect(model?.gaps).toHaveLength(2);
        const [g0, g1] = model!.gaps;
        expect(g0!.label).toBe("3h 30m");
        expect(g1!.label).toBe("3h 30m");
        expect(g0!.x).toBeLessThan(g1!.x);
        const a = laneFor(model, "a.json");
        const b = laneFor(model, "b.json");
        const c = laneFor(model, "c.json");
        expect(a.x).toBeLessThan(b.x);
        expect(b.x).toBeLessThan(c.x);
        // Bars sit between the breaks they used to be separated by.
        expect(b.x).toBeCloseTo(g0!.x + g0!.w, 5);
        expect(c.x).toBeCloseTo(g1!.x + g1!.w, 5);
    });

    test("labels a seq-axis gap with wall-clock computed from adjacent cards", () => {
        const model = buildSessionMapLanes(mapManifest([
            mapCard({ file: "a.json", spawn_turn_seq: 0, started_at: "2026-06-01T00:00:00.000Z" }),
            mapCard({ file: "b.json", spawn_turn_seq: 10, started_at: "2026-06-01T00:10:00.000Z", duration_ms: 600_000 }),
            mapCard({ file: "c.json", spawn_turn_seq: 90, started_at: "2026-06-01T03:00:00.000Z" }),
            mapCard({ file: "d.json", spawn_turn_seq: 100, started_at: "2026-06-01T03:10:00.000Z" }),
        ]));
        expect(model?.axis).toBe("seq");
        expect(model?.gaps).toHaveLength(1);
        // b ends 00:20 (start + duration), c starts 03:00.
        expect(model!.gaps[0]!.label).toBe("2h 40m");
    });

    test("falls back to a turn-count label when seq-axis timestamps are missing", () => {
        const model = buildSessionMapLanes(mapManifest([
            mapCard({ file: "a.json", spawn_turn_seq: 0 }),
            mapCard({ file: "b.json", spawn_turn_seq: 10 }),
            mapCard({ file: "c.json", spawn_turn_seq: 90 }),
            mapCard({ file: "d.json", spawn_turn_seq: 100 }),
        ]));
        expect(model?.axis).toBe("seq");
        expect(model?.gaps).toHaveLength(1);
        expect(model!.gaps[0]!.label).toBe("80 turns");
    });

    test("never compresses on the order axis (even spacing has no real gaps)", () => {
        const model = buildSessionMapLanes(mapManifest([
            mapCard({ file: "a.json" }),
            mapCard({ file: "b.json" }),
        ]));
        expect(model?.axis).toBe("order");
        expect(model?.gaps).toHaveLength(0);
        expect(laneFor(model, "b.json").x).toBeCloseTo(0.5, 5);
    });

    test("returns null for a manifest with zero subagents", () => {
        expect(buildSessionMapLanes(mapManifest([]))).toBeNull();
    });
});

describe("inspectPayloadFromShare", () => {
    test("preserves exported content blocks for the shared inspector", () => {
        const payload = inspectPayloadFromShare({
            schema_version: 1,
            exported_at: "2026-05-31T00:00:00.000Z",
            ax_version: "0.5.0",
            session: { id: "session-1", source: "codex" },
            stats: {
                turns: 1,
                tool_calls: 0,
                files_changed: 0,
                skills_used: 0,
                failures: 0,
            },
            turns: [{
                id: "turn-1",
                seq: 1,
                role: "assistant",
                text: "I'll patch it.",
                content: {
                    document_id: "content_document:session-1-1",
                    parser_id: "codex-jsonl",
                    parser_version: "1",
                    blockset_hash: null,
                    blocks: [{
                        seq: 0,
                        parent_seq: null,
                        kind: "text",
                        role: "assistant",
                        heading: null,
                        text: "I'll patch it.",
                        text_excerpt: "I'll patch it.",
                        start_offset: 0,
                        end_offset: 14,
                        confidence: 1,
                        atoms: [],
                    }],
                },
            }],
        }, "gist:Necmttn/abc123");

        expect(payload.turns[0]?.raw_text).toBe("I'll patch it.");
        expect(payload.turns[0]?.content?.blocks[0]?.text).toBe("I'll patch it.");
        expect(payload.token_usage).toBeNull();
    });

    test("v4 artifact: tool_calls pass through to the inspect payload", () => {
        const artifact = {
            schema_version: 4, exported_at: "2026-06-09T00:00:00Z",
            session: { id: "s1", source: "claude" },
            stats: { turns: 1, tool_calls: 1, files_changed: 0, skills_used: 0, failures: 0 },
            turns: [{
                id: "t0", seq: 0, role: "assistant", text: "",
                tool_calls: [{ seq: 0, name: "WebFetch", category: "net", input: { url: "https://paxel.ai" }, command: null, output_excerpt: null, has_error: false, tokens: 228 }],
            }],
        } as any;
        const payload = inspectPayloadFromShare(artifact, "gist:x/y");
        expect(payload.turns[0]!.tool_calls?.[0]?.name).toBe("WebFetch");
    });

    test("v3 artifact still renders (baked text path, no crash)", () => {
        const artifact = {
            schema_version: 3, exported_at: "2026-06-09T00:00:00Z",
            session: { id: "s1", source: "claude" },
            stats: { turns: 1, tool_calls: 1, files_changed: 0, skills_used: 0, failures: 0 },
            turns: [{ id: "t0", seq: 0, role: "assistant", text: "🔧 WebFetch\n  url: https://paxel.ai", has_tool_use: true }],
        } as any;
        const payload = inspectPayloadFromShare(artifact, "gist:x/y");
        expect(payload.turns[0]!.raw_text).toContain("🔧");
        expect(payload.turns[0]!.tool_calls).toBeUndefined();
    });

    test("carries token usage into the shared cost lens when exported", () => {
        const payload = inspectPayloadFromShare({
            schema_version: 1,
            exported_at: "2026-05-31T00:00:00.000Z",
            ax_version: "0.5.0",
            session: { id: "session-1", source: "codex" },
            stats: {
                turns: 1,
                tool_calls: 0,
                files_changed: 0,
                skills_used: 0,
                failures: 0,
            },
            token_usage: {
                model: "gpt-5",
                prompt_tokens: 100,
                completion_tokens: 20,
                cache_creation_input_tokens: 30,
                cache_read_input_tokens: 40,
                estimated_tokens: 190,
                estimated_input_cost_usd: 0.01,
                estimated_output_cost_usd: 0.02,
                estimated_cache_creation_cost_usd: 0.003,
                estimated_cache_read_cost_usd: 0.001,
                estimated_cost_usd: 0.034,
                pricing_source: "test",
            },
            turns: [{
                id: "turn-1",
                seq: 1,
                role: "user",
                text: "hello",
            }],
        }, "gist:Necmttn/abc123");

        expect(payload.token_usage?.estimated_cost_usd).toBe(0.034);
    });
});
