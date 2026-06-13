/**
 * `ax dojo` - the dojo training loop, a command family.
 * Spec: docs/superpowers/specs/2026-06-13-ax-dojo-design.md
 *      + docs/superpowers/specs/2026-06-13-dojo-report-outbox-design.md
 *
 *   ax dojo agenda [--json]   budget envelope + prioritized training agenda
 *   ax dojo report [--json]   evidence-derived morning receipt (writes ~/.ax/dojo/reports/<date>.md)
 *   ax dojo draft  ...        stage an upstream issue draft into ~/.ax/dojo/outbox/
 *   ax dojo outbox [--json]   list pending outbox drafts
 *
 * Effect's effect/unstable/cli does not support a parent handler alongside
 * subcommands, so the root is handler-less (withSubcommands). The quota
 * snapshot is fetched with error tolerance: if the usage endpoint (and cache)
 * are unavailable, the budget degrades to "unavailable" but the agenda/report
 * still render - their items are derived from the local graph, not the quota
 * API.
 */
import { Effect, FileSystem } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { prettyPrint } from "@ax/lib/json";
import { assembleAgenda, collectAgendaItems } from "../../dojo/agenda.ts";
import { computeBudgetEnvelope } from "../../dojo/budget.ts";
import { renderAgenda } from "../../dojo/format.ts";
import { writeDraft, listDrafts, type DraftKind } from "../../dojo/outbox.ts";
import { dojoReportPath, dojoReportsDir } from "../../dojo/paths.ts";
import { gatherReport, renderReport } from "../../dojo/report.ts";
import { defaultQuotaCachePath } from "../../quota/cache.ts";
import { QuotaEnvLive } from "../../quota/quota-env.ts";
import { getQuota } from "../../quota/quota.ts";
import type { RuntimeManifest } from "./manifest.ts";
import { fail, jsonFlag } from "./shared.ts";

// ---------------------------------------------------------------------------
// pure resolution helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** "HH:MM" today (or tomorrow when already past) -> ISO */
export const untilToIso = (until: string, nowMs: number): string | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(until);
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    const d = new Date(nowMs);
    d.setHours(h, min, 0, 0);
    if (d.getTime() <= nowMs) d.setDate(d.getDate() + 1);
    return d.toISOString();
};

/** Epoch-ms of local midnight for the day containing `nowMs`. */
export const startOfLocalDay = (nowMs: number): number => {
    const d = new Date(nowMs);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
};

/** Local YYYY-MM-DD for `nowMs`. */
export const localDate = (nowMs: number): string => {
    const d = new Date(nowMs);
    const y = d.getFullYear();
    const m = `${d.getMonth() + 1}`.padStart(2, "0");
    const day = `${d.getDate()}`.padStart(2, "0");
    return `${y}-${m}-${day}`;
};

const VALID_KINDS: ReadonlyArray<DraftKind> = ["bug", "improvement"];

/** Narrow a raw --kind value to a DraftKind, or null when it is invalid. */
export const isValidKind = (kind: string): kind is DraftKind =>
    (VALID_KINDS as ReadonlyArray<string>).includes(kind);

// ---------------------------------------------------------------------------
// ax dojo agenda
// ---------------------------------------------------------------------------

const agendaCommand = Command.make(
    "agenda",
    {
        json: jsonFlag,
        budget: Flag.integer("budget").pipe(Flag.withDefault(0)), // 0 = unset
        until: Flag.string("until").pipe(Flag.withDefault("")),
        force: Flag.boolean("force").pipe(Flag.withDefault(false)),
        spar: Flag.boolean("spar").pipe(Flag.withDefault(false)),
        days: Flag.integer("days").pipe(Flag.withDefault(30)),
    },
    ({ json, budget, until, force, spar, days }) => {
        const nowMs = Date.now();
        return Effect.gen(function* () {
            const quota = yield* getQuota({
                cachePath: defaultQuotaCachePath(),
                maxAgeSeconds: 60,
                nowMs,
            }).pipe(
                Effect.map((r) => r.snapshot),
                Effect.catch(() => Effect.succeed(null)), // budget degrades, agenda still renders
            );
            const untilIso = until ? untilToIso(until, nowMs) : null;
            if (until && untilIso === null) {
                console.error("ax dojo agenda: invalid --until, expected HH:MM"); // degrade, don't fail
            }
            const envelope = computeBudgetEnvelope(
                quota,
                {
                    budgetPctOverride: budget > 0 ? budget : null,
                    untilIso,
                    force,
                },
                nowMs,
            );
            const items = yield* collectAgendaItems({ nowMs, days, spar });
            const agenda = assembleAgenda(envelope, items, { nowMs, spar });
            console.log(json ? prettyPrint(agenda) : renderAgenda(agenda));
        }).pipe(Effect.provide(QuotaEnvLive));
    },
).pipe(
    Command.withDescription(
        "Training agenda: quota budget envelope + prioritized self-improvement work items (--budget=N, --until=HH:MM, --spar, --force, --days=N, --json; consumed by the ax:dojo skill loop)",
    ),
);

// ---------------------------------------------------------------------------
// ax dojo report
// ---------------------------------------------------------------------------

