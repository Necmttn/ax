/**
 * ax dojo report - evidence-derived morning receipt.
 *
 * `renderReport` is a pure function over a `ReportData` struct (fully unit
 * tested). `gatherReport` is the Effect glue: it runs the two improve-loop
 * queries + the outbox lister + a quota read under per-source soft isolation -
 * a failing source contributes its empty value and never aborts the report.
 *
 * Spec: docs/superpowers/specs/2026-06-13-dojo-report-outbox-design.md
 */
import { Effect, FileSystem } from "effect";
import { SurrealClient } from "@ax/lib/db";
import {
    listProposalsCreatedSince,
    listVerdictsLockedSince,
    type CreatedProposalRow,
    type LockedVerdictRow,
} from "../improve/report-queries.ts";
import { defaultQuotaCachePath } from "../quota/cache.ts";
import { QuotaEnv } from "../quota/quota-env.ts";
import { getQuota } from "../quota/quota.ts";
import type { QuotaSnapshot } from "../quota/schema.ts";
import { computeBudgetEnvelope } from "./budget.ts";
import { windowLabel } from "./format.ts";
import { listDrafts, type OutboxDraft } from "./outbox.ts";
import { localDate } from "./paths.ts";
import type { BudgetEnvelope } from "./schema.ts";

export interface ReportData {
    /** local YYYY-MM-DD of the report's nowMs */
    readonly date: string;
    /** ISO cutoff: only verdicts/proposals at/after this are reported */
    readonly since: string;
    readonly generated_at: string;
    /** pre-formatted ending-budget summary line */
    readonly budgetLine: string;
    readonly verdicts: readonly LockedVerdictRow[];
    readonly proposals: readonly CreatedProposalRow[];
    readonly drafts: readonly OutboxDraft[];
    readonly notes: string;
}

/** "12% spendable (7d window, 27% left) [quota]" */
export const formatBudgetLine = (b: BudgetEnvelope): string =>
    `${b.spendable_pct}% spendable (${windowLabel(b.binding_window)}, ${b.window_remaining_pct}% left) [${b.source}]`;

const section = <T>(heading: string, rows: readonly T[], line: (row: T) => string): string => {
    const lines = rows.length === 0 ? ["- (none)"] : rows.map(line);
    return `## ${heading} (${rows.length})\n${lines.join("\n")}`;
};

/** Pure render of a report markdown document. */
export const renderReport = (data: ReportData): string => {
    const blocks: string[] = [
        `# Dojo report - ${data.date}`,
        `since ${data.since} - generated ${data.generated_at}`,
        `ending budget: ${data.budgetLine}`,
        section("Verdicts locked", data.verdicts, (v) => `- ${v.verdict} - ${v.title} (${v.sig})`),
        section("Proposals created", data.proposals, (p) => `- ${p.form} - ${p.title} (${p.dedupe_sig})`),
        section("Outbox drafts pending review", data.drafts, (d) => `- ${d.kind} - ${d.title} (${d.file})`),
    ];
    if (data.notes.trim().length > 0) {
        blocks.push(`## Notes\n${data.notes}`);
    }
    return `${blocks.join("\n\n")}\n`;
};

export interface GatherReportInput {
    readonly sinceMs: number;
    readonly nowMs: number;
    readonly notes: string;
    readonly outboxDir?: string;
}

/**
 * Run the two queries + outbox lister + quota read; each source degrades to
 * its empty value on failure so a flaky DB / missing dir / unreachable usage
 * endpoint never aborts the report.
 */
export const gatherReport = (
    input: GatherReportInput,
): Effect.Effect<ReportData, never, SurrealClient | FileSystem.FileSystem | QuotaEnv> =>
    Effect.gen(function* () {
        const since = new Date(input.sinceMs);

        const verdicts = yield* listVerdictsLockedSince(since).pipe(
            Effect.orElseSucceed(() => [] as LockedVerdictRow[]),
        );
        const proposals = yield* listProposalsCreatedSince(since).pipe(
            Effect.orElseSucceed(() => [] as CreatedProposalRow[]),
        );
        const drafts = yield* listDrafts(input.outboxDir).pipe(
            Effect.orElseSucceed(() => [] as OutboxDraft[]),
        );

        // Match the agenda command: quota read tolerates token/endpoint failure.
        const snapshot: QuotaSnapshot | null = yield* getQuota({
            cachePath: defaultQuotaCachePath(),
            maxAgeSeconds: 60,
            nowMs: input.nowMs,
        }).pipe(
            Effect.map((r) => r.snapshot),
            Effect.catch(() => Effect.succeed(null)),
        );

        const envelope = computeBudgetEnvelope(snapshot, {}, input.nowMs);

        return {
            date: localDate(input.nowMs),
            since: since.toISOString(),
            generated_at: new Date(input.nowMs).toISOString(),
            budgetLine: formatBudgetLine(envelope),
            verdicts,
            proposals,
            drafts,
            notes: input.notes,
        };
    });
