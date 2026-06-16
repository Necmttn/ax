/**
 * `ax team` - team rig management.
 *
 *   ax team sync [--dry-run] [--yes]
 *     Activate the team's committed `.ax/` rig (skills + agents) into your
 *     runtime, trust-gated. Executable hooks in `.ax/hooks/` are reported as
 *     gated but never activated. `--dry-run` shows what would change without
 *     writing anything. `--yes` approves activation of new or changed artifacts.
 *
 *   ax team trust [--yes] [--allow-branch]
 *     Review + install the team's executable `.ax/hooks/*` (sha256 trust-on-change,
 *     default-branch-only). `--yes` approves installation. `--allow-branch`
 *     bypasses the default-branch guard.
 */
import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { scanAxFolder } from "../../team/scan.ts";
import { hashArtifact } from "../../team/hash.ts";
import { loadTrust, saveTrust, classify, defaultTrustPath } from "../../team/trust.ts";
import { activateArtifact, isSafeName } from "../../team/activate.ts";
import { artifactKey, type TeamArtifact, type GatedArtifact } from "../../team/model.ts";
import {
    loadExecTrust,
    saveExecTrust,
    classifyExec,
    execKey,
    defaultExecTrustPath,
    type ExecTrustState,
} from "../../team/exec-trust.ts";
import { sha256OfFile } from "../../team/exec-hash.ts";
import { isOnDefaultBranch } from "../../team/git-branch.ts";
import { installTeamHook } from "../../team/install-team-hook.ts";
import { HookProviderRegistryDefault } from "../../hooks/providers/registry.ts";
import type { RuntimeManifest } from "./manifest.ts";

// ---------------------------------------------------------------------------
// Pure render helpers (exported for tests)
// ---------------------------------------------------------------------------

export interface SyncReport {
    readonly activated: ReadonlyArray<string>;
    readonly unchanged: ReadonlyArray<string>;
    readonly gated: ReadonlyArray<string>;
}

/** Pure: format a sync result for stdout. No IO. */
export const renderSyncReport = (r: SyncReport): string => {
    if (r.activated.length === 0 && r.unchanged.length === 0 && r.gated.length === 0) {
        return "[ax team sync] no team rig found in .ax/";
    }
    const lines: string[] = ["[ax team sync]"];
    if (r.activated.length > 0) {
        lines.push(`activated ${r.activated.length}:`);
        for (const name of r.activated) lines.push(`  + ${name}`);
    }
    if (r.unchanged.length > 0) {
        lines.push(`${r.unchanged.length} unchanged`);
    }
    if (r.gated.length > 0) {
        lines.push("gated (executable hooks - run `ax team trust` to review + install them):");
        for (const name of r.gated) lines.push(`  ~ ${name}`);
    }
    return lines.join("\n");
};

export interface TrustReport {
    readonly installed: ReadonlyArray<string>;
    readonly changed: ReadonlyArray<string>;
    readonly added: ReadonlyArray<string>;
    readonly onDefault: boolean;
}

/** Pure: format a trust result for stdout. No IO. */
export const renderTrustReport = (r: TrustReport): string => {
    if (r.installed.length === 0 && r.changed.length === 0 && r.added.length === 0)
        return "[ax team trust] no executable hooks in .ax/hooks/.";
    if (!r.onDefault && (r.changed.length || r.added.length) && r.installed.length === 0)
        return "[ax team trust] refusing to install executable hooks: not on the repo's default branch (use --allow-branch to override).";
    const lines = [`[ax team trust] installed ${r.installed.length} executable hook(s)`];
    for (const k of r.installed) lines.push(`  + ${k}`);
    return lines.join("\n");
};

// ---------------------------------------------------------------------------
// ax team sync
// ---------------------------------------------------------------------------

