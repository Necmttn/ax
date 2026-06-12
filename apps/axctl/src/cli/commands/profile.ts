/**
 * `ax profile show` - render the local profile (ProfileV1) from the graph.
 * `ax profile publish` - publish ProfileV1 to a public gist (create once, PATCH in place);
 *   first run shows the exact JSON, asks for consent, then opens a community registration PR.
 * `ax profile unpublish` - delete the published gist and local publish state.
 */
import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { prettyPrint } from "@ax/lib/json";
import { buildProfile, type ProfileEnv } from "../../profile/render.ts";
import type { ProfileV1 } from "../../profile/schema.ts";
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

const gatherEnv = Effect.gen(function* () {
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
    const now = new Date();
    return {
        github,
        generatedAt: now.toISOString(),
        today: now.toISOString().slice(0, 10),
        hookFiles,
        hasRoutingTable,
        rulesMarkdown,
    } satisfies ProfileEnv;
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const integer = (n: number): string =>
    Number.isFinite(n) ? Math.trunc(n).toLocaleString("en-US") : "0";

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
    for (const s of topSkills) {
        lines.push(`  ${s.name.padEnd(nameWidth)} ${integer(s.runs).padStart(6)} runs  (${s.source})`);
    }
    if (p.insights) {
        const ins = p.insights;
        const deepPct = (ins.deep_session_share * 100).toFixed(0);
        lines.push("");
        lines.push("insights:");
        lines.push(
            `  ${ins.hours_total.toFixed(1)}h total  ·  longest: ${integer(ins.longest_session_minutes)}min  ·  deep (>=90min): ${deepPct}%`,
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
            const env = yield* gatherEnv;
            const profile = yield* buildProfile({
                windowDays: window,
                includeCost: !noCost,
                env,
            });
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

        const env = yield* gatherEnv;
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

export const profileCommand = Command.make("profile").pipe(
    Command.withDescription(
        "Your ax profile: stats, rig, and taste rendered from the local graph",
    ),
    Command.withSubcommands([profileShowCommand, profilePublishCommand, profileUnpublishCommand]),
);

export const axProfileRuntime: RuntimeManifest = {
    profile: "db",
};
