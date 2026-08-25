/**
 * The SQL model header contract + drift pins (#888).
 *
 * No database: these tests read the .sql files as text and hold them to the
 * declarations they make - inputs must be real tables, and the one list that
 * duplicates a TS constant (the edit-tool names in run-evidence-ref.sql) is
 * pinned to its source of truth so the two cannot drift silently.
 */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { parseDuckdbTables } from "@ax/schema/duckdb-ddl";
import { EDIT_TOOL_NAMES } from "@ax/lib/shared/tool-classes";
import { parseModelHeader, runSqlModel } from "./runner.ts";
import {
    RUN_EVIDENCE_EVENT_MODEL,
    RUN_EVIDENCE_MODELS,
    RUN_EVIDENCE_REF_MODEL,
    runEvidenceModelVersion,
} from "./run-evidence-models.ts";
import { CACHE_BUST_EVENT_MODEL, CACHE_BUST_MODELS, cacheBustModelVersion } from "./cache-bust-models.ts";

const TABLES = new Set(parseDuckdbTables());

const ALL_MODELS = [...RUN_EVIDENCE_MODELS, ...CACHE_BUST_MODELS];

describe("model header contract", () => {
    test("every registered model declares model/inputs/rebuild and targets a real table", () => {
        for (const model of ALL_MODELS) {
            const header = parseModelHeader(model.sql);
            expect(header.model).toBe(model.name);
            expect(TABLES.has(header.model)).toBe(true);
            expect(header.inputs.length).toBeGreaterThan(0);
            for (const input of header.inputs) {
                expect({ model: model.name, input, known: TABLES.has(input) }).toEqual({
                    model: model.name,
                    input,
                    known: true,
                });
            }
            expect(["incremental", "full_rebuild"]).toContain(header.rebuild);
        }
    });

    test("an incremental model actually reads the since_days variable", () => {
        for (const model of ALL_MODELS) {
            if (parseModelHeader(model.sql).rebuild === "incremental") {
                expect(model.sql).toContain("getvariable('since_days')");
            }
        }
    });

    test("a headerless file is refused", () => {
        expect(() => parseModelHeader("SELECT 1")).toThrow(/header contract/);
    });

    test("the ICU-less clock spelling is used wherever the models read the clock", () => {
        for (const model of ALL_MODELS) {
            for (const match of model.sql.matchAll(/CURRENT_TIMESTAMP/g)) {
                const before = model.sql.slice(Math.max(0, match.index - 6), match.index);
                expect(before).toContain("CAST(");
            }
        }
    });
});

describe("SQL model runner", () => {
    test("each concurrent model observes the since_days value that its caller set", async () => {
        let markSecondSet!: () => void;
        let markFirstSet!: () => void;
        const firstSet = new Promise<void>((resolve) => {
            markFirstSet = resolve;
        });
        const secondSet = new Promise<void>((resolve) => {
            markSecondSet = resolve;
        });
        let sinceDays = "unset";
        const observed = new Map<string, string>();

        const write = {
            exec: (sql: string) =>
                Effect.promise(async () => {
                    if (sql === "SET VARIABLE since_days = NULL") {
                        sinceDays = "NULL";
                        markFirstSet();
                        await Promise.race([secondSet, Bun.sleep(20)]);
                        return 0;
                    }
                    if (sql === "SET VARIABLE since_days = 1") {
                        await firstSet;
                        sinceDays = "1";
                        markSecondSet();
                        return 0;
                    }
                    observed.set(sql, sinceDays);
                    return 0;
                }),
        };

        await Effect.runPromise(
            Effect.all(
                [
                    runSqlModel(write as never, { name: "rebuild", sql: "REBUILD_MODEL" }, undefined),
                    runSqlModel(write as never, { name: "windowed", sql: "WINDOWED_MODEL" }, 1),
                ],
                { concurrency: "unbounded" },
            ),
        );

        expect(observed.get("REBUILD_MODEL")).toBe("NULL");
        expect(observed.get("WINDOWED_MODEL")).toBe("1");
    });
});

describe("drift pins", () => {
    test("the ref model's edit-tool list equals EDIT_TOOL_NAMES lowercased", () => {
        const m = /lower\(tc\.name\) IN \(([^)]+)\)/.exec(RUN_EVIDENCE_REF_MODEL.sql);
        expect(m).not.toBeNull();
        const sqlNames = m![1]!
            .split(",")
            .map((s) => s.trim().replace(/^'|'$/g, ""))
            .sort();
        const tsNames = [...EDIT_TOOL_NAMES].map((n) => n.toLowerCase()).sort();
        expect(sqlNames).toEqual(tsNames);
    });

    test("the event model consumes the STAMPED check_family, never re-classifying", () => {
        expect(RUN_EVIDENCE_EVENT_MODEL.sql).toContain("check_family IS NOT NULL");
        // Guard against someone porting the classifier into SQL: no token maps.
        expect(RUN_EVIDENCE_EVENT_MODEL.sql).not.toMatch(/vitest|pytest|golangci/);
    });

    test("the model version moves when the SQL moves", () => {
        const v = runEvidenceModelVersion();
        expect(v).toHaveLength(16);
        // Stable across calls (it seeds the cutover marker).
        expect(runEvidenceModelVersion()).toBe(v);
        const cb = cacheBustModelVersion();
        expect(cb).toHaveLength(16);
        expect(cacheBustModelVersion()).toBe(cb);
    });

    test("the cache-bust model stores only the ingest price", () => {
        // Independent OTLP corroboration happens at root-session read time.
        // A model-side rate recompute would make the guard circular again.
        expect(CACHE_BUST_EVENT_MODEL.sql).not.toMatch(/agent_model|cache_creation_per_million_usd|corroborated_cost_usd/);
        expect(CACHE_BUST_EVENT_MODEL.sql).toContain("estimated_cache_creation_cost_usd");
    });

    test("the policy-decision effect list matches the TS query's", () => {
        expect(RUN_EVIDENCE_EVENT_MODEL.sql).toContain(
            "('blocked', 'injected_context', 'modified_input', 'notified')",
        );
    });
});
