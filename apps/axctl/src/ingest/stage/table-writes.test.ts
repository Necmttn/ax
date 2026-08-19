// apps/axctl/src/ingest/stage/table-writes.test.ts
/**
 * Static half of the event-layer freeze enforcement (#893 slice 1, #897):
 * every declared TableWrite is checked mode-vs-layer against the manifest.
 * Deliberately phrased over the WRITE declarations, never over the stage
 * tags array [R#14] - tags say where a stage runs, not what its writes are.
 * The behavioral half (fixture runs + content digests) lives in
 * ../table-writes.behavior.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { DUCKDB_TABLE_LAYERS, ENRICHMENT_COLUMNS } from "@ax/schema/duckdb-tables";
import { parseDuckdbColumns } from "@ax/schema/parse-duckdb-schema";
import { ALL_STAGES } from "./registry.ts";
import { NON_STAGE_WRITERS, WRITE_MODE_EXCEPTIONS } from "./table-writes.ts";
import type { TableWrite } from "./types.ts";

interface DeclaredWriter {
    readonly writer: string;
    readonly writes: readonly TableWrite[];
}

const ALL_WRITERS: readonly DeclaredWriter[] = [
    ...ALL_STAGES.map((stage) => ({ writer: `stage:${stage.meta.key}`, writes: stage.meta.writes })),
    ...NON_STAGE_WRITERS,
];

const hasException = (writer: string, write: TableWrite): boolean =>
    WRITE_MODE_EXCEPTIONS.some((e) => e.writer === writer && e.table === write.table && e.mode === write.mode);

describe("event-layer write contract (static)", () => {
    test("every declared write targets a table the DDL manifest knows", () => {
        for (const { writer, writes } of ALL_WRITERS) {
            for (const write of writes) {
                expect(DUCKDB_TABLE_LAYERS.has(write.table), `${writer} declares unknown table ${write.table}`).toBe(true);
            }
        }
    });

    test("every declared mode is legal for the target table's layer", () => {
        const violations: string[] = [];
        for (const { writer, writes } of ALL_WRITERS) {
            for (const write of writes) {
                const layer = DUCKDB_TABLE_LAYERS.get(write.table);
                if (layer === undefined) continue; // covered by the test above
                const legal = (() => {
                    switch (write.mode) {
                        case "parse":
                            return layer === "event" || hasException(writer, write);
                        case "enrich":
                            return layer === "event" && (ENRICHMENT_COLUMNS[write.table]?.length ?? 0) > 0;
                        case "derive":
                            return layer === "derived" || hasException(writer, write);
                        case "bookkeep":
                            return layer === "bookkeeping";
                    }
                })();
                if (!legal) violations.push(`${writer}: ${write.mode} on ${write.table} (layer ${layer})`);
            }
        }
        expect(violations).toEqual([]);
    });

    test("every exception is load-bearing - a declared write actually uses it", () => {
        for (const exception of WRITE_MODE_EXCEPTIONS) {
            const used = ALL_WRITERS.some(
                (w) => w.writer === exception.writer
                    && w.writes.some((write) => write.table === exception.table && write.mode === exception.mode),
            );
            expect(used, `stale exception: ${exception.writer} / ${exception.table} / ${exception.mode}`).toBe(true);
        }
    });

    test("enrichment columns name real event-table columns", () => {
        for (const [table, columns] of Object.entries(ENRICHMENT_COLUMNS)) {
            expect(DUCKDB_TABLE_LAYERS.get(table), `${table} must be an event table to carry enrichment`).toBe("event");
            expect(columns.length).toBeGreaterThan(0);
            const ddlColumns = new Set(parseDuckdbColumns(table));
            for (const column of columns) {
                expect(ddlColumns.has(column), `${table}.${column} is not a DDL column`).toBe(true);
            }
        }
    });

    test("every enrichment-column table has a declared enrich writer", () => {
        for (const table of Object.keys(ENRICHMENT_COLUMNS)) {
            const hasWriter = ALL_WRITERS.some(
                (w) => w.writes.some((write) => write.table === table && write.mode === "enrich"),
            );
            expect(hasWriter, `${table} is enumerated but nothing declares an enrich write on it`).toBe(true);
        }
    });

    test("non-stage writer names are unique and do not collide with stage keys", () => {
        const names = NON_STAGE_WRITERS.map((w) => w.writer);
        expect(new Set(names).size).toBe(names.length);
        const stageNames = new Set(ALL_STAGES.map((s) => `stage:${s.meta.key}`));
        for (const name of names) {
            expect(stageNames.has(name), `${name} collides with a stage writer id`).toBe(false);
        }
    });

    /** Pins the exception list itself: growing it is a design decision made
     *  in review, not a mechanical fix for a red test. */
    test("the exception list stays enumerated", () => {
        expect(WRITE_MODE_EXCEPTIONS.map((e) => `${e.writer}/${e.table}/${e.mode}`).sort()).toEqual([
            "cli:ingest-insights/friction_event/parse",
            "stage:session-health/session_token_usage/derive",
            "stage:spawned/spawned/derive",
        ]);
    });
});