const cmdSync = (input: { readonly dryRun: boolean; readonly yes: boolean }) =>
    Effect.gen(function* () {
        // 1. Get git repo root
        const r = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
            stdout: "pipe",
            stderr: "ignore",
        });
        if (r.exitCode !== 0) {
            console.error("[ax team] not inside a git repo - run from the team repo root");
            return;
        }
        const root = r.stdout.toString().trim();

        // 2. Scan .ax/ for artifacts + gated hooks
        const { artifacts, gated } = yield* Effect.promise(() => scanAxFolder(root));

        if (artifacts.length === 0 && gated.length === 0) {
            console.log("[ax team sync] no .ax/ rig found in this repo");
            return;
        }

        // 3. Pre-read all artifact files to build a sync hash map
        const fileContents = yield* Effect.promise(async () => {
            const map = new Map<string, string>();
            for (const a of artifacts) {
                for (const rel of a.files) {
                    const abs = a.kind === "agent" ? a.path : `${a.path}/${rel}`;
                    map.set(abs, await Bun.file(abs).text());
                }
            }
            return map;
        });
        const readFile = (abs: string): string => fileContents.get(abs) ?? "";
        const hashOf = (a: TeamArtifact) => hashArtifact(a, readFile);

        // 4. Load trust state + classify artifacts
        const trust = yield* Effect.promise(() => loadTrust(defaultTrustPath()));
        const cls = classify(artifacts, hashOf, trust);

        // 5. Dry-run: show what would happen, write nothing
        if (input.dryRun) {
            const toActivate = [...cls.added, ...cls.changed];
            if (toActivate.length > 0) {
                console.log(`[ax team sync] would activate ${toActivate.length}:`);
                for (const a of toActivate) console.log(`  + ${a.kind}:${a.name}`);
            }
            if (cls.unchanged.length > 0) {
                console.log(`${cls.unchanged.length} unchanged`);
            }
            if (gated.length > 0) {
                console.log("gated (executable hooks - run `ax team trust` to review + install them):");
                for (const g of gated) console.log(`  ~ ${g.name}`);
            }
            if (toActivate.length === 0 && cls.unchanged.length === 0) {
                console.log("nothing to activate");
            }
            return;
        }

        // 6. Compute what needs activating
        const toActivate = [...cls.added, ...cls.changed];

        // 7. Without --yes, print what would happen and bail (activate NOTHING)
        if (toActivate.length > 0 && !input.yes) {
            console.log(`[ax team sync] ${toActivate.length} artifact(s) ready to activate:`);
            for (const a of toActivate) console.log(`  + ${a.kind}:${a.name}`);
            console.log("re-run with --yes to approve");
            return;
        }

        // 8. Activate all in to_activate (skip unsafe names), update trust.
        // HOME must be set - never silently write the rig into a surprise location.
        const home = process.env.HOME;
        if (!home) {
            console.error("[ax team sync] HOME is not set; cannot resolve the runtime (~/.claude). Aborting.");
            return;
        }
        const activated: string[] = [];
        const mutableTrust = { ...trust };

        yield* Effect.promise(async () => {
            for (const a of toActivate) {
                if (!isSafeName(a.name)) {
                    console.warn(`[ax team sync] unsafe artifact name, skipped: ${JSON.stringify(a.name)}`);
                    continue;
                }
                await activateArtifact(a, home);
                mutableTrust[artifactKey(a)] = {
                    hash: hashOf(a),
                    activated_at: new Date().toISOString(),
                };
                activated.push(`${a.kind}:${a.name}`);
            }
        });

        // 9. Save updated trust state
        yield* Effect.promise(() => saveTrust(defaultTrustPath(), mutableTrust));

        // 10. Print report
        console.log(
            renderSyncReport({
                activated,
                unchanged: cls.unchanged.map((a) => `${a.kind}:${a.name}`),
                gated: gated.map((g) => g.name),
            }),
        );
    });

const syncCommand = Command.make(
    "sync",
    {
        dryRun: Flag.boolean("dry-run").pipe(Flag.withDefault(false)),
        yes: Flag.boolean("yes").pipe(Flag.withDefault(false)),
    },
    ({ dryRun, yes }) => cmdSync({ dryRun, yes }),
).pipe(
    Command.withDescription(
        "Activate the team's committed .ax/ rig (skills + agents) into your runtime, trust-gated. " +
        "Hooks in .ax/hooks/ are gated (run `ax team trust` to install them). " +
        "--dry-run (show what would change)  --yes (approve activation of new or changed artifacts)",
    ),
);

// ---------------------------------------------------------------------------
// ax team trust
// ---------------------------------------------------------------------------

