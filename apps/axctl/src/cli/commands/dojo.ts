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
import { Effect, FileSystem, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { posixPath } from "@ax/lib/shared/path";
import { ProcessService } from "@ax/lib/process";
import { prettyPrint } from "@ax/lib/json";
import { assembleAgenda, collectAgendaItems } from "../../dojo/agenda.ts";
import { computeBudgetEnvelope } from "../../dojo/budget.ts";
import { renderAgenda } from "../../dojo/format.ts";
import { writeDraft, listDrafts, type DraftKind } from "../../dojo/outbox.ts";
import {
    dojoReportPath,
    dojoReportsDir,
    dojoSparBriefPath,
    dojoSparDir,
    dojoSparReportPath,
    localDate,
} from "../../dojo/paths.ts";
import { gatherReport, renderReport } from "../../dojo/report.ts";
import {
    captureBaseline,
    fetchSessionMetrics,
    findVariantSession,
    parseSparBrief,
    renderSparBrief,
    renderSparReport,
    scoreSpar,
    stampSparSession,
} from "../../dojo/spar.ts";
import {
    buildSkillSparBrief,
    isSkillSparBrief,
    parseSkillSparBrief,
    renderSkillSparBrief,
    renderSkillSparReport,
    resolveSkillSparTask,
    scoreSkillSpar,
} from "../../dojo/skill-spar.ts";
import { mainRepoRootFromGitCommonDir, resolvePwdRepository } from "../../pwd.ts";
import { defaultQuotaCachePath } from "../../quota/cache.ts";
import { QuotaEnvLive } from "../../quota/quota-env.ts";
import { getQuota } from "../../quota/quota.ts";
import type { RuntimeManifest } from "./manifest.ts";
import { exitProcess, fail, jsonFlag, optionValue } from "./shared.ts";

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

/** Local YYYY-MM-DD for `nowMs` (single source: dojo/paths.ts). */
export { localDate };

const VALID_KINDS: ReadonlyArray<DraftKind> = ["bug", "improvement"];

/** Narrow a raw --kind value to a DraftKind, or null when it is invalid. */
export const isValidKind = (kind: string): kind is DraftKind =>
    (VALID_KINDS as ReadonlyArray<string>).includes(kind);

/**
 * Dispatch helper for spar-score: returns "skill" for skill-spar briefs
 * (frontmatter contains `kind: skill`), "code" for all others (code-delta
 * briefs have no `kind:` line, and garbage content falls through to "code").
 * Exported for unit testing.
 */
export const selectSparScoreKind = (content: string): "skill" | "code" =>
    isSkillSparBrief(content) ? "skill" : "code";

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
            const collected = yield* collectAgendaItems({ nowMs, days, spar });
            const agenda = assembleAgenda(envelope, collected.items, {
                nowMs,
                spar,
                sourceFailures: collected.source_failures,
            });
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
// ax dojo spar-plan <sha> - capture + freeze a baseline, emit an experiment brief
// ---------------------------------------------------------------------------

/**
 * Resolve the MAIN repository root, even when invoked from inside a linked
 * worktree. `git rev-parse --show-toplevel` (what resolvePwdRepository uses)
 * returns the LINKED worktree's own toplevel, so a spar worktree path that is
 * relative to the main repo would double-nest. `--git-common-dir` always points
 * at the main repo's `.git`; its parent dir is the main repo root. Falls back to
 * `repoRoot` when there is no linked worktree (or the rev-parse fails).
 */
const resolveMainRepoRoot = (repoRoot: string) =>
    Effect.gen(function* () {
        const proc = yield* ProcessService;
        const res = yield* proc.exec("git", ["rev-parse", "--git-common-dir"], {
            cwd: repoRoot,
        });
        // Shared with `resolvePwdRepository` so both call sites agree on how a
        // linked worktree maps back to its primary checkout.
        return mainRepoRootFromGitCommonDir(repoRoot, res.code === 0 ? res.stdout.trim() : "");
    });

/**
 * Resolve $PWD to its git repoRoot + repository record key (mirrors
 * `sessions near`), plus the MAIN repo root (worktree-aware) used to anchor the
 * spar worktree path the agent creates.
 */
const resolveRepo = Effect.gen(function* () {
    const pwd = yield* resolvePwdRepository().pipe(
        Effect.catchTag("NotAGitRepoError", (err) => {
            console.error(`ax dojo: not in a git repository (cwd=${err.cwd})`);
            return exitEffect(1);
        }),
    );
    const mainRepoRoot = yield* resolveMainRepoRoot(pwd.repoRoot);
    return {
        repoRoot: pwd.repoRoot,
        mainRepoRoot,
        repositoryKey: pwd.repositoryRecordId.id as string,
    };
});

/**
 * Pure flag-validation helper for `ax dojo spar-plan`.
 *
 * Returns an error message string when the supplied flags are mutually
 * exclusive or require another flag that is absent; returns null when valid.
 * Exported so tests can drive it without spawning the CLI (and without a
 * running SurrealDB).
 *
 * Rules:
 * - `--skill` and a positional `<sha>` are mutually exclusive.
 * - `--session` / `--sha` are skill-spar options; they require `--skill`.
 */
export const validateSparPlanFlags = (f: {
    skill: string;
    session: string;
    sha: string;
    positionalSha: string | undefined;
}): string | null => {
    if (f.skill !== "" && f.positionalSha !== undefined) {
        return "ax dojo spar-plan: --skill and positional <sha> are mutually exclusive - use --skill <name> for skill-spar or <sha> alone for code-delta";
    }
    if (f.skill === "" && (f.session !== "" || f.sha !== "")) {
        return "ax dojo spar-plan: --session/--sha require --skill (they scope the skill-spar baseline; code-delta mode takes a positional <sha>)";
    }
    return null;
};

/**
 * Convert a skill name to a filesystem-safe slug: non-alphanumeric chars →
 * `-`, consecutive dashes collapsed, leading/trailing dashes stripped.
 * e.g. "ax:dojo" → "ax-dojo", "my:skill:v2" → "my-skill-v2"
 */
export const makeSkillSlug = (name: string): string =>
    name
        .replace(/[^a-zA-Z0-9]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");

/**
 * Build the skill-spar brief id: `<slug>-<hash6>-<YYYY-MM-DD>`.
 *
 * The hash6 (6 hex chars of a stable hash of the SKILL NAME) disambiguates two
 * distinct skills that slug to the same string within a day (which would
 * otherwise silently overwrite each other's brief AND snapshot), and keeps the
 * id usable when the slug is empty (an all-non-alphanumeric name slugs to "").
 * The id flows into worktree branch names + file names + the spar-score <id>
 * lookup - all fine with the extra segment.
 */
export const makeSkillSparId = (skillName: string, now: Date): string => {
    const slug = makeSkillSlug(skillName);
    const hash6 = Bun.hash(skillName).toString(16).slice(0, 6);
    const date = now.toISOString().slice(0, 10);
    return slug ? `${slug}-${hash6}-${date}` : `${hash6}-${date}`;
};

const exitEffect = (code: number): Effect.Effect<never> =>
    Effect.promise(async () => exitProcess(code));

const sparPlanCommand = Command.make(
    "spar-plan",
    {
        positionalSha: Argument.string("sha").pipe(Argument.optional),
        json: jsonFlag,
        skill: Flag.string("skill").pipe(Flag.withDefault("")),
        session: Flag.string("session").pipe(Flag.withDefault("")),
        sha: Flag.string("sha").pipe(Flag.withDefault("")),
    },
    ({ positionalSha, json, skill, session, sha }) => {
        // Pure flag validation BEFORE any Effect/DB work. fail() calls
        // process.exit(2) synchronously so the DB layer is never initialised
        // when these guards fire - CI tests can assert the error messages
        // without a running SurrealDB instance.
        const flagErr = validateSparPlanFlags({
            skill,
            session,
            sha,
            positionalSha: Option.getOrUndefined(positionalSha),
        });
        if (flagErr !== null) fail(flagErr);

        return Effect.gen(function* () {
            if (skill !== "") {
                // ----------------------------------------------------------------
                // SKILL SPAR PATH
                // ----------------------------------------------------------------
                const { repoRoot, mainRepoRoot, repositoryKey } = yield* resolveRepo;

                // Single clock read so the id's date and createdAt can't skew
                // across a midnight boundary between two `new Date()` calls.
                const now = new Date();
                const id = makeSkillSparId(skill, now);
                const createdAt = now.toISOString();

                const task = yield* resolveSkillSparTask(skill, repoRoot, repositoryKey, {
                    ...(session ? { sessionId: session } : {}),
                    ...(sha ? { sha } : {}),
                }).pipe(
                    Effect.catchTag("SparCaptureError", (err) => {
                        console.error(`ax dojo spar-plan: ${err.message}`);
                        return exitEffect(1);
                    }),
                );

                const brief = buildSkillSparBrief(task, id, createdAt);

                // Absolute paths for spar assets (inside ~/.ax/dojo/spar/)
                const sparDir = dojoSparDir();
                const snapshotPathAbs = posixPath.join(sparDir, `${id}.skill.orig.md`);
                const editedPathAbs = posixPath.join(sparDir, `${id}.skill.edited.md`);

                // Absolute worktree paths anchored at MAIN repo root (same
                // pattern as the code-delta path below, so spar-score's cwd
                // resolution is consistent across both spar kinds).
                const worktreeAAbs = posixPath.join(mainRepoRoot, brief.worktreeA);
                const worktreeBAbs = posixPath.join(mainRepoRoot, brief.worktreeB);

                const fs = yield* FileSystem.FileSystem;
                yield* fs.makeDirectory(sparDir, { recursive: true });

                // Write the original skill snapshot atomically (tmp + rename).
                // This is the SOLE restore source for swap-out - after the live
                // SKILL.md is overwritten for Arm B, a truncated snapshot would
                // lose the original skill irrecoverably, so it must never be a
                // bare write.
                const snapTmp = `${snapshotPathAbs}.tmp.${process.pid}`;
                yield* fs.writeFileString(snapTmp, task.originalSkill);
                yield* fs.rename(snapTmp, snapshotPathAbs);
                // editedPathAbs is intentionally NOT written - the operator/agent fills it.

                // Write the brief (atomic rename).
                const briefPath = dojoSparBriefPath(brief.id);
                const tmp = `${briefPath}.tmp.${process.pid}`;
                yield* fs.writeFileString(
                    tmp,
                    renderSkillSparBrief(brief, {
                        worktreeAAbs,
                        worktreeBAbs,
                        snapshotPathAbs,
                        editedPathAbs,
                    }),
                );
                yield* fs.rename(tmp, briefPath);

                if (json) {
                    console.log(prettyPrint(brief));
                    return;
                }
                console.log(
                    `${briefPath}\n\nnext: write your edited skill to ${editedPathAbs}, run both arms (see the brief), then ax dojo spar-score ${brief.id}`,
                );
            } else {
                // ----------------------------------------------------------------
                // CODE-DELTA PATH (original behavior, 100% unchanged)
                // ----------------------------------------------------------------
                const shaStr = optionValue(positionalSha);
                if (!shaStr) {
                    fail(
                        "ax dojo spar-plan: provide a positional <sha> (code-delta mode) or --skill <name> (skill-spar mode)",
                    );
                }

                const { repoRoot, mainRepoRoot, repositoryKey } = yield* resolveRepo;
                const brief = yield* captureBaseline(
                    shaStr,
                    repoRoot,
                    repositoryKey,
                    new Date().toISOString(),
                ).pipe(
                    Effect.catchTag("SparCaptureError", (err) => {
                        console.error(`ax dojo spar-plan: ${err.message}`);
                        return exitEffect(1);
                    }),
                );

                // Anchor the worktree at the MAIN repo root so the brief's embedded
                // `git worktree add` command, the console hint, and spar-score's
                // variant cwd lookup (which joins brief.worktree against the same
                // main root) all agree on ONE absolute path - no matter which
                // (possibly linked) worktree the agent runs spar-plan from.
                const worktreeAbs = posixPath.join(mainRepoRoot, brief.worktree);

                const fs = yield* FileSystem.FileSystem;
                yield* fs.makeDirectory(dojoSparDir(), { recursive: true });
                const path = dojoSparBriefPath(brief.id);
                const tmp = `${path}.tmp.${process.pid}`;
                yield* fs.writeFileString(tmp, renderSparBrief(brief, worktreeAbs));
                yield* fs.rename(tmp, path);

                if (json) {
                    console.log(prettyPrint(brief));
                    return;
                }
                const worktreeCmd = `git worktree add ${worktreeAbs} -b dojo/spar-${brief.id} ${brief.parentSha}`;
                console.log(
                    `${path}\n\nNext:\n  ${worktreeCmd}\n  fill the Delta section, run the task in that worktree, then: ax dojo spar-score ${brief.id}`,
                );
            }
        });
    },
).pipe(
    Command.withDescription(
        "Capture + freeze a baseline and emit an experiment brief to ~/.ax/dojo/spar/<id>.md.\n" +
            "  Code-delta mode: ax dojo spar-plan <sha> [--json]\n" +
            "  Skill-spar mode: ax dojo spar-plan --skill <name> [--session <id>] [--sha <sha>] [--json]",
    ),
);

// ---------------------------------------------------------------------------
// ax dojo spar-score <id> - score the agent's variant against the frozen baseline
// ---------------------------------------------------------------------------

const sparScoreCommand = Command.make(
    "spar-score",
    {
        id: Argument.string("id"),
        variantSession: Flag.string("variant-session").pipe(Flag.withDefault("")),
        json: jsonFlag,
    },
    ({ id, variantSession, json }) =>
        Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const briefPath = dojoSparBriefPath(id);
            const content = yield* fs.readFileString(briefPath).pipe(
                Effect.catchTag("PlatformError", () => {
                    console.error(`ax dojo spar-score: no spar brief at ${briefPath}`);
                    return exitEffect(1);
                }),
            );
            if (selectSparScoreKind(content) === "skill") {
                // ----------------------------------------------------------------
                // SKILL SPAR PATH
                // ----------------------------------------------------------------
                const skillBrief = parseSkillSparBrief(content);
                if (skillBrief === null) {
                    console.error(
                        `ax dojo spar-score: could not parse skill-spar brief at ${briefPath}`,
                    );
                    return yield* exitEffect(1);
                }
                const { mainRepoRoot } = yield* resolveRepo;
                // sinceForChurn: same derivation as the code-delta path (new Date(brief.createdAt))
                const sinceForChurn = new Date(skillBrief.createdAt);
                const result = yield* scoreSkillSpar(skillBrief, mainRepoRoot, sinceForChurn).pipe(
                    Effect.catchTag("SparCaptureError", (err) => {
                        console.error(`ax dojo spar-score: ${err.message}`);
                        return exitEffect(1);
                    }),
                );
                yield* fs.makeDirectory(dojoSparDir(), { recursive: true });
                const path = dojoSparReportPath(id);
                const tmp = `${path}.tmp.${process.pid}`;
                yield* fs.writeFileString(tmp, renderSkillSparReport(result.score, skillBrief));
                yield* fs.rename(tmp, path);
                console.log(
                    json
                        ? prettyPrint({ ...result, id })
                        : renderSkillSparReport(result.score, skillBrief),
                );
                return;
            }

            // ----------------------------------------------------------------
            // CODE-DELTA PATH (original behavior, 100% unchanged)
            // ----------------------------------------------------------------
            const brief = parseSparBrief(content);
            if (brief === null) {
                console.error(`ax dojo spar-score: could not parse spar brief at ${briefPath}`);
                return yield* exitEffect(1);
            }

            // brief.worktree is relative to the MAIN repo root; sessions store an
            // absolute cwd, so resolve it against the worktree-aware main root
            // (not the linked-worktree toplevel, which would double-nest).
            const { mainRepoRoot } = yield* resolveRepo;
            const variantCwd = posixPath.join(mainRepoRoot, brief.worktree);

            let variantId: string | null;
            if (variantSession.length > 0) {
                variantId = variantSession;
            } else {
                variantId = yield* findVariantSession(variantCwd, Date.parse(brief.createdAt));
            }
            if (variantId === null) {
                console.error(
                    `ax dojo spar-score: no variant session found in ${variantCwd} since ${brief.createdAt} - has the agent run the task in the worktree yet?`,
                );
                return yield* exitEffect(1);
            }

            // Stamp the variant session's labels with "spar" so behavioral
            // analytics (ax skills weighted, ax thinking) can exclude it.
            // Idempotent and non-fatal: if the stamp fails, scoring still writes
            // the receipt (the label is best-effort telemetry).
            yield* stampSparSession(variantId).pipe(Effect.catch(() => Effect.void));

            const variant = yield* fetchSessionMetrics(variantId, new Date(brief.createdAt));
            const score = { ...scoreSpar(brief.baseline, variant), id, variantSession: variantId };

            yield* fs.makeDirectory(dojoSparDir(), { recursive: true });
            const path = dojoSparReportPath(id);
            const tmp = `${path}.tmp.${process.pid}`;
            yield* fs.writeFileString(tmp, renderSparReport(score, brief));
            yield* fs.rename(tmp, path);

            console.log(json ? prettyPrint(score) : renderSparReport(score, brief));
        }),
).pipe(
    Command.withDescription(
        "Score the agent's variant session against the frozen baseline and write a receipt to ~/.ax/dojo/spar/<id>-report.md. --variant-session=<id> --json",
    ),
);

// ---------------------------------------------------------------------------
// ax dojo (group)
// ---------------------------------------------------------------------------

export const dojoCommand = Command.make("dojo").pipe(
    Command.withDescription("Dojo training loop: agenda + report + outbox writers"),
    Command.withSubcommands([
        agendaCommand,
        reportCommand,
        draftCommand,
        outboxCommand,
        sparPlanCommand,
        sparScoreCommand,
    ]),
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
                "spar-plan": "db",
                "spar-score": "db",
            },
        },
        hidden: false,
    },
};
