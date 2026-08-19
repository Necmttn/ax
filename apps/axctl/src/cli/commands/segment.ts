/**
 * `ax segment` (#902, Phase 4 piece 2) - move session-scoped EVENT rows
 * between ax stores as a plain directory of NDJSON files.
 *
 * - `export` reads the published snapshot (cache runtime) and writes
 *   `<table>.ndjson` per contract table + `manifest.json` LAST.
 * - `import` loads a segment under the ingest lock (ingest runtime), writes
 *   the content-hash watermark handshake marks, then triggers the derive set
 *   over a wide since-window through the ordinary ingest path (`cmdIngest`).
 *
 * PRIVACY: a segment carries raw turn text and tool I/O. It is a LOCAL
 * artifact the user moves themselves - never published, no attribution plug.
 */
import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { prettyPrint } from "@ax/lib/json";
import { AX_VERSION } from "../version.ts";
import { runSegmentExport } from "../../segment/export.ts";
import { planSegmentImport, runSegmentImport } from "../../segment/import.ts";
import { withConfigWrite } from "../../config-core/reconcile.ts";
import { cmdIngest } from "./ingest.ts";
import type { RuntimeManifest } from "./manifest.ts";
import { fail, jsonFlag, optionValue, parseCsvFlag, parseOptionalPositiveDayWindow } from "./shared.ts";

const cmdSegmentExport = (input: {
    readonly sessions: string | undefined;
    readonly since: string | undefined;
    readonly out: string;
    readonly json: boolean;
}) =>
    Effect.gen(function* () {
        const sessions = input.sessions === undefined ? undefined : parseCsvFlag(input.sessions);
        const sinceDays = parseOptionalPositiveDayWindow("segment export", "--since", input.since);
        if ((sessions === undefined || sessions.length === 0) === (sinceDays === undefined)) {
            return fail("ax segment export: pass exactly one of --sessions=<ids> or --since=Nd");
        }
        const result = yield* runSegmentExport({
            ...(sessions !== undefined && sessions.length > 0 ? { sessions } : {}),
            ...(sinceDays !== undefined ? { sinceDays } : {}),
            outDir: input.out,
            axVersion: AX_VERSION,
        }).pipe(
            Effect.catchTag("SegmentExportError", (error) => Effect.sync(() => fail(`ax segment export: ${error.message}`))),
        );
        if (input.json) {
            console.log(prettyPrint(result));
            return;
        }
        console.log(`exported ${result.sessions} session(s) to ${result.outDir}`);
        for (const table of result.tables) {
            if (table.rows > 0) console.log(`  ${table.table}: ${table.rows} row(s)`);
        }
        console.log(`  source file hashes: ${result.sourceFiles}`);
        console.log("note: the segment contains raw turn text and tool I/O - it is a local artifact; move it yourself, do not publish it.");
    });

const cmdSegmentImport = (input: {
    readonly dir: string;
    readonly yes: boolean;
    readonly json: boolean;
}) =>
    Effect.gen(function* () {
        const plan = yield* planSegmentImport(input.dir).pipe(
            Effect.catchTag("SegmentImportError", (error) => Effect.sync(() => fail(`ax segment import: ${error.message}`))),
        );
        if (plan.ddlMismatch && !input.yes) {
            return fail(
                "ax segment import: the segment was exported under a DIFFERENT schema (ddl_hash mismatch). "
                + "Columns the local DDL does not know are dropped; missing ones load as NULL. Re-run with --yes to proceed.",
            );
        }
        const result = yield* withConfigWrite((write) => runSegmentImport(write, plan)).pipe(
            Effect.catchTag("SegmentImportError", (error) => Effect.sync(() => fail(`ax segment import: ${error.message}`))),
        );
        if (input.json) {
            console.log(prettyPrint(result));
        } else {
            console.log(`imported ${result.sessions} session(s) from ${input.dir}`);
            for (const table of result.tables) {
                const dropped = table.droppedColumns.length > 0 ? ` (dropped: ${table.droppedColumns.join(", ")})` : "";
                console.log(`  ${table.table}: ${table.rows} row(s)${dropped}`);
            }
            console.log(`  watermark handshake marks: ${result.marksWritten}`);
        }

        // Wide-window re-derive through the ordinary ingest path (lock,
        // deadline, verdicts). Contract-driven stage set: every stage whose
        // declared writes are all derive/enrich/bookkeep.
        if (result.rederiveSinceDays !== null && result.rederiveStages.length > 0) {
            if (!input.json) {
                console.log(`re-deriving (${result.rederiveStages.length} stages, --since=${result.rederiveSinceDays})...`);
            }
            yield* cmdIngest(
                [`--stages=${result.rederiveStages.join(",")}`, `--since=${result.rederiveSinceDays}`],
                { command: "segment" },
            );
        }
    });

const segmentExportCommand = Command.make(
    "export",
    {
        sessions: Flag.string("sessions").pipe(Flag.optional),
        since: Flag.string("since").pipe(Flag.optional),
        out: Flag.string("out"),
        json: jsonFlag,
    },
    ({ sessions, since, out, json }) =>
        cmdSegmentExport({ sessions: optionValue(sessions), since: optionValue(since), out, json }),
).pipe(
    Command.withDescription(
        "Export session-scoped EVENT rows to a plain directory (NDJSON per table + manifest.json). "
        + "Scope: --sessions=<id,id,...> (spawned descendants included) or --since=Nd. Enrichment "
        + "columns are stripped; catalogs and derived tables never ride. The segment contains raw "
        + "turn text and tool I/O - it is a LOCAL artifact; do not publish it.",
    ),
);

const segmentImportCommand = Command.make(
    "import",
    {
        dir: Argument.string("dir"),
        yes: Flag.boolean("yes").pipe(Flag.withDefault(false)),
        json: jsonFlag,
    },
    ({ dir, yes, json }) => cmdSegmentImport({ dir, yes, json }),
).pipe(
    Command.withDescription(
        "Import a segment directory under the ingest lock: validates manifest + per-file sha256, "
        + "loads each table with the column-intersection loader, writes content-hash watermark "
        + "marks (so re-ingest skips the original files), then re-derives over a wide window. "
        + "A ddl_hash mismatch (different ax schema) requires --yes.",
    ),
);

export const segmentCommand = Command.make("segment").pipe(
    Command.withDescription(
        "Move session-scoped event rows between ax stores (export to / import from a plain directory). "
        + "Subcommands: export, import.",
    ),
    Command.withSubcommands([segmentExportCommand, segmentImportCommand]),
);

// Export reads the published snapshot; import writes the live store under the
// ingest lock and then runs the derive set - hence db-conditional.
export const segmentRuntime: RuntimeManifest = {
    segment: {
        kind: "db-conditional",
        fallback: "cache",
        subcommands: {
            export: "cache",
            import: "ingest",
        },
    },
};
