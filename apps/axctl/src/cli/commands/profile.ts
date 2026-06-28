/**
 * `ax profile show` - render the local profile (ProfileV1) from the graph.
 * `ax profile publish` - publish ProfileV1 to a public gist (create once, PATCH in place);
 *   first run shows the exact JSON, asks for consent, then opens a community registration PR.
 * `ax profile widget` - install/update the GitHub profile README widget.
 * `ax profile unpublish` - delete the published gist and local publish state.
 */
import { Effect, Schema } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { prettyPrint } from "@ax/lib/json";
import { buildProfile, type ProfileEnv } from "../../profile/render.ts";
import { fetchSkillInvocations, fetchSkillScopes } from "../../profile/queries.ts";
import { deriveRig } from "../../profile/rig.ts";
import type { ProfileV1 } from "../../profile/schema.ts";
import { integer } from "../render.ts";
import type { RuntimeManifest } from "./manifest.ts";
import { fail, jsonFlag, optionValue } from "./shared.ts";
import { GitHubEnvLive } from "../../profile/github-env.ts";
import {
    createProfileGist,
    deleteProfileGist,
    ensureRegistration,
    isStale,
    patchProfileGist,
} from "../../profile/publish.ts";
import {
    defaultPublishStatePath,
    loadPublishState,
    savePublishState,
} from "../../profile/publish-state.ts";
import {
    defaultWidgetStatePath,
    installOrUpdateProfileWidget,
    loadWidgetState,
    renderProfileWidget,
    saveWidgetState,
    shouldSkipWidgetRefresh,
    widgetStateMatchesOwner,
} from "../../profile/widget.ts";
import { renderProfileInterviewBrief } from "../../profile/interview-brief.ts";
import {
    decodeHighlightsFile,
    defaultHighlightsPath,
    HighlightsInvalidError,
    loadHighlightsBlock,
    saveHighlightsFile,
    type HighlightsFile,
} from "../../profile/highlights.ts";

class ProfileInterviewJsonError extends Schema.TaggedErrorClass<ProfileInterviewJsonError>(
    "ProfileInterviewJsonError",
)("ProfileInterviewJsonError", {
    message: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// Environment gathering (the only IO in this file)
// ---------------------------------------------------------------------------

const HOOKS_DIR = `${process.env.HOME}/.ax/hooks`;
const RULES_FILE = `${process.env.HOME}/.claude/CLAUDE.md`;
const ROUTING_TABLE = `${process.env.HOME}/.ax/hooks/routing-table.json`;

/** GitHub login via `gh api user`; silently falls back to $USER. */
const resolveGithubLogin = Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
        try: async () => {
            const proc = Bun.spawn(["gh", "api", "user", "--jq", ".login"], {
                stdout: "pipe",
                stderr: "ignore",
            });
            const out = await new Response(proc.stdout).text();
            return (await proc.exited) === 0 ? out.trim() : null;
        },
        catch: () => null,
    }).pipe(Effect.orElseSucceed(() => null));
    if (result && result !== "") return result;
    return process.env.USER ?? "unknown";
});

/**
 * Gather the local environment for a profile build. `loadHighlights` is false
 * for `interview` (it only needs the rig and must NOT fail on a corrupt
 * highlights file - that's the command you run to regenerate it); true for
 * show/publish, where an invalid file surfaces as a HighlightsInvalidError
 * rather than silently dropping the published block.
 */
