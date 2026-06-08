import { describe, expect, it } from "bun:test";
import { minimalShareArtifact, type AxSessionShare } from "./artifact.ts";
import {
    buildShareBundle,
    deriveShareTaskLabel,
    isAxSessionShareManifest,
    subagentFileName,
} from "./manifest.ts";

const child = (
    id: string,
    over: {
        readonly started_at?: string;
        readonly ended_at?: string;
        readonly cost?: number;
        readonly stats?: AxSessionShare["stats"];
        readonly children?: ReadonlyArray<AxSessionShare>;
    } = {},
): AxSessionShare => {
    const base = minimalShareArtifact({ id, source: "claude" });
    return {
        ...base,
        session: {
            ...base.session,
            ...(over.started_at ? { started_at: over.started_at } : {}),
            ...(over.ended_at ? { ended_at: over.ended_at } : {}),
        },
        stats: over.stats ?? { turns: 4, tool_calls: 3, files_changed: 1, skills_used: 0, failures: 0 },
        ...(over.cost !== undefined
            ? {
                  token_usage: {
                      model: "claude-opus-4-8",
                      prompt_tokens: 0,
                      completion_tokens: 0,
                      cache_creation_input_tokens: 0,
                      cache_read_input_tokens: 0,
                      estimated_tokens: 100,
                      estimated_cost_usd: over.cost,
                      pricing_source: "test",
                  },
              }
            : {}),
        ...(over.children ? { children: over.children } : {}),
    };
};

describe("buildShareBundle", () => {
    it("flattens root + nested children into manifest + per-file shares", () => {
        const grandchild = child("claude-subagent-gc", { cost: 0.5 });
        const root: AxSessionShare = {
            ...minimalShareArtifact({ id: "root1", source: "claude" }),
            stats: { turns: 10, tool_calls: 8, files_changed: 2, skills_used: 1, failures: 1 },
            children: [
                child("claude-subagent-a", { cost: 1.0, children: [grandchild] }),
                child("claude-subagent-b", { cost: 0.25 }),
            ],
        };

        const bundle = buildShareBundle(root);

        // index.json + session.json + 3 descendants.
        expect(bundle.files.map((f) => f.name).sort()).toEqual([
            "index.json",
            "session.json",
            "subagent-claude-subagent-a.json",
            "subagent-claude-subagent-b.json",
            "subagent-claude-subagent-gc.json",
        ]);

        // Per-file shares no longer inline children.
        for (const file of bundle.files) {
            if (file.name === "index.json") continue;
            expect((file.content as AxSessionShare).children).toBeUndefined();
        }

        const m = bundle.manifest;
        expect(m.kind).toBe("manifest");
        expect(m.schema_version).toBe(3);
        expect(m.subagents).toHaveLength(3);
        expect(m.totals.subagents).toBe(3);
    });

    it("records depth + parent_id for nested descendants", () => {
        const root: AxSessionShare = {
            ...minimalShareArtifact({ id: "root1", source: "claude" }),
            children: [child("a", { children: [child("gc")] })],
        };
        const cards = buildShareBundle(root).manifest.subagents;
        const a = cards.find((c) => c.id === "a")!;
        const gc = cards.find((c) => c.id === "gc")!;
        expect(a.depth).toBe(1);
        expect(a.parent_id).toBe("root1");
        expect(gc.depth).toBe(2);
        expect(gc.parent_id).toBe("a");
    });

    it("rolls up whole-trace cost across root + descendants", () => {
        const root: AxSessionShare = {
            ...child("root1", { cost: 2.0 }),
            children: [child("a", { cost: 1.0 }), child("b", { cost: 0.25 })],
        };
        expect(buildShareBundle(root).manifest.totals.cost_usd).toBeCloseTo(3.25, 6);
    });

    it("derives per-card duration from timestamps", () => {
        const root: AxSessionShare = {
            ...minimalShareArtifact({ id: "root1", source: "claude" }),
            children: [
                child("a", {
                    started_at: "2026-06-01T10:00:00.000Z",
                    ended_at: "2026-06-01T10:02:30.000Z",
                }),
            ],
        };
        expect(buildShareBundle(root).manifest.subagents[0]!.duration_ms).toBe(150_000);
    });

    it("emits only index.json + session.json when there are no subagents", () => {
        const bundle = buildShareBundle(minimalShareArtifact({ id: "solo", source: "codex" }));
        expect(bundle.files.map((f) => f.name)).toEqual(["index.json", "session.json"]);
        expect(bundle.manifest.totals.subagents).toBe(0);
    });

    it("validates a produced manifest", () => {
        const bundle = buildShareBundle(minimalShareArtifact({ id: "solo", source: "codex" }));
        expect(isAxSessionShareManifest(bundle.manifest)).toBe(true);
        expect(isAxSessionShareManifest({ kind: "manifest" })).toBe(false);
    });
});

describe("subagentFileName", () => {
    it("slugifies session ids", () => {
        expect(subagentFileName("claude-subagent-a7f2")).toBe("subagent-claude-subagent-a7f2.json");
        expect(subagentFileName("weird:id/with spaces")).toBe("subagent-weird_id_with_spaces.json");
    });
});

describe("deriveShareTaskLabel", () => {
    it("uses the first user task turn text, truncated", () => {
        const share: AxSessionShare = {
            ...minimalShareArtifact({ id: "x", source: "claude" }),
            turns: [
                {
                    id: "t0",
                    seq: 0,
                    role: "user",
                    message_kind: "task",
                    text: "Implement the multi-file gist bundle",
                },
            ],
        };
        expect(deriveShareTaskLabel(share)).toBe("Implement the multi-file gist bundle");
    });
});
