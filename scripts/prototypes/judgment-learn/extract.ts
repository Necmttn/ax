/**
 * Phase 5 prototype (#895), step 1: extract the DECISION POPULATION - the
 * main-agent claude assistant turns `classifyTurn` actually has to decide on
 * (not adjacent to a user turn) - with the features a tiny model could use,
 * from the PUBLISHED snapshot.
 *
 * Outputs (into this directory):
 *   population.ndjson   one row per decision turn: features + text excerpts
 *   batches/batch-N.json  stratified label batches for the LLM labeler
 *
 * Run from the repo root: bun scripts/prototypes/judgment-learn/extract.ts
 * Pin AX_DUCKDB_SNAPSHOT + AX_NO_AUTO_INGEST=1 for a stable read.
 */
import { Effect, Schema } from "effect";
import { CacheRead, CacheReadLive } from "@ax/lib/duckdb/seam";
import { NumberFromBigIntColumn } from "@ax/lib/duckdb/columns";
import { JUDGMENT_GUARD_RE } from "../../../apps/axctl/src/queries/routing-tune.ts";

// Prototype-local copies of routability.ts's private tool sets (a landed
// version would export them; a prototype does not modify production code).
const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS"]);
const RESEARCH_TOOLS = new Set(["WebFetch", "WebSearch"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "Bash"]);

const OUT_DIR = new URL(".", import.meta.url).pathname;

const TurnRow = Schema.Struct({
    id: Schema.String,
    session: Schema.String,
    seq: NumberFromBigIntColumn,
    text: Schema.NullOr(Schema.String),
    prev_role: Schema.NullOr(Schema.String),
    next_role: Schema.NullOr(Schema.String),
    prev_text: Schema.NullOr(Schema.String),
});

const ToolRow = Schema.Struct({
    turn: Schema.String,
    name: Schema.String,
    command_norm: Schema.NullOr(Schema.String),
});

// Decision population: claude MAIN sessions (source = 'claude', not
// *-subagent), assistant turns whose neighbours are not user turns (those are
// classed `interactive` before any detector runs). 120-day window keeps the
// sample recent without starving strata.
const TURNS_SQL = `
    WITH ordered AS (
        SELECT t.id, t.session, CAST(t.seq AS BIGINT) AS seq, t.role, t.text,
               lag(t.role) OVER w AS prev_role,
               lead(t.role) OVER w AS next_role,
               lag(CASE WHEN t.role = 'assistant' THEN t.text END) OVER w AS prev_text
        FROM turn t
        JOIN session s ON s.id = t.session
        WHERE s.source = 'claude'
          AND t.ts > CAST(CURRENT_TIMESTAMP AS TIMESTAMP) - INTERVAL '120 days'
        WINDOW w AS (PARTITION BY t.session ORDER BY t.seq)
    )
    SELECT id, session, seq, text, prev_role, next_role, prev_text
    FROM ordered
    WHERE role = 'assistant'
      AND coalesce(prev_role, '') <> 'user'
      AND coalesce(next_role, '') <> 'user'`;

const TOOLS_SQL = `
    SELECT tc.turn, tc.name, tc.command_norm
    FROM tool_call tc
    JOIN session s ON s.id = tc.session
    WHERE s.source = 'claude'
      AND tc.ts > CAST(CURRENT_TIMESTAMP AS TIMESTAMP) - INTERVAL '121 days'`;

export interface PopRow {
    readonly id: string;
    readonly session: string;
    readonly seq: number;
    // features
    readonly editCount: number;
    readonly readCount: number;
    readonly researchCount: number;
    readonly otherToolCount: number;
    readonly textLen: number;
    readonly regexOwn: boolean;
    readonly regexPrev: boolean;
    readonly questionMarks: number;
    readonly codeFences: number;
    // labeler context
    readonly text: string;
    readonly prevText: string;
    readonly toolNames: readonly string[];
}

