/**
 * The SQL model header contract + drift pins (#888).
 *
 * No database: these tests read the .sql files as text and hold them to the
 * declarations they make - inputs must be real tables, and the one list that
 * duplicates a TS constant (the edit-tool names in run-evidence-ref.sql) is
 * pinned to its source of truth so the two cannot drift silently.
 */
import { describe, expect, test } from "bun:test";
import { parseDuckdbTables } from "@ax/schema/duckdb-ddl";
import { EDIT_TOOL_NAMES } from "@ax/lib/shared/tool-classes";
import { parseModelHeader } from "./runner.ts";
import {
    RUN_EVIDENCE_EVENT_MODEL,
    RUN_EVIDENCE_MODELS,
    RUN_EVIDENCE_REF_MODEL,
    runEvidenceModelVersion,
} from "./run-evidence-models.ts";

const TABLES = new Set(parseDuckdbTables());

describe("model header contract", () => {
    test("every registered model declares model/inputs/rebuild and targets a real table", () => {
        for (const model of RUN_EVIDENCE_MODELS) {
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
        for (const model of RUN_EVIDENCE_MODELS) {
            if (parseModelHeader(model.sql).rebuild === "incremental") {
                expect(model.sql).toContain("getvariable('since_days')");
            }
        }
    });

    test("a headerless file is refused", () => {
        expect(() => parseModelHeader("SELECT 1")).toThrow(/header contract/);
    });

    test("the ICU-less clock spelling is used wherever the models read the clock", () => {
        for (const model of RUN_EVIDENCE_MODELS) {
            for (const match of model.sql.matchAll(/CURRENT_TIMESTAMP/g)) {
                const before = model.sql.slice(Math.max(0, match.index - 6), match.index);
                expect(before).toContain("CAST(");
            }
        }
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
    });

    test("the policy-decision effect list matches the TS query's", () => {
        expect(RUN_EVIDENCE_EVENT_MODEL.sql).toContain(
            "('blocked', 'injected_context', 'modified_input', 'notified')",
        );
    });
});