const gatherEnv = (loadHighlights = true) =>
    Effect.gen(function* () {
        const hookFiles = yield* Effect.tryPromise({
            try: () => Array.fromAsync(new Bun.Glob("*.ts").scan({ cwd: HOOKS_DIR })),
            catch: () => [] as string[],
        }).pipe(Effect.orElseSucceed(() => [] as string[]));

        const rulesMarkdown = yield* Effect.tryPromise({
            try: async () => {
                const file = Bun.file(RULES_FILE);
                return (await file.exists()) ? await file.text() : null;
            },
            catch: () => null,
        }).pipe(Effect.orElseSucceed(() => null));

        const hasRoutingTable = yield* Effect.tryPromise({
            try: () => Bun.file(ROUTING_TABLE).exists(),
            catch: () => false,
        }).pipe(Effect.orElseSucceed(() => false));

        const github = yield* resolveGithubLogin;
        // A missing file is null (normal); a present-but-invalid file fails with
        // HighlightsInvalidError (loud) instead of being swallowed to null.
        const highlights = loadHighlights
            ? yield* Effect.tryPromise({
                try: () => loadHighlightsBlock(defaultHighlightsPath()),
                catch: (e) =>
                    e instanceof HighlightsInvalidError
                        ? e
                        : new HighlightsInvalidError(defaultHighlightsPath(), String(e)),
            })
            : null;
        const now = new Date();
        return {
            github,
            generatedAt: now.toISOString(),
            today: now.toISOString().slice(0, 10),
            hookFiles,
            hasRoutingTable,
            rulesMarkdown,
            highlights,
        } satisfies ProfileEnv;
    });

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Human money: >=1000 -> "~$22.6K", else "$22". */
const money = (n: number): string => {
    if (!Number.isFinite(n)) return "$0";
    if (n >= 1000) return `~$${(n / 1000).toFixed(1)}K`;
    return `$${n.toFixed(0)}`;
};

export function formatProfile(p: ProfileV1): string {
    const lines: string[] = [];
    lines.push(`ax profile - @${p.github}  (last ${p.window_days}d)`);
    lines.push("");
    const cost = p.stats.cost_usd !== undefined ? `  ·  ${money(p.stats.cost_usd)} est` : "";
    lines.push(
        `${integer(p.stats.sessions)} sessions  ·  ${integer(p.stats.tokens.total)} tokens${cost}`,
    );
    lines.push(
        `${p.stats.active_days} active days  ·  ${p.stats.streak_days}-day streak  ·  harnesses: ${p.stats.harnesses.join(", ")}`,
    );
    lines.push("");
    lines.push("models:");
    const topSkills = p.rig.skills.slice(0, 10);
    const nameWidth = Math.max(
        28,
        ...p.stats.models.map((m) => m.name.length),
        ...topSkills.map((s) => s.name.length),
    );
    for (const m of p.stats.models) {
        const c = m.cost_usd !== undefined ? `  ${money(m.cost_usd)}` : "";
        lines.push(`  ${m.name.padEnd(nameWidth)} ${(m.share * 100).toFixed(0).padStart(3)}%${c}`);
    }
    lines.push("");
    lines.push(`rig: ${p.rig.skills.length} skills · ${p.rig.hooks.length} hooks · routing_table: ${p.rig.routing_table}${p.rig.rules ? ` · ${p.rig.rules.count} rules` : ""}`);
    if (p.workflow && p.workflow.arcs.length > 0) {
        const topArc = p.workflow.arcs[0]!;
        lines.push(`workflow: ${topArc.steps.join(" → ")} (${topArc.count}x)`);
    }
    for (const s of topSkills) {
        const downstream = s.downstream_share !== undefined
            ? `  · downstream ${(s.downstream_share * 100).toFixed(0)}%`
            : "";
        lines.push(`  ${s.name.padEnd(nameWidth)} ${integer(s.runs).padStart(6)} runs  (${s.source})${downstream}`);
    }
    if (p.insights) {
        const ins = p.insights;
        const deepPct = (ins.deep_session_share * 100).toFixed(0);
        lines.push("");
        lines.push("insights:");
        lines.push(
            `  ${ins.hours_total.toFixed(1)}h total  ·  longest: ${integer(ins.longest_session_minutes)}min  ·  landed clean: ${deepPct}%`,
        );
        lines.push(
            `  peak hour: ${String(ins.peak_hour_utc).padStart(2, "0")}:00 UTC  ·  max parallel: ${ins.max_parallel_sessions}  ·  spawned: ${integer(ins.subagents_spawned)}  ·  commits: ${integer(ins.commits)}`,
        );
        if (ins.tool_calls !== undefined && ins.tool_calls > 0) {
            const verifPct = ins.verification_calls !== undefined
                ? `${(ins.verification_calls / ins.tool_calls * 100).toFixed(1)}% verification`
                : null;
            const failPct = ins.tool_failures !== undefined
                ? `${(ins.tool_failures / ins.tool_calls * 100).toFixed(1)}% failure rate`
                : null;
            const reposPart = ins.repos_count !== undefined
                ? `${ins.repos_count} repos`
                : null;
            const parts = [verifPct, failPct, reposPart].filter(Boolean);
            if (parts.length > 0) {
                lines.push(`  ${parts.join("  ·  ")}`);
            }
        }
        if (ins.tools_top.length > 0) {
            lines.push("  top tools:");
            for (const t of ins.tools_top.slice(0, 5)) {
                lines.push(`    ${t.name.padEnd(20)} ${integer(t.runs).padStart(7)} runs`);
            }
        }
    }
    if (p.taste) {
        lines.push("");
        lines.push(`taste: ${p.taste.patterns.length} patterns`);
        for (const t of p.taste.patterns.slice(0, 10)) {
            const label = t.category === "stack-choice"
                ? `${t.slot}: ${t.name}`
                : `${t.category}/${t.name}`;
            lines.push(`  ${label}  (confidence ${t.evidence.confidence}, ${t.evidence.sessions} sessions)`);
        }
    }
    return lines.join("\n");
}