const reportCommand = Command.make(
    "report",
    {
        json: jsonFlag,
        since: Flag.string("since").pipe(Flag.withDefault("")),
        notesFile: Flag.string("notes-file").pipe(Flag.withDefault("")),
    },
    ({ json, since, notesFile }) => {
        const nowMs = Date.now();
        return Effect.gen(function* () {
            // --since ISO; bad/absent -> start of the local day.
            let sinceMs = startOfLocalDay(nowMs);
            if (since) {
                const parsed = Date.parse(since);
                if (Number.isNaN(parsed)) {
                    console.error(
                        `ax dojo report: invalid --since "${since}", falling back to start of today`,
                    );
                } else {
                    sinceMs = parsed;
                }
            }

            const fs = yield* FileSystem.FileSystem;

            // --notes-file: empty string on any absence/read error.
            const notes = notesFile
                ? yield* fs.readFileString(notesFile).pipe(Effect.orElseSucceed(() => ""))
                : "";

            const data = yield* gatherReport({ sinceMs, nowMs, notes });

            // Atomic write: tmp + rename into the reports dir.
            const dir = dojoReportsDir();
            yield* fs.makeDirectory(dir, { recursive: true });
            const path = dojoReportPath(localDate(nowMs));
            const tmp = `${path}.tmp.${process.pid}`;
            yield* fs.writeFileString(tmp, renderReport(data));
            yield* fs.rename(tmp, path);

            console.log(json ? prettyPrint(data) : renderReport(data));
        }).pipe(Effect.provide(QuotaEnvLive));
    },
).pipe(
    Command.withDescription(
        "Evidence-derived morning report: verdicts locked + proposals created since --since (default start of today), pending outbox drafts, ending budget. Writes ~/.ax/dojo/reports/<date>.md. --since=<iso>  --notes-file=<path>  --json",
    ),
);

// ---------------------------------------------------------------------------
// ax dojo draft
// ---------------------------------------------------------------------------

const draftCommand = Command.make(
    "draft",
    {
        json: jsonFlag,
        title: Flag.string("title"),
        kind: Flag.string("kind"),
        bodyFile: Flag.string("body-file").pipe(Flag.withDefault("")),
        session: Flag.string("session").pipe(Flag.withDefault("")),
    },
    ({ json, title, kind, bodyFile, session }) => {
        if (!isValidKind(kind)) {
            fail(`ax dojo draft: --kind must be one of bug|improvement (got "${kind}")`);
        }
        const nowMs = Date.now();
        return Effect.gen(function* () {
            const body =
                bodyFile === "-"
                    ? yield* Effect.tryPromise(() => Bun.stdin.text()).pipe(
                          Effect.orElseSucceed(() => ""),
                      )
                    : bodyFile
                        ? yield* Effect.tryPromise(() => Bun.file(bodyFile).text()).pipe(
                              Effect.orElseSucceed(() => ""),
                          )
                        : "";
            const res = yield* writeDraft({
                title,
                kind,
                body,
                session: session || null,
                nowMs,
            });
            console.log(
                json
                    ? prettyPrint({ path: res.path, slug: res.slug, title, kind })
                    : res.path,
            );
        });
    },
).pipe(
    Command.withDescription(
        "Stage an upstream issue draft into ~/.ax/dojo/outbox/ (publish stays manual). --title=<s> --kind=bug|improvement [--body-file=<path>|- for stdin] [--session=<id>] --json",
    ),
);

// ---------------------------------------------------------------------------
// ax dojo outbox
// ---------------------------------------------------------------------------

const reltime = (createdAt: string, nowMs: number): string => {
    const t = Date.parse(createdAt);
    if (Number.isNaN(t)) return createdAt;
    const mins = Math.max(0, Math.round((nowMs - t) / 60000));
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 48) return `${hrs}h ago`;
    return `${Math.round(hrs / 24)}d ago`;
};

const outboxCommand = Command.make(
    "outbox",
    { json: jsonFlag },
    ({ json }) => {
        const nowMs = Date.now();
        return Effect.gen(function* () {
            const drafts = yield* listDrafts();
            if (json) {
                console.log(prettyPrint(drafts));
                return;
            }
            if (drafts.length === 0) {
                console.log("no pending drafts");
                return;
            }
            const titleW = Math.max(5, ...drafts.map((d) => d.title.length));
            const kindW = Math.max(4, ...drafts.map((d) => d.kind.length));
            console.log(
                `${"title".padEnd(titleW)}  ${"kind".padEnd(kindW)}  ${"created".padEnd(9)}  file`,
            );
            for (const d of drafts) {
                console.log(
                    `${d.title.padEnd(titleW)}  ${d.kind.padEnd(kindW)}  ${reltime(d.created_at, nowMs).padEnd(9)}  ${d.file}`,
                );
            }
        });
    },
).pipe(
    Command.withDescription(
        "List pending upstream issue drafts in ~/.ax/dojo/outbox/. --json",
    ),
);

// ---------------------------------------------------------------------------
// ax dojo (group)
// ---------------------------------------------------------------------------

export const dojoCommand = Command.make("dojo").pipe(
    Command.withDescription("Dojo training loop: agenda + report + outbox writers"),
    Command.withSubcommands([agendaCommand, reportCommand, draftCommand, outboxCommand]),
);

export const dojoRuntime: RuntimeManifest = {
    dojo: {
        runtime: {
            kind: "db-conditional",
            fallback: "none",
            subcommands: {
                agenda: "db",
                report: "db",
                draft: "none",
                outbox: "none",
            },
        },
        hidden: false,
    },
};
