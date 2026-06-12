/**
 * `ax profile show` - render the local profile (ProfileV1) from the graph.
 * Local-only preview; publish (gist + fork registration) lands in a later
 * plan. Mirrors the commands/ax-cost.ts pattern: read-only, `db` runtime.
 */
import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { prettyPrint } from "@ax/lib/json";
import { buildProfile, type ProfileEnv } from "../../profile/render.ts";
import type { ProfileV1 } from "../../profile/schema.ts";
import type { RuntimeManifest } from "./manifest.ts";
import { fail, jsonFlag } from "./shared.ts";

// ---------------------------------------------------------------------------
// Environment gathering (the only IO in this file)
// ---------------------------------------------------------------------------

const HOOKS_DIR = `${process.env.HOME}/.ax/hooks`;
const RULES_FILE = `${process.env.HOME}/.claude/CLAUDE.md`;
const ROUTING_TABLE = `${process.env.HOME}/.ax/hooks/routing-table.json`;

/** GitHub login via `gh api user`; falls back to $USER with a notice. */
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

export function formatProfile(p: ProfileV1): string {
    const lines: string[] = [];
    lines.push(`ax profile - @${p.github}  (last ${p.window_days}d)`);
    lines.push("");
    const cost = p.stats.cost_usd !== undefined ? `  ·  $${p.stats.cost_usd.toFixed(2)} est` : "";
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
        const c = m.cost_usd !== undefined ? `  $${m.cost_usd.toFixed(2)}` : "";
        lines.push(`  ${m.name.padEnd(nameWidth)} ${(m.share * 100).toFixed(0).padStart(3)}%${c}`);
    }
    lines.push("");
    lines.push(`rig: ${p.rig.skills.length} skills · ${p.rig.hooks.length} hooks · routing_table: ${p.rig.routing_table}${p.rig.rules ? ` · ${p.rig.rules.count} rules` : ""}`);
    for (const s of topSkills) {
        lines.push(`  ${s.name.padEnd(nameWidth)} ${integer(s.runs_30d).padStart(6)} runs  (${s.source})`);
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

export const profileCommand = Command.make("profile").pipe(
    Command.withDescription(
        "Your ax profile: stats, rig, and taste rendered from the local graph",
    ),
    Command.withSubcommands([profileShowCommand]),
);

export const axProfileRuntime: RuntimeManifest = {
    profile: "db",
};