// ---------------------------------------------------------------------------
// ax profile show [--window=30] [--no-cost] [--json]
// ---------------------------------------------------------------------------

type ProfileProgressStep = "env" | "build" | "done";

export function shouldEmitProfileProgress(input: {
    readonly stderrIsTTY: boolean;
    readonly progressEnv: string | undefined;
}): boolean {
    const mode = (input.progressEnv ?? "").toLowerCase();
    if (mode === "off") return false;
    // Force-emit modes mirror the ingest resolver (`withIngest`, cli/index.ts).
    return input.stderrIsTTY || mode === "on" || mode === "plain" || mode === "pipeline";
}

export function profileProgressLine(
    step: ProfileProgressStep,
    input: { readonly windowDays: number; readonly includeCost: boolean },
    elapsedMs?: number,
): string {
    if (step === "env") return "ax profile show: gathering local environment";
    if (step === "build") {
        return `ax profile show: building graph profile (window=${input.windowDays}d, cost=${input.includeCost ? "on" : "off"})`;
    }
    const seconds = ((elapsedMs ?? 0) / 1000).toFixed(1);
    return `ax profile show: done in ${seconds}s`;
}

const makeProfileProgress = (input: {
    readonly windowDays: number;
    readonly includeCost: boolean;
}) => {
    const enabled = shouldEmitProfileProgress({
        stderrIsTTY: process.stderr.isTTY === true,
        progressEnv: process.env.AX_PROGRESS,
    });
    const startedAt = Date.now();
    return (step: ProfileProgressStep) =>
        Effect.sync(() => {
            if (!enabled) return;
            const elapsedMs = step === "done" ? Date.now() - startedAt : undefined;
            process.stderr.write(`${profileProgressLine(step, input, elapsedMs)}\n`);
        });
};

