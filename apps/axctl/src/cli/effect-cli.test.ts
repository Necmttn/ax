import { describe, expect, test } from "bun:test";
import {
    DB_COMMANDS,
    RUNTIME_BY_COMMAND,
    detectRemovedIngestFlag,
    insightsOnlyConflicts,
    resolveIngestStages,
    rootCommand,
} from "./index.ts";
import { classifiersPackageOperationsNeedsDb } from "./commands/classifiers.ts";
import { entryHidden, entryRuntime, resolveRuntime, type DbConditionalRuntime } from "./commands/manifest.ts";
import { ALL_STAGES } from "../ingest/stage/registry.ts";
import type { IngestStageError, StageRegistryShape } from "../ingest/stage/registry.ts";
import type { BaseStageStats, StageDef } from "../ingest/stage/types.ts";
import { DEFAULT_COMMANDS } from "./commands/visible-commands.ts";

// widened to the registry's canonical erased-R shape (matches StageRegistryLive's parameter)
const stages: ReadonlyArray<StageDef<BaseStageStats, unknown, IngestStageError>> = ALL_STAGES;

const testRegistry: StageRegistryShape = {
    all: () => stages,
    byKey: (key) => stages.find((s) => s.meta.key === key),
    byTag: (tag) => stages.filter((s) => s.meta.tags.includes(tag)),
};

const topLevelNames = (): string[] =>
    rootCommand.subcommands.flatMap((group) =>
        group.commands.map((command) => command.name),
    );

