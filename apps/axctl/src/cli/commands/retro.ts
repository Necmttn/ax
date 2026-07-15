// Extracted from cli/index.ts (Phase 2 CLI split)
import { Effect, FileSystem, Path } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { SurrealClient } from "@ax/lib/db";
import { prettyPrint } from "@ax/lib/json";
import { safeJsonParse } from "@ax/lib/shared/safe-json";
import { prettifyProjectSlug } from "@ax/lib/shared/project-slug";
import { recordRef } from "@ax/lib/shared/surql";
import { retroFromSession, upsertRetro, type RetroSource } from "../../ingest/retro.ts";
import { cmdRetroReflect } from "../retro-reflect.ts";
import { cmdRetroMeta } from "../retro-meta.ts";
import { cmdRetroPlan } from "../retro-plan.ts";
import type { RuntimeManifest } from "./manifest.ts";
import { boolArg, fail, jsonFlag, optionValue, positiveLimit, requirePositiveInt, stringArg } from "./shared.ts";

/**
 * `ax retro emit` - create/update a retro node + `session -> reviewed -> retro`.
 *
 * Default mode derives a small heuristic payload from the normalized session
 * (last user intent, corrections, tool failures). `--from-file=<json>` ingests
 * an external reviewer payload: `{ tried, worked?, failed?, next? }`.
 *
 * Intended hook path: Claude Code Stop hook writes reviewer JSON and emits it
 * from the file. Source defaults to claude_stop_hook unless
 * --source=<value> overrides. The Stop hook recipe in docs/HOOKS.md
 * uses this path.
 */