const profileShowCommand = Command.make(
    "show",
    {
        window: Flag.integer("window").pipe(Flag.withDefault(30)),
        noCost: Flag.boolean("no-cost").pipe(Flag.withDefault(false)),
        json: jsonFlag,
    },
    ({ window, noCost, json }) => {
        if (!Number.isInteger(window) || window <= 0) {
            fail(`ax profile show: --window must be a positive integer (got "${window}")`);
        }
        return Effect.gen(function* () {
            const progress = makeProfileProgress({ windowDays: window, includeCost: !noCost });
            yield* progress("env");
            const env = yield* gatherEnv();
            yield* progress("build");
            const profile = yield* buildProfile({
                windowDays: window,
                includeCost: !noCost,
                env,
	            }).pipe(
	                Effect.timeout("40 seconds"),
	                Effect.catchTag("TimeoutError", () =>
	                    Effect.promise(async () =>
	                        fail(
	                            `ax profile show timed out (>40s) - your graph may be very large (Codex-heavy). ` +
	                            `Try a smaller window: ax profile show --window=7`,
                        ),
                    ),
                ),
            );
            yield* progress("done");
            console.log(json ? prettyPrint(profile) : formatProfile(profile));
        });
    },
).pipe(
    Command.withDescription(
        "Render your local ax profile (stats + rig + taste). " +
        "--window=N days (default 30)  --no-cost  --json",
    ),
);

// ---------------------------------------------------------------------------
// ax profile publish [--window=N] [--no-cost] [--if-stale=H] [--yes] [--skip-registration]
// ---------------------------------------------------------------------------

const cmdProfilePublish = (input: {
    readonly window: number;
    readonly noCost: boolean;
    readonly ifStaleHours: number | null;
    readonly yes: boolean;
    readonly skipRegistration: boolean;
}) =>
    Effect.gen(function* () {
        const statePath = defaultPublishStatePath();
        const state = yield* Effect.promise(() => loadPublishState(statePath));
        const nowIso = new Date().toISOString();

        if (input.ifStaleHours !== null) {
            // --if-stale is the watcher path: no state file -> silent no-op (never prompts).
            if (state === null) return;
            if (!isStale(state.published_at, input.ifStaleHours, nowIso)) return;
        }

        // An invalid highlights file must not silently drop the published block.
        // Interactive publish fails loudly; the unattended --if-stale watcher
        // skips with a warning (and leaves the prior published version intact).
        const env = yield* gatherEnv().pipe(
            Effect.catchTag("HighlightsInvalidError", (e) => {
                if (input.ifStaleHours !== null) {
                    console.error(
                        `ax profile publish: skipping auto-refresh - ${e.message}. ` +
                        "Fix the file or re-run `ax profile interview`.",
                    );
                    return Effect.succeed(null);
                }
                return Effect.fail(e);
            }),
        );
        if (env === null) return;
        const noCost = input.noCost || (state?.no_cost ?? false);
        const profile = yield* buildProfile({
            windowDays: input.window,
            includeCost: !noCost,
            env,
        });

        if (state === null) {
            // First publish: consent gate. Show EXACTLY what leaves the machine
            // (incl. taste summaries - see profile/taste.ts PUBLISH GATE).
            console.log(prettyPrint(profile));
            console.log(
                "\nThis exact JSON will be published as a PUBLIC gist under your GitHub account,\n" +
                "and kept fresh automatically (the watcher republishes future data, including new\n" +
                "taste patterns) until you run `ax profile unpublish`.",
            );
            if (!input.yes) {
                const ans = (globalThis.prompt?.("Publish? [y/N]") ?? "").trim().toLowerCase();
                if (ans !== "y" && ans !== "yes") {
                    console.log("Aborted. Nothing was published.");
                    return;
                }
            }
            const ref = yield* createProfileGist(profile);
            yield* Effect.promise(() =>
                savePublishState(statePath, {
                    v: 1,
                    gist_id: ref.gistId,
                    owner: ref.owner,
                    consented_at: nowIso,
                    published_at: nowIso,
                    no_cost: noCost,
                }),
            );
            console.log(`\npublished: https://gist.github.com/${ref.owner}/${ref.gistId}`);
            console.log(`profile:   https://ax.necmttn.com/u/${ref.owner}`);
            console.log(`short:     https://ax.necmttn.com/@${ref.owner}`);
            console.log(`challenge: https://ax.necmttn.com/u/${ref.owner}/vs/<their-handle>`);

            if (!input.skipRegistration) {
                const result = yield* ensureRegistration({
                    login: ref.owner,
                    gistId: ref.gistId,
                    joined: nowIso.slice(0, 10),
                });
                console.log(
                    result.status === "pr-opened"
                        ? `registration PR: ${result.prUrl}`
                        : "already registered in the community directory.",
                );
            }
            return;
        }

        // Subsequent publish: PATCH gist, update state.
        yield* patchProfileGist(state.gist_id, profile);
        yield* Effect.promise(() =>
            savePublishState(statePath, { ...state, published_at: nowIso, no_cost: noCost }),
        );
        console.log(`updated: https://gist.github.com/${state.owner}/${state.gist_id}`);
        console.log(`profile: https://ax.necmttn.com/u/${state.owner}`);
        console.log(`short:   https://ax.necmttn.com/@${state.owner}`);
        console.log(`challenge: https://ax.necmttn.com/u/${state.owner}/vs/<their-handle>`);
    }).pipe(Effect.provide(GitHubEnvLive));

