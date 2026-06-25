/**
 * `ax otel` - OTLP receiver coverage + freshness view.
 *
 * Read-only, `db` runtime. Sibling of commands/ax-cost.ts. Answers "is harness
 * telemetry flowing into the receiver, and is it being correlated to sessions?"
 * - the receiver was previously write-only (data landed in otel_* tables and
 * only enriched insights, with no surface to inspect it).
 */
import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { prettyPrint } from "@ax/lib/json";
import {
    OTEL_DEFAULT_WINDOW_DAYS,
    fetchOtelRollup,
    formatAge,
    healthGlyph,
    type OtelRollupResult,
} from "../../queries/otel-rollup.ts";
import { integer, usd } from "../render.ts";
import { renderTable } from "../table.js";
import type { Column } from "../table.js";
import type { RuntimeManifest } from "./manifest.ts";
import { fail, jsonFlag } from "./shared.ts";

export function renderOtelRollup(result: OtelRollupResult): string {
    const out: string[] = [];

    if (result.signals.length === 0) {
        out.push("(no OTLP telemetry received - is `ax serve` running and the harness configured? `ax install` writes the config)");
    } else {
        type Row = { sig: string; n: string; last: string };
        const rows: Row[] = result.signals.map((s) => ({
            sig: `${healthGlyph(s.health)} ${s.harness}/${s.signal}`,
            n: integer(s.count),
            last: formatAge(s.age_ms),
        }));
        const cols: Column<Row>[] = [
            { header: "signal", get: (r) => r.sig, min: 22 },
            { header: "rows", get: (r) => r.n, align: "right", min: 10 },
            { header: "last", get: (r) => r.last, align: "right", min: 6 },
        ];
        out.push(renderTable({ columns: cols, rows, gap: "  " }));
        out.push("  ✓ flowing (<6h)   ⚠ stale (<48h)   ✗ cold   · none");
    }

    const c = result.coverage;
    out.push("");
    out.push(`correlation: ${integer(c.linked_sessions)}/${integer(c.window_sessions)} sessions linked (${c.pct}%)  [${result.since_days}d]`);
    const hasOtlp = result.signals.some((s) => s.count > 0);
    if (hasOtlp && c.window_sessions > 0 && c.pct === 0) {
        out.push("  ⚠ telemetry is arriving but 0% is correlated to sessions - the telemetry_of pass is drawing no edges (check session.id matching)");
    }

    out.push("");
    const otlp = result.cost.otlp_usd === null ? "n/a" : usd(result.cost.otlp_usd);
    const transcript = result.cost.transcript_usd === null ? "n/a" : usd(result.cost.transcript_usd);
    out.push(`cost [${result.since_days}d]: otlp ${otlp} (claude cost metric)   ·   transcript ${transcript} (all sources)`);

    return out.join("\n");
}

const cmdOtel = (input: { readonly sinceDays: number; readonly json: boolean }) =>
    Effect.gen(function* () {
        const result = yield* fetchOtelRollup({ sinceDays: input.sinceDays });
        if (input.json) {
            console.log(prettyPrint(result));
            return;
        }
        console.log(renderOtelRollup(result));
    });

export const otelCommand = Command.make(
    "otel",
    {
        days: Flag.integer("days").pipe(Flag.withDefault(OTEL_DEFAULT_WINDOW_DAYS)),
        json: jsonFlag,
    },
    ({ days, json }) => {
        if (!Number.isInteger(days) || days <= 0) {
            fail(`ax otel: --days must be a positive integer (got "${days}")`);
        }
        return cmdOtel({ sinceDays: days, json });
    },
).pipe(
    Command.withDescription(
        "OTLP receiver health: per-harness signal freshness, session correlation coverage, "
        + "and OTLP vs transcript cost. --days=N (default 14)  --json",
    ),
);

export const axOtelRuntime: RuntimeManifest = {
    otel: "db",
};
