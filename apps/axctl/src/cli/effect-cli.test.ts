import { describe, expect, test } from "bun:test";
import {
    DB_COMMANDS,
    RUNTIME_BY_COMMAND,
    classifiersPackageOperationsNeedsDb,
    detectRemovedIngestFlag,
    insightsOnlyConflicts,
    resolveIngestStages,
    rootCommand,
} from "./index.ts";
import { ALL_STAGES } from "../ingest/stage/registry.ts";
import type { StageRegistryShape } from "../ingest/stage/registry.ts";
import type { BaseStageStats, StageDef } from "../ingest/stage/types.ts";

// widened to the registry's canonical erased-R shape (matches StageRegistryLive's parameter)
const stages: ReadonlyArray<StageDef<BaseStageStats, unknown>> = ALL_STAGES;

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
            "serve",
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
            "daemon",
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

    test("read-only insight surfaces are visible; maintenance verbs stay hidden (#173)", () => {
        const byName = new Map(
            rootCommand.subcommands.flatMap((g) => g.commands.map((c) => [c.name, c] as const)),
        );
        // Visibility policy: hidden = invisible to agents discovering the tool
        // via --help = never used. Insight surfaces must show in help.
        for (const name of ["sessions", "recall", "skills", "signals", "roles", "hooks"]) {
            expect(byName.get(name)?.hidden).toBe(false);
        }
        // Mutating / maintenance / plumbing verbs stay hidden (but callable).
        for (const name of ["derive-signals", "derive-intents", "insights", "hook", "daemon", "uninstall"]) {
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
        // 27 = 24 original + agentDefStage (config-front-door agents domain)
        //    + deriveMetricsStage (graph-derived session metrics rollup)
        //    + githubPrStage (restored GitHub PR ingest - issue #172).
        expect(resolveIngestStages(testRegistry, [])).toHaveLength(27);
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
            "classifier-results",
            "closure",
            "derive-metrics",
            "harness",
            "invoked-positions",
            "opportunities",
            "outcomes",
            "proposals",
            "reaction-events",
            "retro-proposals",
            "session-health",
            "signals",
            "spawned",
            "subagents",
            "turn-analysis",
            "turn-content-blocks",
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
        expect(DB_COMMANDS.has("context")).toBe(true);
    });

    test("hook group exposes file-context and is a DB command", () => {
        const hook = rootCommand.subcommands
            .flatMap((g) => g.commands)
            .find((c) => c.name === "hook");
        expect(hook).toBeDefined();
        const subNames = hook!.subcommands.flatMap((g) => g.commands.map((c) => c.name));
        expect(subNames).toEqual(expect.arrayContaining(["file-context"]));
        expect(DB_COMMANDS.has("hook")).toBe(true);
    });

    test("hooks group exposes native hook inspection commands", () => {
        const hooks = rootCommand.subcommands
            .flatMap((g) => g.commands)
            .find((c) => c.name === "hooks");
        expect(hooks).toBeDefined();
        const subNames = hooks!.subcommands.flatMap((g) => g.commands.map((c) => c.name));
        expect(subNames).toEqual(expect.arrayContaining(["summary", "invocations", "session", "backtest"]));
        expect(DB_COMMANDS.has("hooks")).toBe(true);
    });

    test("cost and pricing commands are routed through DB", () => {
        const costs = rootCommand.subcommands
            .flatMap((g) => g.commands)
            .find((c) => c.name === "costs");
        expect(costs).toBeDefined();
        const subNames = costs!.subcommands.flatMap((g) => g.commands.map((c) => c.name));
        expect(subNames).toEqual(expect.arrayContaining(["summary", "for"]));
        expect(DB_COMMANDS.has("costs")).toBe(true);
        expect(DB_COMMANDS.has("pricing")).toBe(true);
    });

    test("share and star route through manifests as no-DB commands - no dispatch bypass (#242)", () => {
        const names = topLevelNames();
        expect(names).toContain("share");
        expect(names).toContain("star");
        expect(RUNTIME_BY_COMMAND["share"]).toBe("none");
        expect(RUNTIME_BY_COMMAND["star"]).toBe("none");
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

describe("sessions command", () => {
    test("sessions group is exposed at top level", () => {
        const names = topLevelNames();
        expect(names).toContain("sessions");
    });

    test("sessions exposes here, around, near subcommands", () => {
        const sessions = rootCommand.subcommands
            .flatMap((g) => g.commands)
            .find((c) => c.name === "sessions");
        expect(sessions).toBeDefined();
        const subNames = sessions!.subcommands.flatMap((g) => g.commands.map((c) => c.name));
        expect(subNames).toEqual(expect.arrayContaining(["here", "around", "near"]));
    });

    test("sessions is routed as a DB command", () => {
        expect(DB_COMMANDS.has("sessions")).toBe(true);
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