const profilePublishCommand = Command.make(
    "publish",
    {
        window: Flag.integer("window").pipe(Flag.withDefault(30)),
        noCost: Flag.boolean("no-cost").pipe(Flag.withDefault(false)),
        ifStale: Flag.integer("if-stale").pipe(Flag.optional),
        yes: Flag.boolean("yes").pipe(Flag.withDefault(false)),
        skipRegistration: Flag.boolean("skip-registration").pipe(Flag.withDefault(false)),
    },
    ({ window, noCost, ifStale, yes, skipRegistration }) => {
        if (!Number.isInteger(window) || window <= 0) {
            fail(`ax profile publish: --window must be a positive integer (got "${window}")`);
        }
        const ifStaleHours = optionValue(ifStale) ?? null;
        if (ifStaleHours !== null && (!Number.isInteger(ifStaleHours) || ifStaleHours <= 0)) {
            fail(`ax profile publish: --if-stale must be positive hours (got "${ifStaleHours}")`);
        }
        return cmdProfilePublish({ window, noCost, ifStaleHours, yes, skipRegistration });
    },
).pipe(
    Command.withDescription(
        "Publish your profile to a public gist (create once, update in place); " +
        "first run asks for consent and opens the community registration PR. " +
        "--window=N  --no-cost  --if-stale=<hours>  --yes  --skip-registration",
    ),
);

// ---------------------------------------------------------------------------
// ax profile widget [--window=N] [--if-stale=H] [--yes]
// ---------------------------------------------------------------------------

const cmdProfileWidget = (input: {
    readonly window: number;
    readonly ifStaleHours: number | null;
    readonly yes: boolean;
}) =>
    Effect.gen(function* () {
        const statePath = defaultWidgetStatePath();
        const state = yield* Effect.promise(() => loadWidgetState(statePath));
        const nowIso = new Date().toISOString();

        if (input.ifStaleHours !== null && shouldSkipWidgetRefresh(state, input.ifStaleHours, nowIso)) {
            return;
        }

        const env = yield* gatherEnv();
        const stateMatchesOwner = widgetStateMatchesOwner(state, env.github);
        if (input.ifStaleHours !== null && !stateMatchesOwner) {
            return;
        }
        const windowDays = stateMatchesOwner && state !== null ? state.window_days : input.window;
        const profile = yield* buildProfile({
            windowDays,
            includeCost: false,
            env,
        });
        const block = renderProfileWidget(profile);

        if (!stateMatchesOwner) {
            console.log(block);
            console.log(
                "\nThis exact block will be committed to your public GitHub profile README\n" +
                `(${profile.github}/${profile.github}). Future watcher refreshes update only the text\n` +
                "between the ax markers until you delete ~/.ax/profile-widget.json.",
            );
            if (!input.yes) {
                const ans = (globalThis.prompt?.("Install widget? [y/N]") ?? "").trim().toLowerCase();
                if (ans !== "y" && ans !== "yes") {
                    console.log("Aborted. Nothing was committed.");
                    return;
                }
            }
        }

        const result = yield* installOrUpdateProfileWidget({ profile });
        yield* Effect.promise(() =>
            saveWidgetState(statePath, {
                v: 1,
                owner: profile.github,
                consented_at: stateMatchesOwner && state !== null ? state.consented_at : nowIso,
                updated_at: nowIso,
                window_days: windowDays,
            }),
        );

        if (input.ifStaleHours === null) {
            console.log(`${result.status}: ${result.url}`);
        }
    }).pipe(Effect.provide(GitHubEnvLive));