describe("effect cli", () => {
    test("root command exposes the canonical public subcommands", () => {
        const names = topLevelNames();

        expect(names).toEqual(expect.arrayContaining([
            "ingest",
            "derive-signals",
            "derive-intents",
            "insights",
            "classifiers",
            "improve",
            "costs",
            "pricing",
            "studio",
            "otlpd",
            "report",
            "recall",
            "skills",
            "context",
            "hook",
            "project",
            "evidence",
            "version",
            "update",
            "tui",
            "install",
            "doctor",
            "uninstall",
        ]));
    });

    test("retired top-level commands are gone", () => {
        const names = topLevelNames();

        for (const removed of ["onboarding", "ingest-insights", "search", "stats", "recent", "unused", "taste", "pairs", "recovery", "guidance", "session", "self-improve", "dashboard", "interventions"]) {
            expect(names).not.toContain(removed);
        }
    });

    test("daemon survives ONLY as a retirement stub, not as a daemon surface", () => {
        // `daemon` is deliberately NOT in the removed list above. The LaunchAgent
        // lifecycle it managed is gone, but `.github/workflows/ci.yml` smoke-tests
        // `axctl daemon status --json`, and that file cannot be edited from this
        // branch - the push token lacks the `workflow` scope, and GitHub rejects
        // the whole push when any commit touches `.github/workflows/`. Deleting
        // the verb turns CI red with no in-branch fix.
        //
        // So it stays, reporting the truth. This test pins BOTH halves: the verb
        // still answers, and it answers with an empty daemon list - so a future
        // change cannot quietly restore a working daemon surface behind it.
        expect(topLevelNames()).toContain("daemon");

        // Runtime "none" is the load-bearing half: it proves the stub reaches no
        // engine at all. Hidden keeps it out of help so nobody discovers it as a
        // feature.
        expect(entryRuntime(RUNTIME_BY_COMMAND.daemon)).toBe("none");
        expect(entryHidden(RUNTIME_BY_COMMAND.daemon)).toBe(true);
    });

    test("dogfood is hidden by default", () => {
        const names = topLevelNames();
        expect(names).not.toContain("dogfood");
    });

    test("every registered top-level command declares its runtime (anti-drift, replaces hand-maintained DB_COMMANDS)", () => {
        for (const name of topLevelNames()) {
            expect(RUNTIME_BY_COMMAND[name], `command "${name}" missing from a family RuntimeManifest`).toBeDefined();
        }
    });

    test("every manifest-declared command is actually registered (reverse anti-drift: no ghost DB_COMMANDS entries)", () => {
        const registered = new Set(topLevelNames());
        // Sanctioned ghost: dogfood's manifest entry is always spread into
        // RUNTIME_BY_COMMAND, but the command itself only registers under
        // AX_DEV=1 (see devOnlyCommands in index.ts).
        const sanctionedGhosts = new Set(["dogfood"]);
        for (const name of Object.keys(RUNTIME_BY_COMMAND)) {
            if (sanctionedGhosts.has(name)) continue;
            expect(
                registered.has(name),
                `manifest declares "${name}" but no top-level command registers it (ghost RUNTIME_BY_COMMAND/DB_COMMANDS entry)`,
            ).toBe(true);
        }
    });

    test("registered visibility mirrors manifest hard-hides", () => {
        for (const group of rootCommand.subcommands) {
            for (const command of group.commands) {
                const entry = RUNTIME_BY_COMMAND[command.name];
                expect(entry, `command "${command.name}" missing from a family RuntimeManifest`).toBeDefined();
                const expectedHidden = entryHidden(entry!);
                expect(
                    command.hidden,
                    `command "${command.name}": registered hidden=${command.hidden}, expected ${expectedHidden}`,
                ).toBe(expectedHidden);
            }
        }
    });

    test("core and advanced commands stay available to completion; maintenance verbs stay hidden", () => {
        const byName = new Map(
            rootCommand.subcommands.flatMap((g) => g.commands.map((c) => [c.name, c] as const)),
        );
        for (const name of [...DEFAULT_COMMANDS, "signals", "roles", "hooks"]) {
            expect(byName.get(name)?.hidden).toBe(false);
        }
        for (const name of ["derive-signals", "derive-intents", "insights", "hook", "uninstall"]) {
            expect(byName.get(name)?.hidden).toBe(true);
        }
    });

    test("skills group exposes the moved query subcommands", () => {
        const skills = rootCommand.subcommands
            .flatMap((g) => g.commands)
            .find((c) => c.name === "skills");
        expect(skills).toBeDefined();
        const subNames = skills!.subcommands.flatMap((g) => g.commands.map((c) => c.name));
        expect(subNames).toEqual(expect.arrayContaining([
            "search", "stats", "recent", "unused", "taste", "pairs", "recovery",
        ]));
    });

    test("improve group exposes the experiment-loop subcommands", () => {
        const improve = rootCommand.subcommands
            .flatMap((g) => g.commands)
            .find((c) => c.name === "improve");
        expect(improve).toBeDefined();
        const subNames = improve!.subcommands.flatMap((g) => g.commands.map((c) => c.name));
        expect(subNames).toEqual(expect.arrayContaining([
            "list", "show", "accept", "reject", "checkpoint", "verdict", "reset",
        ]));
    });

    test("classifiers group exposes eval, graph, lifecycle, package operations, and workflow candidates", () => {
        const classifiers = rootCommand.subcommands
            .flatMap((g) => g.commands)
            .find((c) => c.name === "classifiers");
        expect(classifiers).toBeDefined();
        const subNames = classifiers!.subcommands.flatMap((g) => g.commands.map((c) => c.name));
        expect(subNames).toEqual(expect.arrayContaining(["list", "eval", "explain", "graph", "lifecycle", "package-operations", "workflow-candidates"]));
    });

    test("--insights-only rejects --since", () => {
        // No conflicts when --insights-only stands alone.
        expect(insightsOnlyConflicts({ hasSince: false })).toEqual([]);
        // --since does not honour --insights-only, so combining is user-error.
        expect(insightsOnlyConflicts({ hasSince: true })).toEqual(["--since"]);
    });

    test("detectRemovedIngestFlag: returns null when no removed flag present", () => {
        expect(detectRemovedIngestFlag([])).toBeNull();
        expect(detectRemovedIngestFlag(["--stages=codex", "--verbose"])).toBeNull();
        expect(detectRemovedIngestFlag(["--derive-only", "--reset"])).toBeNull();
    });

    test("detectRemovedIngestFlag: maps each removed --*-only flag to its --stages= replacement", () => {
        expect(detectRemovedIngestFlag(["--skills-only"])).toEqual({
            flag: "--skills-only",
            replacement: "--stages=skills",
        });
        expect(detectRemovedIngestFlag(["--transcripts-only"])).toEqual({
            flag: "--transcripts-only",
            replacement: "--stages=claude,codex,pi,opencode,cursor",
        });
        expect(detectRemovedIngestFlag(["--codex-only"])).toEqual({
            flag: "--codex-only",
            replacement: "--stages=codex",
        });
        expect(detectRemovedIngestFlag(["--git-only"])).toEqual({
            flag: "--git-only",
            replacement: "--stages=git",
        });
        expect(detectRemovedIngestFlag(["--claude-only"])).toEqual({
            flag: "--claude-only",
            replacement: "--stages=claude",
        });
    });

    test("detectRemovedIngestFlag: still detects when removed flag is buried in args", () => {
        expect(detectRemovedIngestFlag(["--verbose", "--codex-only", "--progress=json"])).toEqual({
            flag: "--codex-only",
            replacement: "--stages=codex",
        });
    });

    test("resolveIngestStages: default runs every stage", () => {
        expect(resolveIngestStages(testRegistry, [])).toEqual(stages);
    });

    test("resolveIngestStages: local agent provider stages can be selected", () => {
        const keys = resolveIngestStages(testRegistry, ["--stages=pi,opencode,cursor"]).map((s) => s.meta.key);
        expect(keys).toEqual(["pi", "opencode", "cursor"]);
    });

    test("resolveIngestStages: --stages= runs exactly the listed stages", () => {
        const keys = resolveIngestStages(testRegistry, ["--stages=signals,outcomes"]).map((s) => s.meta.key);
        expect([...keys].sort()).toEqual([
            "outcomes",
            "signals",
        ]);
    });

    test("resolveIngestStages: --derive-only runs only stages tagged 'derive'", () => {
        const keys = resolveIngestStages(testRegistry, ["--derive-only"]).map((s) => s.meta.key);
        // All stages in the registry with the "derive" tag:
        expect([...keys].sort()).toEqual([
            "advice",
            "cache-bust",
            "classifier-results",
            "closure",
            "content-types",
            "derive-metrics",
            "digest",
            "directive-ngrams",
            "harness",
            "invoked-positions",
            "loaded-skills",
            "opportunities",
            "outcomes",
            "proposals",
            "reaction-events",
            "retro-proposals",
            "run-evidence",
            "session-health",
            "signals",
            "spawned",
            "subagents",
            "turn-analysis",
            "turn-content-blocks",
            "usage",
        ]);
    });

    test("resolveIngestStages: --stages= takes precedence over --derive-only", () => {
        const keys = resolveIngestStages(testRegistry, ["--stages=git", "--derive-only"]).map((s) => s.meta.key);
        expect([...keys]).toEqual([
            "git",
        ]);
    });

    test("evidence group exposes guidance/session/weekly", () => {
        const evidence = rootCommand.subcommands
            .flatMap((g) => g.commands)
            .find((c) => c.name === "evidence");
        expect(evidence).toBeDefined();
        const subNames = evidence!.subcommands.flatMap((g) => g.commands.map((c) => c.name));
        expect(subNames).toEqual(expect.arrayContaining([
            "guidance-next", "session-summary", "weekly",
        ]));
    });

    test("context group exposes file context packs", () => {
        const context = rootCommand.subcommands
            .flatMap((g) => g.commands)
            .find((c) => c.name === "context");
        expect(context).toBeDefined();
        const subNames = context!.subcommands.flatMap((g) => g.commands.map((c) => c.name));
        expect(subNames).toEqual(expect.arrayContaining(["file"]));
        // Ported to the v2 cache runtime. `DB_COMMANDS` is what decides whether
        // AppLayer (and its database connect) is built, so a ported command
        // MUST be absent from it - same acceptance shape as `recall` below.
        expect(entryRuntime(RUNTIME_BY_COMMAND["context"]!)).toBe("cache");
        expect(DB_COMMANDS.has("context")).toBe(false);
    });

    test("hook group exposes file-context and log, declared db-conditional and excluded from DB_COMMANDS (dispatch resolves per-invocation)", () => {
        const hook = rootCommand.subcommands
            .flatMap((g) => g.commands)
            .find((c) => c.name === "hook");
        expect(hook).toBeDefined();
        const subNames = hook!.subcommands.flatMap((g) => g.commands.map((c) => c.name));
        expect(subNames).toEqual(expect.arrayContaining(["file-context", "log"]));
        // "hook" (harness plumbing) is declared db-conditional, with every
        // subcommand (file-context, log) currently resolving to the cache
        // runtime - see commands/hooks.ts's routing table. Full per-subcommand
        // + anti-drift coverage: "hook/hooks db-conditional routing" below.
        expect(DB_COMMANDS.has("hook")).toBe(false);
    });

    test("hooks group exposes native hook inspection commands, declared db-conditional and excluded from DB_COMMANDS (dispatch resolves per-invocation)", () => {
        const hooks = rootCommand.subcommands
            .flatMap((g) => g.commands)
            .find((c) => c.name === "hooks");
        expect(hooks).toBeDefined();
        const subNames = hooks!.subcommands.flatMap((g) => g.commands.map((c) => c.name));
        expect(subNames).toEqual(expect.arrayContaining(["summary", "invocations", "session", "backtest"]));
        // "hooks" is declared db-conditional, with every subcommand
        // (summary/config/install/backtest/...) currently resolving to the
        // cache runtime - see commands/hooks.ts's routing table. Full
        // per-subcommand + anti-drift coverage: "hook/hooks db-conditional
        // routing" below.
        expect(DB_COMMANDS.has("hooks")).toBe(false);
    });

    test("cost and pricing commands are routed on the v2 cache runtime", () => {
        const costs = rootCommand.subcommands
            .flatMap((g) => g.commands)
            .find((c) => c.name === "costs");
        expect(costs).toBeDefined();
        const subNames = costs!.subcommands.flatMap((g) => g.commands.map((c) => c.name));
        expect(subNames).toEqual(expect.arrayContaining(["summary", "for"]));
        expect(entryRuntime(RUNTIME_BY_COMMAND["costs"]!)).toBe("cache");
        expect(entryRuntime(RUNTIME_BY_COMMAND["pricing"]!)).toBe("cache");
        expect(DB_COMMANDS.has("costs")).toBe(false);
        expect(DB_COMMANDS.has("pricing")).toBe(false);
    });

    test("recall is routed on the v2 cache runtime, and never opens SurrealDB", () => {
        // The acceptance signal for the ported vertical: `"cache"` resolves to
        // `withCache`, which provides a real `CacheReadLive` and never builds
        // `AppLayer` (the layer that would open a database connection), so an
        // un-ported path inside recall that still needed a live database would
        // fail to typecheck rather than silently reaching for one.
        expect(entryRuntime(RUNTIME_BY_COMMAND["recall"]!)).toBe("cache");
        // DB_COMMANDS is what decides whether AppLayer (and its connect) is
        // built, so a ported command MUST be absent from it.
        expect(DB_COMMANDS.has("recall")).toBe(false);
        expect(topLevelNames()).toContain("recall");
    });

    test("share and star route through manifests as no-DB commands - no dispatch bypass (#242)", () => {
        const names = topLevelNames();
        expect(names).toContain("share");
        expect(names).toContain("star");
        expect(entryRuntime(RUNTIME_BY_COMMAND["share"]!)).toBe("none");
        expect(entryRuntime(RUNTIME_BY_COMMAND["star"]!)).toBe("none");
        expect(DB_COMMANDS.has("share")).toBe(false);
        expect(DB_COMMANDS.has("star")).toBe(false);
        // star is the nudge target (`ax star --done`), not a discovery surface
        const byName = new Map(
            rootCommand.subcommands.flatMap((g) => g.commands.map((c) => [c.name, c] as const)),
        );
        expect(byName.get("star")?.hidden).toBe(true);
    });

    test("DB-backed classifier package-operation flags are routed through DB", () => {
        expect(classifiersPackageOperationsNeedsDb([
            "classifiers",
            "package-operations",
            "--apply-write-plan",
        ])).toBe(true);
        expect(classifiersPackageOperationsNeedsDb([
            "classifiers",
            "package-operations",
            "--graph-health",
        ])).toBe(true);
        expect(classifiersPackageOperationsNeedsDb([
            "classifiers",
            "package-operations",
            "--boundary-replay-summary",
        ])).toBe(true);
        expect(classifiersPackageOperationsNeedsDb([
            "classifiers",
            "package-operations",
            "--quality-status",
        ])).toBe(false);
    });
});