const cmdRetroEmit = (input: {
    readonly session: string | undefined;
    readonly fromFile: string | undefined;
    readonly source: string | undefined;
    readonly json: boolean;
}) =>
    Effect.gen(function* () {
        const fromFile = input.fromFile;
        const sessionFlag = input.session ?? process.env.AX_SESSION_ID;
        const sourceFlag = (input.source ?? (fromFile ? "claude_stop_hook" : "heuristic")) as RetroSource;
        const json = input.json;
        const db = yield* SurrealClient;

        let sessionRecordId = sessionFlag;
        if (!sessionRecordId) {
            const latest = yield* db.query<[Array<{ id: string | { tb: string; id: string } }>]>(
                "SELECT id, started_at FROM session ORDER BY started_at DESC LIMIT 1;",
            );
            const row = (latest?.[0] ?? [])[0];
            if (!row) {
                fail("ax retro emit: no session to retro on (no --session and no rows in DB)");
            }
            const idStr = typeof row.id === "string" ? row.id : `session:${row.id.id}`;
            sessionRecordId = idStr;
        }
        if (!sessionRecordId.includes(":")) sessionRecordId = `session:${sessionRecordId}`;

        if (fromFile) {
            const raw = yield* Effect.promise(() => Bun.file(fromFile).text().catch((e) => {
                fail(`ax retro emit: could not read --from-file=${fromFile}: ${e}`);
                return "";
            }));
            const parsed = safeJsonParse<{ tried?: string; worked?: string; failed?: string; next?: string }>(raw);
            if (!parsed) {
                fail(`ax retro emit: --from-file is not valid JSON`);
            }
            if (!parsed.tried) {
                fail("ax retro emit: payload missing required `tried` field");
            }
            const sessionKey = sessionRecordId.split(":").slice(1).join(":").replace(/`/g, "");
            yield* upsertRetro({
                sessionId: sessionKey,
                source: sourceFlag,
                payload: {
                    tried: String(parsed.tried),
                    worked: parsed.worked ?? null,
                    failed: parsed.failed ?? null,
                    next: parsed.next ?? null,
                },
                raw,
            });
            if (json) {
                console.log(prettyPrint({ session: sessionRecordId, source: sourceFlag, payload: parsed }));
            } else {
                console.log(`retro ${sourceFlag} for ${sessionRecordId}: ${parsed.tried.slice(0, 80)}…`);
            }
            return;
        }

        const retroInput = yield* retroFromSession(sessionRecordId);
        if (!retroInput) {
            fail(`ax retro emit: session ${sessionRecordId} not found`);
        }
        yield* upsertRetro(retroInput);
        if (json) {
            console.log(prettyPrint({ session: sessionRecordId, source: retroInput.source, payload: retroInput.payload }));
            return;
        }
        console.log(`retro ${retroInput.source} for ${sessionRecordId}`);
        console.log(`  tried   ${retroInput.payload.tried}`);
        if (retroInput.payload.worked) console.log(`  worked  ${retroInput.payload.worked}`);
        if (retroInput.payload.failed) console.log(`  failed  ${retroInput.payload.failed}`);
        if (retroInput.payload.next) console.log(`  next    ${retroInput.payload.next}`);
    });

const cmdRetroList = (input: {
    readonly limit: number;
    readonly since: string | undefined;
    readonly json: boolean;
}) =>
    Effect.gen(function* () {
        const json = input.json;
        const limit = requirePositiveInt("retro list", "limit", input.limit);
        const since = input.since;
        const db = yield* SurrealClient;
        const where = since ? `WHERE created_at > time::now() - ${parseInt(since, 10) || 7}d` : "";
        const rows = yield* db.query<[Array<Record<string, unknown>>]>(
            `SELECT id, session, source, tried, failed, next, type::string(created_at) AS created_at
             FROM retro ${where} ORDER BY created_at DESC LIMIT ${limit};`,
        );
        const list = rows?.[0] ?? [];
        if (json) { console.log(prettyPrint(list)); return; }
        if (list.length === 0) { console.log("(no retros yet - try `ax retro emit`)"); return; }
        for (const row of list) {
            const tried = String(row.tried ?? "").slice(0, 60);
            console.log(`${String(row.created_at ?? "?")}  [${String(row.source ?? "?")}]  ${String(row.session ?? "?")}`);
            console.log(`  ${tried}${tried.length >= 60 ? "…" : ""}`);
            if (row.failed) console.log(`  ! ${String(row.failed).slice(0, 60)}`);
            if (row.next) console.log(`  → ${String(row.next).slice(0, 60)}`);
        }
    });

/**
 * `ax retro pending` - sessions that lack a `reviewed` edge to any retro.
 *
 * A session is "pending retro" when:
 *   - it has no outbound `reviewed` edge, AND
 *   - it looks finished: either `ended_at` is set, or the last turn was
 *     more than --idle-min minutes ago (user closed the tab, no explicit
 *     end marker).
 *
 * Drives the quota-arbitrage flow: idle Opus budget chews through the
 * backlog via the retro-reviewer subagent.
 */
interface PendingSessionRow {
    readonly id: string | { tb: string; id: string };
    readonly project: string | null;
    readonly source: string | null;
    readonly model: string | null;
    readonly started_at: string | null;
    readonly ended_at: string | null;
    readonly last_turn_at: string | null;
    readonly turns: number;
}

export interface PendingSession {
    readonly sessionId: string;     // `session:<key>` record id
    readonly key: string;           // bare key (UUID, no prefix)
    readonly project: string | null;
    readonly source: string | null;
    readonly model: string | null;
    readonly startedAt: string | null;
    readonly endedAt: string | null;
    readonly lastTurnAt: string | null;
    readonly turns: number;
    readonly reason: "ended_at" | "idle";
}

/**
 * Two-pass query so we don't pay for per-session turn subqueries on the
 * common path:
 *
 *   1. Sessions with `ended_at` set in the window. Cheap. Most rows.
 *   2. Sessions w/o `ended_at` whose `started_at` is older than the idle
 *      threshold. Approximation - assumes "no end marker AND old start"
 *      means the user walked away. Fast.
 *
 * `turns` is fetched lazily inside `ax retro brief`, not here, because
 * the per-session `count(turn)` subquery is what blew up the v0 query.
 */
interface PendingQueryOpts {
    readonly sinceDays: number;
    readonly idleMinutes: number;
    readonly includeSubagents: boolean;
    readonly limit: number;
}

const queryPendingSessions = (opts: PendingQueryOpts) =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        // claude-subagent sessions are orchestrated children; their retros
        // belong to the parent session's review. Exclude unless asked.
        const subagentFilter = opts.includeSubagents ? "" : "AND source != 'claude-subagent'";
        const endedRows = yield* db.query<[Array<{
            id: PendingSessionRow["id"]; project: string | null; source: string | null;
            model: string | null; started_at: string | null; ended_at: string | null;
        }>]>(`
            SELECT id, project, source, model,
                type::string(started_at) AS started_at,
                type::string(ended_at) AS ended_at
            FROM session
            WHERE count(->reviewed) = 0
              AND ended_at != NONE
              AND ended_at > time::now() - ${opts.sinceDays}d
              ${subagentFilter}
            ORDER BY ended_at DESC
            LIMIT ${opts.limit};
        `);
        const idleRows = yield* db.query<[Array<{
            id: PendingSessionRow["id"]; project: string | null; source: string | null;
            model: string | null; started_at: string | null;
        }>]>(`
            SELECT id, project, source, model,
                type::string(started_at) AS started_at
            FROM session
            WHERE count(->reviewed) = 0
              AND ended_at = NONE
              AND started_at != NONE
              AND started_at > time::now() - ${opts.sinceDays}d
              AND started_at < time::now() - ${opts.idleMinutes}m
              ${subagentFilter}
            ORDER BY started_at DESC
            LIMIT ${opts.limit};
        `);

        const recordIdOf = (id: PendingSessionRow["id"]): string =>
            typeof id === "string" ? id : `session:${id.id}`;
        const keyOf = (recordId: string): string =>
            recordId.startsWith("session:")
                ? recordId.slice("session:".length).replace(/`/g, "")
                : recordId;

        const out: PendingSession[] = [];
        for (const row of (endedRows?.[0] ?? [])) {
            const sessionRecordId = recordIdOf(row.id);
            out.push({
                sessionId: sessionRecordId,
                key: keyOf(sessionRecordId),
                project: row.project,
                source: row.source,
                model: row.model,
                startedAt: row.started_at,
                endedAt: row.ended_at,
                lastTurnAt: null,
                turns: 0,
                reason: "ended_at",
            });
        }
        for (const row of (idleRows?.[0] ?? [])) {
            const sessionRecordId = recordIdOf(row.id);
            out.push({
                sessionId: sessionRecordId,
                key: keyOf(sessionRecordId),
                project: row.project,
                source: row.source,
                model: row.model,
                startedAt: row.started_at,
                endedAt: null,
                lastTurnAt: null,
                turns: 0,
                reason: "idle",
            });
        }
        return out;
    });

const cmdRetroPending = (input: {
    readonly since: number;
    readonly idleMin: number;
    readonly limit: number;
    readonly includeSubagents: boolean;
    readonly json: boolean;
}) =>
    Effect.gen(function* () {
        const json = input.json;
        const includeSubagents = input.includeSubagents;
        const sinceDays = Math.max(1, input.since || 7);
        const idleMinutes = Math.max(1, input.idleMin || 30);
        const limit = Math.max(1, input.limit || 20);
        const pending = yield* queryPendingSessions({ sinceDays, idleMinutes, includeSubagents, limit });
        if (json) {
            console.log(prettyPrint(pending));
            return;
        }
        if (pending.length === 0) {
            console.log(`(no pending retros in last ${sinceDays}d${includeSubagents ? "" : ", excluding subagents"})`);
            return;
        }
        const subAgentHint = includeSubagents ? "" : " (subagents hidden - pass --include-subagents to show)";
        console.log(`${pending.length} session(s) pending retro, since=${sinceDays}d limit=${limit}${subAgentHint}:`);
        for (const s of pending) {
            const proj = s.project ? prettifyProjectSlug(s.project) : "?";
            const when = s.endedAt ?? s.startedAt ?? "?";
            console.log(`  ${s.sessionId}  [${s.source ?? "?"}]  ${proj}  ${s.reason}=${when}`);
        }
    });

/**
 * `ax retro brief --session=<id>` - write `.ax/tasks/retro/<key>.md` brief
 * the retro-reviewer subagent consumes.
 *
 * Suggested-model heuristic: short, error-free sessions → haiku; sessions
 * with many turns, corrections, or tool errors → opus. The brief embeds
 * the suggestion as advisory metadata; the dispatcher picks the model.
 */
export const formatRetroBrief = (s: PendingSession, transcriptPath: string | null, suggestedModel: string): string => {
    const fm = [
        "---",
        "kind: retro",
        `session_id: ${s.sessionId}`,
        `session_key: ${s.key}`,
        s.project ? `project: ${s.project}` : null,
        s.source ? `source: ${s.source}` : null,
        s.model ? `model_used: ${s.model}` : null,
        `turns: ${s.turns}`,
        s.startedAt ? `started_at: ${s.startedAt}` : null,
        (s.endedAt ?? s.lastTurnAt) ? `ended_at: ${s.endedAt ?? s.lastTurnAt}` : null,
        `pending_reason: ${s.reason}`,
        `suggested_model: ${suggestedModel}`,
        transcriptPath ? `transcript: ${transcriptPath}` : null,
        "status: pending",
        "---",
    ].filter((line): line is string => line !== null).join("\n");

    const body = `# Retro: ${s.sessionId}

Review the prior session and emit findings. Source of truth is the normalized Turn view:
\`ax sessions show ${s.sessionId} --turns --json\`.

raw transcript (harness-specific, large): \`${transcriptPath ?? "(unknown - check raw_file on the session record)"}\`

## What to look for

- **Worked**: which moves landed; which skills/tools fired and helped.
- **Failed**: corrections, retries, dead-ends, tool errors. Pattern over single events.
- **Model fit**: was \`${s.model ?? "?"}\` overkill (cheap rote work) or undersized (visible struggle)?
- **Missing scaffolding**: behaviors a skill / hook / subagent would've prevented.

## Required output

Run these from the repo whose session this was:

\`\`\`bash
ax retro emit --session=${s.sessionId} --source=manual --from-file=<path-to-json>
\`\`\`

…where the JSON file contains \`{tried, worked, failed, next}\`. If you
spot a repeated pattern (≥2 occurrences in this session, or rhymes with
prior retros), also call:

\`\`\`bash
ax improve recommend ...
\`\`\`

When done, update this file's frontmatter \`status: completed\`. The next
\`ax retro pending\` call will exclude this session because the
\`reviewed\` edge now exists.
`;
    return `${fm}\n\n${body}`;
};

const suggestModelFor = (s: PendingSession): string => {
    if (s.turns >= 40) return "opus";
    if (s.turns <= 5) return "haiku";
    return "sonnet";
};

const cmdRetroBrief = (input: {
    readonly session: string;
    readonly outDir: string | undefined;
    readonly json: boolean;
}) =>
    Effect.gen(function* () {
        // Required Flag.string("session") makes the old missing-session guard unreachable.
        const sessionFlag = input.session;
        const outDirFlag = input.outDir;
        const json = input.json;
        const rawSession = sessionFlag.startsWith("session:")
            ? sessionFlag.slice("session:".length).replace(/`/g, "")
            : sessionFlag;
        const sessionRef = recordRef("session", rawSession);
        const sessionRecordId = `session:${rawSession}`;
        const db = yield* SurrealClient;
        const rows = yield* db.query<[Array<{
            id: string | { tb: string; id: string };
            project: string | null;
            source: string | null;
            model: string | null;
            started_at: string | null;
            ended_at: string | null;
            raw_file: string | null;
            last_turn_at: string | null;
            turns: number;
        }>]>(`
            SELECT
                id, project, source, model, raw_file,
                type::string(started_at) AS started_at,
                type::string(ended_at) AS ended_at,
                type::string((SELECT VALUE math::max(ts) FROM turn WHERE session = $parent.id GROUP ALL)[0]) AS last_turn_at,
                (SELECT count() FROM turn WHERE session = $parent.id GROUP ALL)[0].count ?? 0 AS turns
            FROM ${sessionRef} LIMIT 1;
        `);
        const row = (rows?.[0] ?? [])[0];
        if (!row) {
            fail(`ax retro brief: session ${sessionRecordId} not found`);
        }
        const idStr = typeof row.id === "string" ? row.id : `session:${row.id.id}`;
        const key = idStr.startsWith("session:") ? idStr.slice("session:".length).replace(/`/g, "") : idStr;
        const session: PendingSession = {
            sessionId: idStr,
            key,
            project: row.project,
            source: row.source,
            model: row.model,
            startedAt: row.started_at,
            endedAt: row.ended_at,
            lastTurnAt: row.last_turn_at,
            turns: row.turns ?? 0,
            reason: row.ended_at ? "ended_at" : "idle",
        };
        const suggested = suggestModelFor(session);
        const transcriptPath = row.raw_file ?? null;
        const body = formatRetroBrief(session, transcriptPath, suggested);

        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const outDir = path.resolve(outDirFlag ?? path.join(process.cwd(), ".ax", "tasks", "retro"));
        yield* fs.makeDirectory(outDir, { recursive: true }).pipe(Effect.orDie);
        const safeKey = key.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
        const filePath = path.join(outDir, `${safeKey}.md`);
        yield* fs.writeFileString(filePath, body).pipe(Effect.orDie);

        if (json) {
            console.log(prettyPrint({ session: idStr, path: filePath, suggested_model: suggested, transcript: transcriptPath }));
            return;
        }
        console.log(`brief: ${filePath}`);
        console.log(`  session=${idStr}  turns=${session.turns}  suggested_model=${suggested}`);
        if (transcriptPath) console.log(`  transcript=${transcriptPath}`);
    });

const retroEmitCommand = Command.make(
    "emit",
    {
        session: Flag.string("session").pipe(Flag.optional),
        fromFile: Flag.string("from-file").pipe(Flag.optional),
        source: Flag.string("source").pipe(Flag.optional),
        json: jsonFlag,
    },
    ({ session, fromFile, source, json }) => cmdRetroEmit({
        session: optionValue(session),
        fromFile: optionValue(fromFile),
        source: optionValue(source),
        json,
    }),
).pipe(Command.withDescription("Emit a retro for one session - heuristic by default, or --from-file=<path> to ingest agent JSON"));

const retroListCommand = Command.make(
    "list",
    {
        limit: positiveLimit(20),
        since: Flag.string("since").pipe(Flag.optional),
        json: jsonFlag,
    },
    ({ limit, since, json }) => cmdRetroList({
        limit,
        since: optionValue(since),
        json,
    }),
).pipe(Command.withDescription("List recent retros (tried · failed · next)"));

const retroReflectCommand = Command.make(
    "reflect",
    {
        since: Flag.integer("since").pipe(Flag.withDefault(30)),
        status: Flag.choice("status", ["open", "all"] as const).pipe(Flag.withDefault("open")),
        json: jsonFlag,
        yes: Flag.boolean("yes").pipe(Flag.withDefault(false)),
    },
    ({ since, status, json, yes }) => cmdRetroReflect([
        `--since=${since}`,
        `--status=${status}`,
        ...boolArg("json", json),
        ...boolArg("yes", yes),
    ]),
).pipe(Command.withDescription("Walk clustered retro-derived proposals interactively (accept/reject/skip each pattern)"));

const retroMetaCommand = Command.make(
    "meta",
    {
        since: Flag.integer("since").pipe(Flag.withDefault(30)),
        limitRetros: Flag.integer("limit-retros").pipe(Flag.withDefault(50)),
        pretty: Flag.boolean("pretty").pipe(Flag.withDefault(false)),
    },
    ({ since, limitRetros, pretty }) => cmdRetroMeta([
        `--since=${since}`,
        `--limit-retros=${limitRetros}`,
        ...boolArg("pretty", pretty),
    ]),
).pipe(Command.withDescription("Emit a read-only investigation snapshot (JSON) for an external AI agent to drive a deep retro of retros"));

const retroPlanCommand = Command.make(
    "plan",
    {
        slug: Flag.string("slug"),
        form: Flag.choice("form", ["skill", "hook", "guidance", "automation"] as const),
        title: Flag.string("title"),
        hypothesis: Flag.string("hypothesis"),
        planPath: Flag.string("plan-path"),
        evidenceRetros: Flag.string("evidence-retros").pipe(Flag.optional),
        artifactPath: Flag.string("artifact-path").pipe(Flag.optional),
        confidence: Flag.choice("confidence", ["low", "medium", "high"] as const).pipe(Flag.withDefault("medium")),
        frequency: Flag.integer("frequency").pipe(Flag.withDefault(1)),
        json: jsonFlag,
        leaveOpen: Flag.boolean("leave-open").pipe(Flag.withDefault(false)),
    },
    ({ slug, form, title, hypothesis, planPath, evidenceRetros, artifactPath, confidence, frequency, json, leaveOpen }) =>
        cmdRetroPlan([
            `--slug=${slug}`,
            `--form=${form}`,
            `--title=${title}`,
            `--hypothesis=${hypothesis}`,
            `--plan-path=${planPath}`,
            ...stringArg("evidence-retros", optionValue(evidenceRetros)),
            ...stringArg("artifact-path", optionValue(artifactPath)),
            `--confidence=${confidence}`,
            `--frequency=${frequency}`,
            ...boolArg("json", json),
            ...boolArg("leave-open", leaveOpen),
        ]),
).pipe(Command.withDescription("Register an externally-drafted plan as proposal (+ experiment unless --leave-open). External agent calls this after user yes."));

const retroPendingCommand = Command.make(
    "pending",
    {
        since: Flag.integer("since").pipe(Flag.withDefault(7)),
        idleMin: Flag.integer("idle-min").pipe(Flag.withDefault(30)),
        limit: Flag.integer("limit").pipe(Flag.withDefault(20)),
        includeSubagents: Flag.boolean("include-subagents").pipe(Flag.withDefault(false)),
        json: jsonFlag,
    },
    ({ since, idleMin, limit, includeSubagents, json }) => cmdRetroPending({
        since,
        idleMin,
        limit,
        includeSubagents,
        json,
    }),
).pipe(Command.withDescription("List sessions in the last N days that have no `reviewed` edge yet - the retro backlog the /retro skill drains. Excludes claude-subagent rows by default."));

const retroBriefCommand = Command.make(
    "brief",
    {
        session: Flag.string("session"),
        outDir: Flag.string("out-dir").pipe(Flag.optional),
        json: jsonFlag,
    },
    ({ session, outDir, json }) => cmdRetroBrief({
        session,
        outDir: optionValue(outDir),
        json,
    }),
).pipe(Command.withDescription("Write a task brief for one session to .ax/tasks/retro/<key>.md - hands off to the retro-reviewer subagent"));

export const retroCommand = Command.make("retro").pipe(
    Command.withDescription("Session retros: structured reflections (tried · worked · failed · next) that drive the experiment loop"),
    Command.withSubcommands([retroEmitCommand, retroListCommand, retroPendingCommand, retroBriefCommand, retroReflectCommand, retroMetaCommand, retroPlanCommand]),
);

export const retroRuntime: RuntimeManifest = {
    retro: "db",
};