const cmdTrust = (input: { readonly yes: boolean; readonly allowBranch: boolean }) =>
    Effect.gen(function* () {
        // 1. Get git repo root
        const r = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
            stdout: "pipe",
            stderr: "ignore",
        });
        if (r.exitCode !== 0) {
            console.error("[ax team] not inside a git repo - run from the team repo root");
            return;
        }
        const root = r.stdout.toString().trim();

        // 2. Scan .ax/ for gated hooks
        const { gated } = yield* Effect.promise(() => scanAxFolder(root));

        if (gated.length === 0) {
            console.log("[ax team trust] no executable hooks in .ax/hooks/.");
            return;
        }

        // 3. sha256 each gated hook
        const shaMap = yield* Effect.promise(async () => {
            const map = new Map<string, string>();
            for (const h of gated) {
                map.set(execKey(h), await sha256OfFile(h.path));
            }
            return map;
        });
        const shaOf = (h: GatedArtifact): string => shaMap.get(execKey(h)) ?? "";

        // 4. Load trust state + classify
        const trust = yield* Effect.promise(() => loadExecTrust(defaultExecTrustPath()));
        const cls = classifyExec(gated, shaOf, trust);
        const toInstall = [...cls.added, ...cls.changed];

        // 5. Branch guard: refuse if not on default branch and there are hooks to install
        const onDefault = isOnDefaultBranch(root);
        if (!onDefault && toInstall.length > 0 && !input.allowBranch) {
            console.log(
                renderTrustReport({
                    installed: [],
                    changed: cls.changed.map(execKey),
                    added: cls.added.map(execKey),
                    onDefault,
                }),
            );
            return;
        }

        // 6. Nothing new to install
        if (toInstall.length === 0) {
            console.log(`[ax team trust] ${cls.trusted.length} hook(s) up to date`);
            return;
        }

        // 7. Show diffs for changed/added hooks
        for (const h of cls.changed) {
            const rec = trust[execKey(h)];
            console.log(`CHANGED: ${execKey(h)}`);
            console.log(`  old sha256: ${rec?.sha256 ?? "(unknown)"}`);
            console.log(`  new sha256: ${shaOf(h)}`);
            if (rec?.content) {
                const newContent = yield* Effect.promise(() => Bun.file(h.path).text());
                const oldLines = rec.content.split("\n");
                const newLines = newContent.split("\n");
                const diffLines: string[] = [];
                const maxLines = Math.min(Math.max(oldLines.length, newLines.length), 30);
                for (let i = 0; i < maxLines; i++) {
                    if (oldLines[i] !== newLines[i]) {
                        if (oldLines[i] !== undefined) diffLines.push(`  - ${oldLines[i]}`);
                        if (newLines[i] !== undefined) diffLines.push(`  + ${newLines[i]}`);
                    }
                }
                if (diffLines.length > 0) console.log(diffLines.join("\n"));
            }
        }
        for (const h of cls.added) {
            const content = yield* Effect.promise(() => Bun.file(h.path).text());
            console.log(`NEW: ${execKey(h)}`);
            console.log(`  sha256: ${shaOf(h)}`);
            console.log(
                content
                    .split("\n")
                    .slice(0, 15)
                    .map((l) => `  ${l}`)
                    .join("\n"),
            );
        }

        // 8. Approval gate: non-TTY or missing --yes → fail-safe, install nothing
        if (!input.yes) {
            console.log(
                `[ax team trust] re-run with --yes to install ${toInstall.length} executable hook(s)`,
            );
            return;
        }

        // 9. HOME required
        const home = process.env.HOME;
        if (!home) {
            console.error(
                "[ax team trust] HOME is not set; cannot resolve the runtime (~/.ax/hooks). Aborting.",
            );
            return;
        }

        // 10. Install each approved hook + update trust record
        const installedKeys: string[] = [];
        const mutableTrust: ExecTrustState = { ...trust };

        for (const h of toInstall) {
            const content = yield* Effect.promise(() => Bun.file(h.path).text());
            yield* installTeamHook(h.name, content, home, ["claude", "codex"]);
            mutableTrust[execKey(h)] = {
                sha256: shaOf(h),
                content,
                trusted_at: new Date().toISOString(),
            };
            installedKeys.push(execKey(h));
        }

        // 11. Save updated exec-trust state
        yield* Effect.promise(() => saveExecTrust(defaultExecTrustPath(), mutableTrust));

        // 12. Print report
        console.log(
            renderTrustReport({
                installed: installedKeys,
                changed: cls.changed.map(execKey),
                added: cls.added.map(execKey),
                onDefault,
            }),
        );
    });

const trustCommand = Command.make(
    "trust",
    {
        yes: Flag.boolean("yes").pipe(Flag.withDefault(false)),
        allowBranch: Flag.boolean("allow-branch").pipe(Flag.withDefault(false)),
    },
    ({ yes, allowBranch }) =>
        cmdTrust({ yes, allowBranch }).pipe(Effect.provide(HookProviderRegistryDefault)),
).pipe(
    Command.withDescription(
        "Review + install the team's executable .ax/hooks/* (sha256 trust-on-change, default-branch-only). " +
        "--yes (approve installation)  --allow-branch (bypass default-branch guard)",
    ),
);

// ---------------------------------------------------------------------------
// ax team (group)
// ---------------------------------------------------------------------------

export const teamCommand = Command.make("team").pipe(
    Command.withDescription(
        "Team rig management: activate the shared .ax/ skills and agents into your local runtime.",
    ),
    Command.withSubcommands([syncCommand, trustCommand]),
);

export const teamRuntime: RuntimeManifest = {
    team: {
        runtime: {
            kind: "db-conditional",
            fallback: "none",
            subcommands: {
                sync: "none",
                trust: "none",
            },
        },
        hidden: false,
    },
};
