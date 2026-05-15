import { describe, expect, test } from "bun:test";
import {
    FILE_ATTENTION_SQL,
    normalizeGraphMode,
    resolveGraphExplorerMode,
    rowsToGraphPayload,
    validateFileAttentionSql,
} from "./graph-explorer.ts";

describe("graph explorer", () => {
    test("normalizeGraphMode defaults unknown to file-attention", () => {
        expect(normalizeGraphMode(null)).toBe("file-attention");
        expect(normalizeGraphMode("nope")).toBe("file-attention");
        expect(normalizeGraphMode("delivery")).toBe("delivery");
    });

    test("resolveGraphExplorerMode marks staged modes without falling back", () => {
        expect(resolveGraphExplorerMode("file-attention")).toEqual({
            requestedMode: "file-attention",
            effectiveMode: "file-attention",
            implemented: true,
            warnings: [],
        });
        expect(resolveGraphExplorerMode("delivery")).toEqual({
            requestedMode: "delivery",
            effectiveMode: "delivery",
            implemented: false,
            warnings: ['Mode "delivery" is staged; no graph query is implemented yet.'],
        });
    });

    test("file attention query avoids invalid grouped decoration", () => {
        expect(validateFileAttentionSql()).toEqual([]);
        expect(FILE_ATTENTION_SQL).toContain("$q");
        expect(FILE_ATTENTION_SQL).toContain("$limit");
        expect(FILE_ATTENTION_SQL).toContain("time::max(ts) AS last_seen");
        expect(FILE_ATTENTION_SQL).toContain("GROUP BY session, file");
        expect(FILE_ATTENTION_SQL).toContain("FROM turn");
        expect(FILE_ATTENTION_SQL).toContain("\"organic_task\"");
        expect(FILE_ATTENTION_SQL).toContain("message_kind = \"task\"");
        expect(FILE_ATTENTION_SQL).toContain("<local-command");
        expect(FILE_ATTENTION_SQL).toContain("text_excerpt");
        expect(FILE_ATTENTION_SQL).not.toContain("GROUP BY in.session");
        expect(FILE_ATTENTION_SQL).not.toContain("math::max(ts)");
    });

    test("rowsToGraphPayload builds typed graph with inspector panels", () => {
        const modeResolution = resolveGraphExplorerMode("file-attention");
        const payload = rowsToGraphPayload({
            generatedAt: "2026-05-15T00:00:00.000Z",
            mode: modeResolution.effectiveMode,
            query: "dashboard",
            warnings: modeResolution.warnings,
            rows: [
                {
                    source_id: "session:one",
                    source_label: "Can you make the graph explain what the session was about?",
                    source_kind: "session",
                    source_subtitle: "ax",
                    target_id: "file:dashboard",
                    target_label: "src/dashboard/server.ts",
                    target_kind: "file",
                    target_subtitle: "ts",
                    relation: "edited",
                    weight: 3,
                    last_seen: "2026-05-14T12:00:00.000Z",
                },
            ],
        });

        expect(payload.generatedAt).toBe("2026-05-15T00:00:00.000Z");
        expect(payload.mode).toBe("file-attention");
        expect(payload.warnings).toEqual([]);
        expect(payload.query).toBe("dashboard");
        expect(payload.nodes).toContainEqual({
            id: "file:dashboard",
            label: "src/dashboard/server.ts",
            kind: "file",
            weight: 3,
            tone: "accent",
            subtitle: "ts",
        });
        expect(payload.nodes).toContainEqual({
            id: "session:one",
            label: "Can you make the graph explain what the session was about?",
            kind: "session",
            weight: 3,
            tone: "neutral",
            subtitle: "ax",
        });
        expect(payload.edges).toEqual([
            {
                source: "session:one",
                target: "file:dashboard",
                relation: "edited",
                weight: 3,
                tone: "attention",
                label: "edited",
                metrics: {
                    weight: 3,
                    last_seen: "2026-05-14T12:00:00.000Z",
                },
            },
        ]);
        expect(payload.panels[0]).toEqual({
            title: "Graph Summary",
            kind: "summary",
            rows: [
                { label: "Mode", value: "file-attention" },
                { label: "Nodes", value: "2" },
                { label: "Edges", value: "1" },
                { label: "Max edge weight", value: "3" },
            ],
        });
        expect(payload.panels[1]?.kind).toBe("evidence");
        expect(payload.panels[1]?.rows[0]?.detail).toBe(
            "Can you make the graph explain what the session was about? -> src/dashboard/server.ts",
        );
    });

    test("rowsToGraphPayload can represent a staged mode placeholder", () => {
        const modeResolution = resolveGraphExplorerMode("delivery");
        const payload = rowsToGraphPayload({
            generatedAt: "2026-05-15T00:00:00.000Z",
            mode: modeResolution.effectiveMode,
            query: null,
            warnings: modeResolution.warnings,
            rows: [],
        });

        expect(payload.mode).toBe("delivery");
        expect(payload.nodes).toEqual([]);
        expect(payload.edges).toEqual([]);
        expect(payload.warnings).toEqual(['Mode "delivery" is staged; no graph query is implemented yet.']);
        expect(payload.panels[0]?.rows).toContainEqual({ label: "Mode", value: "delivery" });
    });

    test("rowsToGraphPayload dedupes shared source and target nodes", () => {
        const payload = rowsToGraphPayload({
            mode: "file-attention",
            rows: [
                {
                    source_id: "session:one",
                    source_label: "ax",
                    source_kind: "session",
                    target_id: "file:server",
                    target_label: "src/dashboard/server.ts",
                    target_kind: "file",
                    relation: "edited",
                    weight: 2,
                },
                {
                    source_id: "session:one",
                    source_label: "ax",
                    source_kind: "session",
                    target_id: "file:graph",
                    target_label: "src/dashboard/graph-explorer.ts",
                    target_kind: "file",
                    relation: "edited",
                    weight: 4,
                },
                {
                    source_id: "session:two",
                    source_label: "ax",
                    source_kind: "session",
                    target_id: "file:server",
                    target_label: "src/dashboard/server.ts",
                    target_kind: "file",
                    relation: "edited",
                    weight: 1,
                },
            ],
        });

        expect(payload.nodes).toHaveLength(4);
        expect(payload.edges).toHaveLength(3);
        expect(payload.nodes.find((node) => node.id === "session:one")?.weight).toBe(6);
        expect(payload.nodes.find((node) => node.id === "file:server")?.weight).toBe(3);
    });
});