describe("classifiers db-conditional routing (#241)", () => {
    const classifiersSubNames = (): string[] => {
        const classifiers = rootCommand.subcommands
            .flatMap((g) => g.commands)
            .find((c) => c.name === "classifiers");
        expect(classifiers).toBeDefined();
        return classifiers!.subcommands.flatMap((g) => g.commands.map((c) => c.name));
    };

    const classifiersDeclaration = (): DbConditionalRuntime => {
        const entry = RUNTIME_BY_COMMAND["classifiers"];
        expect(entry).toBeDefined();
        const declared = entryRuntime(entry!);
        expect(typeof declared).toBe("object");
        expect((declared as DbConditionalRuntime).kind).toBe("db-conditional");
        return declared as DbConditionalRuntime;
    };

    test("classifiers is declared db-conditional and excluded from DB_COMMANDS (dispatch resolves per-invocation)", () => {
        classifiersDeclaration();
        expect(DB_COMMANDS.has("classifiers")).toBe(false);
    });

    test("every registered classifiers subcommand declares its routing (anti-drift)", () => {
        const declared = classifiersDeclaration().subcommands;
        for (const name of classifiersSubNames()) {
            expect(
                declared[name],
                `classifiers subcommand "${name}" missing from the db-conditional routing table in commands/classifiers.ts`,
            ).toBeDefined();
        }
    });

    test("every declared classifiers routing entry maps to a registered subcommand (reverse anti-drift)", () => {
        const registered = new Set(classifiersSubNames());
        for (const name of Object.keys(classifiersDeclaration().subcommands)) {
            expect(
                registered.has(name),
                `routing table declares classifiers subcommand "${name}" but classifiersCommand does not register it`,
            ).toBe(true);
        }
    });

    test("resolveRuntime keeps the #241 split, with the graph side now on cache", () => {
        const declared = classifiersDeclaration();
        // Graph-reading subcommands - `"db"` until the v2 flip, `"cache"` now.
        // The SPLIT is what #241 introduced and what this pins; which engine
        // the reading side resolves to is the migration's business.
        expect(resolveRuntime(declared, ["classifiers", "graph"])).toBe("cache");
        expect(resolveRuntime(declared, ["classifiers", "lifecycle"])).toBe("cache");
        expect(resolveRuntime(declared, ["classifiers", "explain"])).toBe("cache");
        expect(resolveRuntime(declared, ["classifiers", "workflow-candidates"])).toBe("cache");
        expect(resolveRuntime(declared, ["classifiers", "label-mining"])).toBe("cache");
        // No-DB subcommands.
        expect(resolveRuntime(declared, ["classifiers", "eval"])).toBe("none");
        expect(resolveRuntime(declared, ["classifiers", "list"])).toBe("none");
        // package-operations: reaches an engine ONLY with the
        // write-plan/health/replay flags. That per-flag split is the point and
        // it survives - only the engine side moved from `"db"` to `"cache"`.
        expect(resolveRuntime(declared, ["classifiers", "package-operations"])).toBe("none");
        expect(resolveRuntime(declared, ["classifiers", "package-operations", "--quality-status"])).toBe("none");
        expect(resolveRuntime(declared, ["classifiers", "package-operations", "--apply-write-plan"])).toBe("cache");
        expect(resolveRuntime(declared, ["classifiers", "package-operations", "--graph-health"])).toBe("cache");
        expect(resolveRuntime(declared, ["classifiers", "package-operations", "--boundary-replay-summary"])).toBe("cache");
        expect(resolveRuntime(declared, ["classifiers"])).toBe("cache");
        expect(resolveRuntime(declared, ["classifiers", "--help"])).toBe("cache");
        expect(DB_COMMANDS.has("classifiers")).toBe(false);
    });

    test("static manifest declarations resolve to themselves", () => {
        expect(resolveRuntime("cache", ["sessions"])).toBe("cache");
        expect(resolveRuntime("ingest", ["ingest"])).toBe("ingest");
        expect(resolveRuntime("none", ["version"])).toBe("none");
    });
});

