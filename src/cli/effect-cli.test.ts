import { describe, expect, test } from "bun:test";
import { DB_COMMANDS, insightsOnlyConflicts, rootCommand } from "./index.ts";

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
            "interventions",
            "dashboard",
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

        for (const removed of ["onboarding", "ingest-insights", "search", "stats", "recent", "unused", "taste", "pairs", "recovery", "guidance", "session", "self-improve"]) {
            expect(names).not.toContain(removed);
        }
    });

    test("dogfood is hidden by default", () => {
        const names = topLevelNames();
        expect(names).not.toContain("dogfood");
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

    test("--insights-only rejects other --*-only flags and --since", () => {
        const base = {
            skillsOnly: false,
            transcriptsOnly: false,
            codexOnly: false,
            gitOnly: false,
            claudeOnly: false,
            hasSince: false,
        };
        // No conflicts when --insights-only stands alone.
        expect(insightsOnlyConflicts(base)).toEqual([]);
        // Each other --*-only flag is flagged as a conflict.
        expect(insightsOnlyConflicts({ ...base, codexOnly: true })).toEqual(["--codex-only"]);
        expect(insightsOnlyConflicts({ ...base, skillsOnly: true })).toEqual(["--skills-only"]);
        expect(insightsOnlyConflicts({ ...base, transcriptsOnly: true })).toEqual(["--transcripts-only"]);
        expect(insightsOnlyConflicts({ ...base, gitOnly: true })).toEqual(["--git-only"]);
        expect(insightsOnlyConflicts({ ...base, claudeOnly: true })).toEqual(["--claude-only"]);
        // --since does not honour --insights-only, so combining is user-error.
        expect(insightsOnlyConflicts({ ...base, hasSince: true })).toEqual(["--since"]);
        // Multiple conflicts list every offender, in stable order.
        expect(insightsOnlyConflicts({ ...base, codexOnly: true, hasSince: true })).toEqual([
            "--codex-only",
            "--since",
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