const profileWidgetCommand = Command.make(
    "widget",
    {
        window: Flag.integer("window").pipe(Flag.withDefault(30)),
        ifStale: Flag.integer("if-stale").pipe(Flag.optional),
        yes: Flag.boolean("yes").pipe(Flag.withDefault(false)),
    },
    ({ window, ifStale, yes }) => {
        if (!Number.isInteger(window) || window <= 0) {
            fail(`ax profile widget: --window must be a positive integer (got "${window}")`);
        }
        const ifStaleHours = optionValue(ifStale) ?? null;
        if (ifStaleHours !== null && (!Number.isInteger(ifStaleHours) || ifStaleHours <= 0)) {
            fail(`ax profile widget: --if-stale must be positive hours (got "${ifStaleHours}")`);
        }
        return cmdProfileWidget({ window, ifStaleHours, yes });
    },
).pipe(
    Command.withDescription(
        "Install or refresh a marker-delimited ax block in your GitHub profile README. " +
        "First run asks for consent. --window=N  --if-stale=<hours>  --yes",
    ),
);

// ---------------------------------------------------------------------------
// ax profile unpublish
// ---------------------------------------------------------------------------

const cmdProfileUnpublish = () =>
    Effect.gen(function* () {
        const statePath = defaultPublishStatePath();
        const state = yield* Effect.promise(() => loadPublishState(statePath));
        if (state === null) {
            console.log("not published (no local publish state).");
            return;
        }
        // Tolerate an already-deleted gist (404): local state cleanup must
        // never be blocked by remote state drift.
        yield* deleteProfileGist(state.gist_id).pipe(
            Effect.catchTag("GitHubApiError", (e) =>
                e.status === 404
                    ? Effect.sync(() => console.log("gist already deleted remotely."))
                    : Effect.fail(e),
            ),
        );
        yield* Effect.promise(async () => {
            await Bun.$`rm -f ${statePath}`.quiet().nothrow();
        });
        console.log(`deleted gist ${state.gist_id} and local publish state.`);
        console.log(
            `If you registered, open a removal PR for community/users/${state.owner}.json in Necmttn/ax.`,
        );
    }).pipe(Effect.provide(GitHubEnvLive));

const profileUnpublishCommand = Command.make("unpublish", {}, () => cmdProfileUnpublish()).pipe(
    Command.withDescription("Delete the published profile gist and local publish state."),
);

// ---------------------------------------------------------------------------
// ax profile interview submit - validate highlights JSON and write the file.
// ---------------------------------------------------------------------------

export const cmdProfileInterviewSubmit = (input: { readonly rawJson: string; readonly path: string }) =>
	    Effect.gen(function* () {
	        const parsed = yield* Effect.try({
	            try: () => JSON.parse(input.rawJson) as unknown,
	            catch: (err) =>
	                new ProfileInterviewJsonError({
	                    message: err instanceof Error ? err.message : String(err),
	                }),
	        });
        const file: HighlightsFile = yield* decodeHighlightsFile(parsed);
        yield* Effect.promise(() => saveHighlightsFile(input.path, file));
        return file;
    });