describe("hook/hooks db-conditional routing", () => {
    const subNamesOf = (family: string): string[] => {
        const command = rootCommand.subcommands
            .flatMap((g) => g.commands)
            .find((c) => c.name === family);
        expect(command).toBeDefined();
        return command!.subcommands.flatMap((g) => g.commands.map((c) => c.name));
    };

    const declarationOf = (family: string): DbConditionalRuntime => {
        const entry = RUNTIME_BY_COMMAND[family];
        expect(entry).toBeDefined();
        const declared = entryRuntime(entry!);
        expect(typeof declared).toBe("object");
        expect((declared as DbConditionalRuntime).kind).toBe("db-conditional");
        return declared as DbConditionalRuntime;
    };

    for (const family of ["hook", "hooks"] as const) {
        test(`${family} is declared db-conditional and excluded from DB_COMMANDS (dispatch resolves per-invocation)`, () => {
            declarationOf(family);
            expect(DB_COMMANDS.has(family)).toBe(false);
        });

        // The concrete failure mode this pins: a typo'd key in the routing
        // table (commands/hooks.ts) silently falls back to the family's
        // `fallback: "db"` for a real subcommand - un-porting `hook log` /
        // `hooks backtest` with no test failure, because resolveRuntime never
        // throws on a missing table entry.
        test(`every registered ${family} subcommand declares its routing (anti-drift)`, () => {
            const declared = declarationOf(family).subcommands;
            for (const name of subNamesOf(family)) {
                expect(
                    declared[name],
                    `${family} subcommand "${name}" missing from the db-conditional routing table in commands/hooks.ts`,
                ).toBeDefined();
            }
        });

        // The reverse failure mode: a typo'd key that never matches any real
        // subcommand is a dead/ghost table entry - it silently does nothing
        // (the real, correctly-spelled subcommand keeps falling back to
        // "db") while looking, on a read of the table, like it routed
        // something.
        test(`every declared ${family} routing entry maps to a registered subcommand (reverse anti-drift)`, () => {
            const registered = new Set(subNamesOf(family));
            for (const name of Object.keys(declarationOf(family).subcommands)) {
                expect(
                    registered.has(name),
                    `routing table declares ${family} subcommand "${name}" but ${family}Command does not register it`,
                ).toBe(true);
            }
        });
    }

    test("the whole hook/hooks family resolves on the cache runtime", () => {
        const hook = declarationOf("hook");
        expect(resolveRuntime(hook, ["hook", "file-context"])).toBe("cache");
        expect(resolveRuntime(hook, ["hook", "log"])).toBe("cache");
        // The family stays db-CONDITIONAL rather than collapsing to a static
        // declaration: the shape is what lets a future subcommand differ, and
        // the bare-family fallback is load-bearing (harness plumbing invokes
        // `hook` directly, with no dispatch help/typo path).
        expect(resolveRuntime(hook, ["hook"])).toBe("cache");

        const hooks = declarationOf("hooks");
        expect(resolveRuntime(hooks, ["hooks", "backtest"])).toBe("cache");
        expect(resolveRuntime(hooks, ["hooks", "summary"])).toBe("cache");
        expect(resolveRuntime(hooks, ["hooks", "install"])).toBe("cache");
        expect(resolveRuntime(hooks, ["hooks"])).toBe("cache");
        expect(DB_COMMANDS.has("hooks")).toBe(false);
    });
});