const excerpt = (s: string | null, cap: number): string => {
    if (!s) return "";
    return s.length <= cap ? s : `${s.slice(0, cap)}…[+${s.length - cap} chars]`;
};

const main = Effect.gen(function* () {
    const read = yield* CacheRead;
    const turns = yield* read.rows(TurnRow, TURNS_SQL);
    const tools = yield* read.rows(ToolRow, TOOLS_SQL);

    const toolsByTurn = new Map<string, { name: string; norm: string | null }[]>();
    for (const t of tools) {
        const list = toolsByTurn.get(t.turn);
        const entry = { name: t.name, norm: t.command_norm };
        if (list) list.push(entry);
        else toolsByTurn.set(t.turn, [entry]);
    }

    const rows: PopRow[] = turns.map((t) => {
        const calls = toolsByTurn.get(t.id) ?? [];
        let edit = 0, readC = 0, research = 0, other = 0;
        for (const c of calls) {
            if (EDIT_TOOLS.has(c.name)) edit++;
            else if (READ_TOOLS.has(c.name)) readC++;
            else if (RESEARCH_TOOLS.has(c.name)) research++;
            else other++;
        }
        const text = t.text ?? "";
        return {
            id: t.id, session: t.session, seq: t.seq,
            editCount: edit, readCount: readC, researchCount: research, otherToolCount: other,
            textLen: text.length,
            regexOwn: JUDGMENT_GUARD_RE.test(text),
            regexPrev: t.prev_text !== null && JUDGMENT_GUARD_RE.test(t.prev_text),
            questionMarks: (text.match(/\?/g) ?? []).length,
            codeFences: (text.match(/```/g) ?? []).length,
            text: excerpt(t.text, 1200),
            prevText: excerpt(t.prev_text, 600),
            toolNames: calls.map((c) => c.name),
        };
    });

    yield* Effect.promise(() =>
        Bun.write(`${OUT_DIR}population.ndjson`, rows.map((r) => JSON.stringify(r)).join("\n") + "\n"));

    // Stratified label sample: the gate is decided on held-out LABELS, so the
    // sample must cover both sides of the baseline's own decision boundary.
    const rand = (() => { let s = 0xa5eed; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();
    const shuffle = <T>(a: T[]): T[] => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; } return a; };
    const withText = rows.filter((r) => r.textLen > 0 || r.toolNames.length > 0);
    const strata: Record<string, PopRow[]> = {
        regexJudgment: shuffle(withText.filter((r) => r.regexOwn)).slice(0, 120),
        toolRoutable: shuffle(withText.filter((r) => !r.regexOwn && (r.editCount + r.readCount + r.researchCount) > 0)).slice(0, 120),
        proseOther: shuffle(withText.filter((r) => !r.regexOwn && (r.editCount + r.readCount + r.researchCount) === 0)).slice(0, 120),
    };
    const sample = shuffle(Object.values(strata).flat());
    const BATCH = 40;
    const { mkdirSync } = yield* Effect.promise(() => import("node:fs"));
    mkdirSync(`${OUT_DIR}batches`, { recursive: true });
    for (let i = 0; i * BATCH < sample.length; i++) {
        const batch = sample.slice(i * BATCH, (i + 1) * BATCH).map((r) => ({
            id: r.id,
            tools: r.toolNames,
            prev_assistant_text: r.prevText,
            text: r.text,
        }));
        yield* Effect.promise(() =>
            Bun.write(`${OUT_DIR}batches/batch-${i}.json`, JSON.stringify(batch, null, 1)));
    }
    console.log(JSON.stringify({
        population: rows.length,
        sample: sample.length,
        strata: Object.fromEntries(Object.entries(strata).map(([k, v]) => [k, v.length])),
        batches: Math.ceil(sample.length / BATCH),
    }));
});

await Effect.runPromise(main.pipe(Effect.provide(CacheReadLive), Effect.scoped));
