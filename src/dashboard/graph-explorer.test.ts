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

    test("resolveGraphExplorerMode falls back to file-attention as the effective payload mode", () => {
        expect(resolveGraphExplorerMode("file-attention")).toEqual({
            requestedMode: "file-attention",
            effectiveMode: "file-attention",
            warnings: [],
        });
        expect(resolveGraphExplorerMode("delivery")).toEqual({
            requestedMode: "delivery",
            effectiveMode: "file-attention",
            warnings: ['Mode "delivery" is not implemented yet; showing file-attention graph.'],
        });
    });

    test("file attention query avoids invalid grouped decoration", () => {
        expect(validateFileAttentionSql()).toEqual([]);
        expect(FILE_ATTENTION_SQL).toContain("$q");
        expect(FILE_ATTENTION_SQL).toContain("$limit");
        expect(FILE_ATTENTION_SQL).toContain("time::max(ts) AS last_seen");
        expect(FILE_ATTENTION_SQL).toContain("GROUP BY session, file");
        expect(FILE_ATTENTION_SQL).not.toContain("GROUP BY in.session");
        expect(FILE_ATTENTION_SQL).not.toContain("math::max(ts)");
    });

    test("rowsToGraphPayload builds typed graph with inspector panels", () => {
        const modeResolution = resolveGraphExplorerMode("delivery");
        const payload = rowsToGraphPayload({
            generatedAt: "2026-05-15T00:00:00.000Z",
            mode: modeResolution.effectiveMode,
            query: "dashboard",
            warnings: modeResolution.warnings,
            rows: [
                {
                    source_id: "session:one",
                    source_label: "ax",
                    source_kind: "session",
                    source_subtitle: "codex",
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
        expect(payload.warnings).toEqual(['Mode "delivery" is not implemented yet; showing file-attention graph.']);
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
            label: "ax",
            kind: "session",
            weight: 3,
            tone: "neutral",
            subtitle: "codex",
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