describe("sessions command", () => {
    test("sessions group is exposed at top level", () => {
        const names = topLevelNames();
        expect(names).toContain("sessions");
    });

    test("sessions exposes here, around, near, churn subcommands", () => {
        const sessions = rootCommand.subcommands
            .flatMap((g) => g.commands)
            .find((c) => c.name === "sessions");
        expect(sessions).toBeDefined();
        const subNames = sessions!.subcommands.flatMap((g) => g.commands.map((c) => c.name));
        expect(subNames).toEqual(expect.arrayContaining(["here", "around", "near", "churn"]));
    });

    const sessionsDeclaration = (): DbConditionalRuntime => {
        const entry = RUNTIME_BY_COMMAND["sessions"];
        expect(entry).toBeDefined();
        const declared = entryRuntime(entry!);
        expect(typeof declared).toBe("object");
        expect((declared as DbConditionalRuntime).kind).toBe("db-conditional");
        return declared as DbConditionalRuntime;
    };

    test("sessions is declared db-conditional and excluded from DB_COMMANDS (dispatch resolves per-invocation)", () => {
        // Declared db-conditional, with every subcommand (show/here/around/
        // near/compare) currently resolving to the cache runtime - see the
        // per-subcommand routing table in commands/sessions.ts.
        sessionsDeclaration();
        expect(DB_COMMANDS.has("sessions")).toBe(false);
    });

    test("every registered sessions subcommand declares its routing (anti-drift)", () => {
        const declared = sessionsDeclaration().subcommands;
        const sessions = rootCommand.subcommands
            .flatMap((g) => g.commands)
            .find((c) => c.name === "sessions");
        for (const name of sessions!.subcommands.flatMap((g) => g.commands.map((c) => c.name))) {
            expect(
                declared[name],
                `sessions subcommand "${name}" missing from the db-conditional routing table in commands/sessions.ts`,
            ).toBeDefined();
        }
    });

    test("every sessions subcommand routes to the cache runtime", () => {
        const entry = RUNTIME_BY_COMMAND["sessions"]!;
        expect(resolveRuntime(entry, ["sessions", "show", "abc"])).toBe("cache");
        expect(resolveRuntime(entry, ["sessions", "here"])).toBe("cache");
        expect(resolveRuntime(entry, ["sessions", "around", "2026-01-01"])).toBe("cache");
        expect(resolveRuntime(entry, ["sessions", "near", "HEAD"])).toBe("cache");
        expect(resolveRuntime(entry, ["sessions", "compare", "a", "b"])).toBe("cache");
        expect(resolveRuntime(entry, ["sessions"])).toBe("cache");
        // `here`/`near` are the two that changed BEHAVIOUR, not just runtime:
        // resolving $PWD used to match against a git-derived key that hit no
        // row in a v2 snapshot. They now resolve the cache's repository ROW
        // id, so `--here` scoping selects rows instead of none.
        expect(DB_COMMANDS.has("sessions")).toBe(false);
    });
});

describe("ingest here subcommand", () => {
    test("ingest command exposes a 'here' subcommand", () => {
        const ingest = rootCommand.subcommands
            .flatMap((g) => g.commands)
            .find((c) => c.name === "ingest");
        expect(ingest).toBeDefined();
        const subNames = ingest!.subcommands.flatMap((g) => g.commands.map((c) => c.name));
        expect(subNames).toContain("here");
    });

    test("ingest here is routed as a DB command (via ingest parent)", () => {
        // 'ingest here' routes through the 'ingest' parent which is a DB command.
        expect(DB_COMMANDS.has("ingest")).toBe(true);
    });
});

describe("AX_DEV flag", () => {
    test("AX_DEV=1 exposes dogfood at top level", async () => {
        process.env.AX_DEV = "1";
        try {
            // re-import to rebuild rootCommand with env applied
            const mod = await import(`./index.ts?ax_dev=${Date.now()}`);
            const names = mod.rootCommand.subcommands.flatMap((g: any) => g.commands.map((c: any) => c.name));
            expect(names).toContain("dogfood");
        } finally {
            delete process.env.AX_DEV;
        }
    });
});