// ---------------------------------------------------------------------------
// ax profile interview - emit the interview brief
// ---------------------------------------------------------------------------

const cmdProfileInterview = (input: { readonly force: boolean }) =>
    Effect.gen(function* () {
        const date = new Date().toISOString().slice(0, 10);
        const path = `.ax/tasks/profile-interview-${date}.md`;
        const exists = yield* Effect.tryPromise(() => Bun.file(path).exists());
        if (exists && !input.force) {
            console.log(`already exists: ${path} (re-run with --force to overwrite)`);
            return;
        }
        // Only the rig is needed to prefill the brief - skip the full ~27-query
        // buildProfile and skip the highlights load (interview regenerates them).
        const env = yield* gatherEnv(false);
        const invocations = yield* fetchSkillInvocations({ windowDays: 30 });
        const scopes = yield* fetchSkillScopes();
        const rig = deriveRig({
            invocations,
            scopes,
            hookFiles: env.hookFiles,
            hasRoutingTable: env.hasRoutingTable,
            rulesMarkdown: env.rulesMarkdown,
        });
        const md = renderProfileInterviewBrief({
            date,
            skills: rig.skills.map((s) => ({ name: s.name, source: s.source })),
            hooks: rig.hooks,
        });
        yield* Effect.tryPromise(() => Bun.write(path, md));
        console.log(`interview brief written: ${path}`);
        console.log("hand it to an agent session; answers come back via `ax profile interview submit`");
    });

const profileInterviewSubmitCommand = Command.make(
    "submit",
    { file: Flag.string("file").pipe(Flag.optional) },
    ({ file }) =>
        Effect.gen(function* () {
            const filePath = optionValue(file);
            const rawJson = filePath !== undefined
                ? yield* Effect.tryPromise(() => Bun.file(filePath).text())
                : yield* Effect.tryPromise(() => Bun.stdin.text());
            const hlPath = defaultHighlightsPath();
            yield* cmdProfileInterviewSubmit({ rawJson, path: hlPath });
            console.log(`saved: ${hlPath}`);
            console.log("run `ax profile publish` to fold these into your public gist.");
        }),
).pipe(Command.withDescription(
    "Validate { v, authored_at, setup?, skills?, taste?, wins? } JSON (stdin or --file) and write ~/.ax/profile-highlights.json.",
));

const profileInterviewCommand = Command.make(
    "interview",
    { force: Flag.boolean("force").pipe(Flag.withDefault(false)) },
    ({ force }) => cmdProfileInterview({ force }),
).pipe(
    Command.withDescription(
        "Emit .ax/tasks/profile-interview-<date>.md - a brief for an agent to interview you and submit highlights via `ax profile interview submit`. --force overwrites.",
    ),
    Command.withSubcommands([profileInterviewSubmitCommand]),
);

export const profileCommand = Command.make("profile").pipe(
    Command.withDescription(
        "Your ax profile: stats, rig, and taste rendered from the local graph",
    ),
    Command.withSubcommands([
        profileShowCommand,
        profilePublishCommand,
        profileWidgetCommand,
        profileUnpublishCommand,
        profileInterviewCommand,
    ]),
);

// `interview submit` only validates JSON + writes ~/.ax/profile-highlights.json,
// so it must not require a live SurrealDB; every other profile path reads the
// graph. Route per-subcommand (and per-argv for the submit sub-subcommand).
export const axProfileRuntime: RuntimeManifest = {
    profile: {
        kind: "db-conditional",
        fallback: "db",
        subcommands: {
            show: "db",
            publish: "db",
            widget: "db",
            unpublish: "db",
            interview: (args) => (args[2] === "submit" ? "none" : "db"),
        },
    },
};
