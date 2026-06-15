/**
 * `ax team` - team rig management.
 *
 *   ax team sync [--dry-run] [--yes]
 *     Activate the team's committed `.ax/` rig (skills + agents) into your
 *     runtime, trust-gated. Executable hooks in `.ax/hooks/` are reported as
 *     gated but never activated. `--dry-run` shows what would change without
 *     writing anything. `--yes` approves activation of new or changed artifacts.
 */
import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { scanAxFolder } from "../../team/scan.ts";
import { hashArtifact } from "../../team/hash.ts";
import { loadTrust, saveTrust, classify, defaultTrustPath } from "../../team/trust.ts";
import { activateArtifact, isSafeName } from "../../team/activate.ts";
import { artifactKey, type TeamArtifact } from "../../team/model.ts";
import type { RuntimeManifest } from "./manifest.ts";

// ---------------------------------------------------------------------------
// Pure render helper (exported for tests)
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
        lines.push("gated (executable hooks - trust-review before installing):");
        for (const name of r.gated) lines.push(`  ~ ${name}`);
    }
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
                console.log("gated (executable hooks - never activated):");
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

        // 8. Activate all in to_activate (skip unsafe names), update trust
        const home = process.env.HOME ?? "/tmp";
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
        "Hooks in .ax/hooks/ are gated and never activated. " +
        "--dry-run (show what would change)  --yes (approve activation of new or changed artifacts)",
    ),
);

// ---------------------------------------------------------------------------
// ax team (group)
// ---------------------------------------------------------------------------

export const teamCommand = Command.make("team").pipe(
    Command.withDescription(
        "Team rig management: activate the shared .ax/ skills and agents into your local runtime.",
    ),
    Command.withSubcommands([syncCommand]),
);

export const teamRuntime: RuntimeManifest = {
    team: {
        runtime: {
            kind: "db-conditional",
            fallback: "none",
            subcommands: {
                sync: "none",
            },
        },
        hidden: false,
    },
};
