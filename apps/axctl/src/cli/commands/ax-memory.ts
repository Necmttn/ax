/**
 * `ax memory ops` - Claude memory-file activity (writes/edits to
 * `~/.claude/.../memory/*.md`), rolled up from existing `edited` edges.
 *
 * Read-only, `db` runtime. Sibling of commands/ax-cost.ts. Recall is not
 * tracked here (it never lands in the transcript - see queries/memory-ops.ts).
 */
import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { prettyPrint } from "@ax/lib/json";
import { fetchMemoryOps } from "../../queries/memory-ops.ts";
import { renderTable } from "../table.js";
import type { Column } from "../table.js";
import type { RuntimeManifest } from "./manifest.ts";
import { fail, jsonFlag, positiveLimit } from "./shared.ts";

const MEMORY_DEFAULT_WINDOW_DAYS = 30;

// ---------------------------------------------------------------------------
// ax memory ops [--days=N] [--events] [--limit=N] [--json]
// ---------------------------------------------------------------------------

const cmdMemoryOps = (input: {
    readonly sinceDays: number;
    readonly events: boolean;
    readonly limit: number;
    readonly json: boolean;
}) =>
    Effect.gen(function* () {
        const result = yield* fetchMemoryOps({ sinceDays: input.sinceDays });

        if (input.json) {
            console.log(prettyPrint(result));
            return;
        }

        if (result.totals.ops === 0) {
            console.log(`(no memory writes in the last ${input.sinceDays} days)`);
            return;
        }

        if (input.events) {
            type EvRow = {
                ts: string;
                op: string;
                kind: string;
                slug: string;
                session: string;
                project: string;
            };
            const rendered: EvRow[] = result.events.slice(0, input.limit).map((e) => ({
                ts: e.ts.replace("T", " ").replace(/\.\d+Z$/, ""),
                op: e.op,
                kind: e.kind,
                slug: e.slug,
                session: e.session_id.slice(0, 8),
                project: e.project ?? "",
            }));
            const cols: Column<EvRow>[] = [
                { header: "ts", get: (r) => r.ts, width: 19 },
                { header: "op", get: (r) => r.op, width: 7 },
                { header: "kind", get: (r) => r.kind, width: 6 },
                { header: "slug", get: (r) => r.slug, min: 24, overflow: "ellipsis" },
                { header: "session", get: (r) => r.session, width: 9 },
                { header: "project", get: (r) => r.project, width: 24, overflow: "ellipsis" },
            ];
            console.log(renderTable({ columns: cols, rows: rendered, gap: " " }));
            console.log(`\n${result.totals.ops} ops  (${input.sinceDays} days)`);
            return;
        }

        // Default: per-file rollup.
        type FileRow = {
            slug: string;
            kind: string;
            writes: string;
            edits: string;
            sessions: string;
            last_seen: string;
        };
        const rendered: FileRow[] = result.files.slice(0, input.limit).map((f) => ({
            slug: f.slug,
            kind: f.kind,
            writes: String(f.writes),
            edits: String(f.edits),
            sessions: String(f.sessions),
            last_seen: f.last_seen.replace("T", " ").replace(/\.\d+Z$/, ""),
        }));
        const cols: Column<FileRow>[] = [
            { header: "slug", get: (r) => r.slug, min: 28, overflow: "ellipsis" },
            { header: "kind", get: (r) => r.kind, width: 6 },
            { header: "writes", get: (r) => r.writes, align: "right", width: 7 },
            { header: "edits", get: (r) => r.edits, align: "right", width: 6 },
            { header: "sessions", get: (r) => r.sessions, align: "right", width: 9 },
            { header: "last_seen", get: (r) => r.last_seen, width: 19 },
        ];
        console.log(renderTable({ columns: cols, rows: rendered, gap: " " }));
        console.log(
            `\n${result.totals.notes} notes  ${result.totals.index_ops} index edits  ` +
            `${result.totals.ops} ops  ${result.totals.sessions} sessions  (${input.sinceDays} days)`,
        );
        console.log("note: memory writes only; recall isn't in the transcript (system-prompt injected).");
    });

const memoryOpsCommand = Command.make(
    "ops",
    {
        days: Flag.integer("days").pipe(Flag.withDefault(MEMORY_DEFAULT_WINDOW_DAYS)),
        events: Flag.boolean("events").pipe(Flag.withDefault(false)),
        limit: positiveLimit(40),
        json: jsonFlag,
    },
    ({ days, events, limit, json }) => {
        if (!Number.isInteger(days) || days <= 0) {
            fail(`ax memory ops: --days must be a positive integer (got "${days}")`);
        }
        return cmdMemoryOps({ sinceDays: days, events, limit, json });
    },
).pipe(
    Command.withDescription(
        "Claude memory-file activity (writes/edits to ~/.claude/.../memory/*.md). " +
        "Default: per-file rollup. --events for the raw stream. " +
        "--days=N (default 30)  --limit=N (default 40)  --json",
    ),
);

// ---------------------------------------------------------------------------
// ax memory (group command)
// ---------------------------------------------------------------------------

export const memoryCommand = Command.make("memory").pipe(
    Command.withDescription(
        "Claude memory analytics: what memories you've written, per file and session",
    ),
    Command.withSubcommands([memoryOpsCommand]),
);

export const axMemoryRuntime: RuntimeManifest = {
    memory: "db",
};
