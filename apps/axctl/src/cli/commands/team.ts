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
import { scanWithOverlay } from "../../team/overlay.ts";
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
import { sha256Hex } from "../../team/exec-hash.ts";
import { isOnDefaultBranch } from "../../team/git-branch.ts";
import { installTeamHook, isSafeHookName, hookSnapshotPath } from "../../team/install-team-hook.ts";
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

        // 2. Scan .ax/ + .ax.local/ overlay for artifacts + gated hooks
        const { artifacts, gated } = yield* Effect.promise(() => scanWithOverlay(root));

        if (artifacts.length === 0 && gated.length === 0) {
            console.log("[ax team sync] no .ax/ rig found in this repo");
            return;
        }

        // Track which artifact keys are from the local overlay, for annotation in reports
        const overlayKeys = new Set(artifacts.filter((a) => a.overlay).map((a) => artifactKey(a)));

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
                for (const a of toActivate)
                    console.log(`  + ${a.kind}:${a.name}${overlayKeys.has(artifactKey(a)) ? " (experiment)" : ""}`);
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
            for (const a of toActivate)
                console.log(`  + ${a.kind}:${a.name}${overlayKeys.has(artifactKey(a)) ? " (experiment)" : ""}`);
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
                activated.push(`${a.kind}:${a.name}${overlayKeys.has(artifactKey(a)) ? " (experiment)" : ""}`);
            }
        });

        // 9. Save updated trust state
        yield* Effect.promise(() => saveTrust(defaultTrustPath(), mutableTrust));

        // 10. Print report
        console.log(
            renderSyncReport({
                activated,
                unchanged: cls.unchanged.map((a) => `${a.kind}:${a.name}${overlayKeys.has(artifactKey(a)) ? " (experiment)" : ""}`),
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

/**
 * Make attacker-controlled hook source safe to print to a terminal.
 * Strips C0 control chars + DEL (-> "?") and renders ESC visibly ("\x1b") so
 * embedded ANSI can't scroll the payload out of view or spoof the NEW:/sha256:
 * review labels. Keeps \n and \t. ESC is replaced FIRST so it survives as text.
 */
const sanitize = (s: string): string =>
    s.replace(/\x1b/g, "\\x1b").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "?");

/** Full, sanitized line diff (no truncation - this is executable code about to
 *  be trusted across the team, so the whole body must be reviewable). */
const renderDiff = (oldText: string, newText: string): string => {
    const oldLines = oldText.split("\n");
    const newLines = newText.split("\n");
    const out: string[] = [];
    const n = Math.max(oldLines.length, newLines.length);
    for (let i = 0; i < n; i++) {
        const o = oldLines[i];
        const nw = newLines[i];
        if (o === nw) {
            if (o !== undefined) out.push(`    ${sanitize(o)}`);
        } else {
            if (o !== undefined) out.push(`  - ${sanitize(o)}`);
            if (nw !== undefined) out.push(`  + ${sanitize(nw)}`);
        }
    }
    return out.join("\n");
};

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

        // 2. Scan .ax/ + .ax.local/ overlay for gated hooks
        const { gated } = yield* Effect.promise(() => scanWithOverlay(root));

        if (gated.length === 0) {
            console.log("[ax team trust] no executable hooks in .ax/hooks/.");
            return;
        }

        // 3. Read each gated hook's content ONCE; thread that single buffer
        //    everywhere so judged == hashed == snapshotted == run == stored.
        //    Re-reading between hash/diff/install opens a local TOCTOU race where
        //    the bytes the human approves differ from what gets pinned + run.
        const body = yield* Effect.promise(async () => {
            const m = new Map<string, string>();
            for (const h of gated) m.set(h.name, await Bun.file(h.path).text());
            return m;
        });
        const contentOf = (h: GatedArtifact): string => body.get(h.name) ?? "";
        const shaMap = new Map<string, string>();
        for (const h of gated) shaMap.set(execKey(h), sha256Hex(contentOf(h)));
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

        // 7. Show the FULL hook source for review, sanitized. The trust model is
        //    "the human reads the executable bytes and approves with --yes". So
        //    never truncate (a payload could hide past a benign head) and never
        //    emit raw control bytes (ANSI could scroll the payload off-screen or
        //    spoof the NEW:/sha256: labels). Bytes shown == bytes hashed/run.
        for (const h of cls.changed) {
            const rec = trust[execKey(h)];
            console.log(`CHANGED: ${execKey(h)}`);
            console.log(`  old sha256: ${rec?.sha256 ?? "(unknown)"}`);
            console.log(`  new sha256: ${shaOf(h)}`);
            const newContent = contentOf(h);
            if (rec?.content !== undefined) {
                console.log(renderDiff(rec.content, newContent));
            } else {
                console.log(
                    sanitize(newContent)
                        .split("\n")
                        .map((l) => `  | ${l}`)
                        .join("\n"),
                );
            }
        }
        for (const h of cls.added) {
            console.log(`NEW: ${execKey(h)}`);
            console.log(`  sha256: ${shaOf(h)}`);
            console.log(
                sanitize(contentOf(h))
                    .split("\n")
                    .map((l) => `  | ${l}`)
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

        // 9.5 Validate ALL hook names up front, before installing ANY. An unsafe
        //     name (e.g. .ax/hooks/.config) would throw mid-loop AFTER earlier
        //     hooks already wrote to provider configs but BEFORE saveExecTrust,
        //     leaving config/trust drift. Partition first; skip + warn the rest.
        const safeInstall = toInstall.filter((h) => {
            if (isSafeHookName(h.name)) return true;
            console.warn(`[ax team trust] skipping unsafe hook name: ${JSON.stringify(h.name)}`);
            return false;
        });

        // 10. Install each approved hook + update trust record
        const installedKeys: string[] = [];
        const mutableTrust: ExecTrustState = { ...trust };

        for (const h of safeInstall) {
            const content = contentOf(h);
            // Clobber warning: a pre-existing snapshot with no exec-trust record
            // is somebody else's hook we're about to overwrite.
            const snapPath = hookSnapshotPath(h.name, home);
            const untrackedClobber =
                !(execKey(h) in trust) &&
                (yield* Effect.promise(() => Bun.file(snapPath).exists()));
            if (untrackedClobber) {
                console.warn(`[ax team trust] overwriting existing untracked hook at ${snapPath}`);
            }
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
