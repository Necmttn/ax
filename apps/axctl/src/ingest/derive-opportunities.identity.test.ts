/**
 * F02 (#1133): the opportunity detector must measure the artifact ax OBSERVED
 * being installed, and must credit a hook fire only when the fire carries that
 * hook's complete marker identity.
 *
 * Nothing here is mocked around the code path under test: the sidecar is a real
 * temporary SQLite judgment store, the cache is a real DuckDB built from the
 * production `schema.duckdb.sql`, the experiment is installed through the real
 * `improve accept` + `improve lint` pair, and every hook fire reaches the graph
 * through the real claude transcript parser (a blocked tool_result line, a
 * `hook_success` attachment, a `hook_progress` line) rather than being inserted
 * by hand.
 */
import { describe, expect } from "bun:test";
import { mkdir, utimes } from "node:fs/promises";
import { join } from "node:path";
import { Effect, FileSystem, Layer, Path } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { AxConfigTest } from "@ax/lib/config";
import { FixturePlatform, publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { Judgment, JudgmentLayer } from "@ax/lib/sqlite";
import { SIDECAR_SCHEMA_SQL } from "@ax/schema/sidecar-ddl";
import { acceptProposal } from "../improve/actions.ts";
import { lintFiles } from "../improve/lint.ts";
import { deriveOpportunities, type DeriveOpportunitiesStats } from "./derive-opportunities.ts";
import { ingestTranscripts } from "./transcripts.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("opportunity artifact identity", {
    requireFts: true,
});

const SESSION = "identity-session";
const OTHER_SESSION = "other-session";

interface OpportunityRow {
    readonly in_id: string;
    readonly out_id: string;
    readonly out_table: string;
    readonly was_addressed: boolean;
}

interface Harness {
    readonly root: string;
    readonly sidecarPath: string;
    readonly transcriptsDir: string;
    /** Run judgment-side work (accept / lint / seed) against the real sidecar. */
    readonly judgment: <A>(
        effect: Effect.Effect<A, unknown, Judgment | FileSystem.FileSystem | Path.Path>,
    ) => Promise<A>;
}

const makeHarness = (label: string): Harness => {
    const root = tempDir(label);
    const sidecarPath = join(root, "judgment.sqlite");
    const transcriptsDir = join(root, "transcripts");
    const layer = Layer.mergeAll(
        JudgmentLayer({ sidecarPath, schemaSql: SIDECAR_SCHEMA_SQL }),
        BunFileSystem.layer,
        BunPath.layer,
    );
    return {
        root,
        sidecarPath,
        transcriptsDir,
        judgment: <A>(effect: Effect.Effect<A, unknown, Judgment | FileSystem.FileSystem | Path.Path>) =>
            Effect.runPromise(
                effect.pipe(Effect.provide(layer), Effect.scoped) as Effect.Effect<A, unknown, never>,
            ),
    };
};

/** Write one claude transcript file (one session) under the fixture root. */
const writeTranscript = async (
    harness: Harness,
    sessionId: string,
    entries: ReadonlyArray<Record<string, unknown>>,
): Promise<void> => {
    const projectDir = join(harness.transcriptsDir, "-repo");
    await mkdir(projectDir, { recursive: true });
    await Bun.write(
        join(projectDir, `${sessionId}.jsonl`),
        entries.map((entry) => JSON.stringify(entry)).join("\n"),
    );
};

const assistantToolUse = (opts: {
    readonly sessionId: string;
    readonly toolUseId: string;
    readonly ts: string;
}): Record<string, unknown> => ({
    type: "assistant",
    uuid: `${opts.toolUseId}-call`,
    sessionId: opts.sessionId,
    timestamp: opts.ts,
    cwd: "/repo",
    message: {
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [{ type: "tool_use", id: opts.toolUseId, name: "Bash", input: { command: "git reset --hard" } }],
    },
});

const failingToolResult = (opts: {
    readonly sessionId: string;
    readonly toolUseId: string;
    readonly ts: string;
    readonly text: string;
}): Record<string, unknown> => ({
    type: "user",
    uuid: `${opts.toolUseId}-result`,
    sessionId: opts.sessionId,
    timestamp: opts.ts,
    cwd: "/repo",
    message: {
        role: "user",
        content: [{
            type: "tool_result",
            tool_use_id: opts.toolUseId,
            is_error: true,
            content: opts.text,
        }],
    },
    toolUseResult: `Error: ${opts.text}`,
});

const hookSuccessAttachment = (opts: {
    readonly sessionId: string;
    readonly toolUseId: string;
    readonly ts: string;
    readonly command: string;
    readonly hookEvent: string;
    readonly stdout: string;
}): Record<string, unknown> => ({
    type: "attachment",
    uuid: `${opts.toolUseId}-${opts.hookEvent}-success`,
    sessionId: opts.sessionId,
    timestamp: opts.ts,
    cwd: "/repo",
    attachment: {
        type: "hook_success",
        hookName: `${opts.hookEvent}:Bash`,
        hookEvent: opts.hookEvent,
        toolUseID: opts.toolUseId,
        command: opts.command,
        stdout: opts.stdout,
        stderr: "",
        exitCode: 0,
        durationMs: 12,
    },
});

const hookProgressLine = (opts: {
    readonly sessionId: string;
    readonly toolUseId: string;
    readonly ts: string;
    readonly command: string;
}): Record<string, unknown> => ({
    type: "progress",
    uuid: `${opts.toolUseId}-progress`,
    sessionId: opts.sessionId,
    timestamp: opts.ts,
    cwd: "/repo",
    toolUseID: opts.toolUseId,
    data: {
        type: "hook_progress",
        hookEvent: "PreToolUse",
        hookName: "PreToolUse:Bash",
        command: opts.command,
    },
});

/** Seed an open hook proposal with complete safety gates, then install it the
 *  way a user does: `improve accept` emits the task, the settings file gets the
 *  marked command, `improve lint` records the artifact it FOUND. */
const installHookExperiment = async (harness: Harness, opts: {
    readonly sig: string;
    readonly eventName: string;
    readonly settingsCommand: string;
    readonly install?: boolean;
}): Promise<void> => {
    await harness.judgment(Effect.gen(function* () {
        const judgment = yield* Judgment;
        const now = new Date();
        yield* judgment.put("proposal", {
            id: `proposal-${opts.sig}`, form: "hook", title: "Guard resets",
            hypothesis: "hard resets keep failing", dedupe_sig: opts.sig, frequency: 3,
            confidence: "high", status: "open", origin: "agent", hypothesis_template: null,
            evidence_query: null, reject_reason: null, baseline: null, created_at: now, updated_at: now,
        });
        yield* judgment.put("hook_proposal", {
            id: `hook-${opts.sig}`, proposal: `proposal-${opts.sig}`, event_name: opts.eventName,
            target_tool: "Bash", hook_command: opts.settingsCommand,
            recovery_path: "delete the settings entry", smoke_test_command: "echo ok",
            disable_command: "ax hooks remove", failure_mode: "fail_open",
        });
        yield* acceptProposal({ sigOrId: opts.sig, taskDir: join(harness.root, "tasks") });
    }));

    if (opts.install === false) return;
    await Bun.write(
        join(harness.root, "settings.json"),
        JSON.stringify({
            hooks: {
                [opts.eventName]: [
                    { matcher: "Bash", hooks: [{ type: "command", command: opts.settingsCommand }] },
                ],
            },
        }),
    );
    const lint = await harness.judgment(lintFiles({ roots: [harness.root] }));
    expect(lint.reconciled).toHaveLength(1);
};

/** Ingest the transcripts, derive opportunities, and read back what landed. */
const ingestAndDerive = async (
    harness: Harness,
    seed?: (write: Parameters<Parameters<typeof publishCacheFixture>[2]>[0]) => Effect.Effect<unknown, unknown, never>,
): Promise<{ readonly stats: DeriveOpportunitiesStats; readonly rows: ReadonlyArray<OpportunityRow> }> => {
    let stats: DeriveOpportunitiesStats | null = null;
    let rows: ReadonlyArray<OpportunityRow> = [];
    // The claude stage walks this directory even when a scenario has no
    // transcripts (the guidance cases), so it always has to exist.
    await mkdir(harness.transcriptsDir, { recursive: true });
    const judgmentLayer = Layer.mergeAll(
        JudgmentLayer({ sidecarPath: harness.sidecarPath, schemaSql: SIDECAR_SCHEMA_SQL }),
        BunFileSystem.layer,
    );
    await runWithPlatform(publishCacheFixture(join(harness.root, "cache"), dylibPath, (write) =>
        Effect.gen(function* () {
            if (seed) yield* seed(write);
            yield* ingestTranscripts(write).pipe(
                Effect.provide(AxConfigTest({ paths: { transcriptsDir: harness.transcriptsDir } })),
                Effect.provide(FixturePlatform),
            );
            stats = yield* deriveOpportunities(write).pipe(
                Effect.provide(judgmentLayer),
                Effect.scoped,
            );
            const read = yield* write.raw(
                "SELECT in_id, out_id, out_table, was_addressed FROM opportunity ORDER BY out_id",
            );
            rows = read.rows as unknown as OpportunityRow[];
        })));
    if (stats === null) throw new Error("deriveOpportunities did not run");
    return { stats, rows };
};

/** Transcript timestamps must sit after the observed install, which happens at
 *  the real clock during `lint`. A minute of margin keeps it deterministic. */
const afterInstall = (offsetMs: number): string => new Date(Date.now() + 60_000 + offsetMs).toISOString();

describe("hook form: observed marker identity", () => {
    dtest("credits a blocked fire recovered from tool-result text, end to end", async () => {
        const harness = makeHarness("ax-opp-identity-hook-");
        const command = "bun ~/.ax/hooks/enforce-worktree.ts # ax:74da7418";
        await installHookExperiment(harness, {
            sig: "74da7418",
            eventName: "PreToolUse",
            settingsCommand: command,
        });
        await writeTranscript(harness, SESSION, [
            assistantToolUse({ sessionId: SESSION, toolUseId: "toolu_1", ts: afterInstall(0) }),
            failingToolResult({
                sessionId: SESSION,
                toolUseId: "toolu_1",
                ts: afterInstall(500),
                text: `PreToolUse:Bash hook error: [${command}]: BLOCKED: dirty primary tree`,
            }),
        ]);

        const { stats, rows } = await ingestAndDerive(harness);
        expect(stats.byHookForm).toBe(1);
        expect(stats.artifactUnavailable).toBe(0);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.was_addressed).toBe(true);
        expect(rows[0]!.out_table).toBe("tool_call");
    });

    dtest("credits python, node and wrapper hooks, and never a prefix collision", async () => {
        for (const [index, command] of [
            "python3 ~/.ax/hooks/guard.py # ax:74da7418",
            "node ./guard.js --marker ax:74da7418",
            "bash -c \"echo 'ax:74da7418' && exec ~/.ax/hooks/guard\"",
        ].entries()) {
            const harness = makeHarness(`ax-opp-identity-shape-${index}-`);
            await installHookExperiment(harness, {
                sig: "74da7418",
                eventName: "PreToolUse",
                settingsCommand: command,
            });
            await writeTranscript(harness, SESSION, [
                assistantToolUse({ sessionId: SESSION, toolUseId: "toolu_1", ts: afterInstall(0) }),
                failingToolResult({
                    sessionId: SESSION,
                    toolUseId: "toolu_1",
                    ts: afterInstall(500),
                    text: `PreToolUse:Bash hook error: [${command}]: BLOCKED`,
                }),
            ]);
            const { rows } = await ingestAndDerive(harness);
            expect(rows.map((r) => r.was_addressed)).toEqual([true]);
        }
    });

    dtest("a longer marker sharing this one's prefix is a different experiment", async () => {
        const harness = makeHarness("ax-opp-identity-prefix-");
        const installed = "bun ~/.ax/hooks/guard.ts # ax:74da7418";
        const neighbour = "bun ~/.ax/hooks/other-guard.ts # ax:74da7418ff";
        await installHookExperiment(harness, {
            sig: "74da7418",
            eventName: "PreToolUse",
            settingsCommand: installed,
        });
        await writeTranscript(harness, SESSION, [
            assistantToolUse({ sessionId: SESSION, toolUseId: "toolu_1", ts: afterInstall(0) }),
            failingToolResult({
                sessionId: SESSION,
                toolUseId: "toolu_1",
                ts: afterInstall(500),
                text: `PreToolUse:Bash hook error: [${neighbour}]: BLOCKED`,
            }),
        ]);

        const { rows } = await ingestAndDerive(harness);
        expect(rows.map((r) => r.was_addressed)).toEqual([false]);
    });

    dtest("credits only the call the fire names, not its neighbour in the same session", async () => {
        const harness = makeHarness("ax-opp-identity-call-");
        const command = "bun ~/.ax/hooks/guard.ts # ax:74da7418";
        await installHookExperiment(harness, {
            sig: "74da7418",
            eventName: "PreToolUse",
            settingsCommand: command,
        });
        await writeTranscript(harness, SESSION, [
            assistantToolUse({ sessionId: SESSION, toolUseId: "toolu_a", ts: afterInstall(0) }),
            failingToolResult({
                sessionId: SESSION,
                toolUseId: "toolu_a",
                ts: afterInstall(500),
                text: "error: pathspec did not match",
            }),
            assistantToolUse({ sessionId: SESSION, toolUseId: "toolu_b", ts: afterInstall(1_000) }),
            failingToolResult({
                sessionId: SESSION,
                toolUseId: "toolu_b",
                ts: afterInstall(1_500),
                text: `PreToolUse:Bash hook error: [${command}]: BLOCKED`,
            }),
        ]);

        const { stats, rows } = await ingestAndDerive(harness);
        expect(stats.byHookForm).toBe(2);
        expect(stats.addressed).toBe(1);
        expect(rows.filter((r) => r.was_addressed)).toHaveLength(1);
    });

    dtest("a fire in another session never credits this session's failure", async () => {
        const harness = makeHarness("ax-opp-identity-session-");
        const command = "bun ~/.ax/hooks/guard.ts # ax:74da7418";
        await installHookExperiment(harness, {
            sig: "74da7418",
            eventName: "PreToolUse",
            settingsCommand: command,
        });
        await writeTranscript(harness, SESSION, [
            assistantToolUse({ sessionId: SESSION, toolUseId: "toolu_1", ts: afterInstall(0) }),
            failingToolResult({
                sessionId: SESSION,
                toolUseId: "toolu_1",
                ts: afterInstall(500),
                text: "error: pathspec did not match",
            }),
        ]);
        await writeTranscript(harness, OTHER_SESSION, [
            assistantToolUse({ sessionId: OTHER_SESSION, toolUseId: "toolu_2", ts: afterInstall(600) }),
            failingToolResult({
                sessionId: OTHER_SESSION,
                toolUseId: "toolu_2",
                ts: afterInstall(700),
                text: `PreToolUse:Bash hook error: [${command}]: BLOCKED`,
            }),
        ]);

        const { rows } = await ingestAndDerive(harness);
        // Two failing Bash calls; only the OTHER session's call was blocked.
        expect(rows.filter((r) => r.was_addressed)).toHaveLength(1);
        const blocked = rows.find((r) => r.was_addressed);
        // The blocked call is the other session's `toolu_2`, never this one's.
        expect(blocked?.out_id).toContain("toolu_2");
    });

    dtest("a fire on a different event name is not this hook's evidence", async () => {
        const harness = makeHarness("ax-opp-identity-event-");
        const command = "bun ~/.ax/hooks/guard.ts # ax:74da7418";
        await installHookExperiment(harness, {
            sig: "74da7418",
            eventName: "PreToolUse",
            settingsCommand: command,
        });
        await writeTranscript(harness, SESSION, [
            assistantToolUse({ sessionId: SESSION, toolUseId: "toolu_1", ts: afterInstall(0) }),
            hookSuccessAttachment({
                sessionId: SESSION,
                toolUseId: "toolu_1",
                ts: afterInstall(200),
                command,
                hookEvent: "PostToolUse",
                stdout: '{"hookSpecificOutput":{"additionalContext":"noted"}}',
            }),
            failingToolResult({
                sessionId: SESSION,
                toolUseId: "toolu_1",
                ts: afterInstall(500),
                text: "error: pathspec did not match",
            }),
        ]);

        const { rows } = await ingestAndDerive(harness);
        expect(rows.map((r) => r.was_addressed)).toEqual([false]);
    });

    dtest("progress-only and no-op records are not interventions", async () => {
        const harness = makeHarness("ax-opp-identity-effect-");
        const progressCommand = "bun ~/.ax/hooks/guard.ts # ax:74da7418";
        await installHookExperiment(harness, {
            sig: "74da7418",
            eventName: "PreToolUse",
            settingsCommand: progressCommand,
        });
        await writeTranscript(harness, SESSION, [
            assistantToolUse({ sessionId: SESSION, toolUseId: "toolu_1", ts: afterInstall(0) }),
            hookProgressLine({
                sessionId: SESSION,
                toolUseId: "toolu_1",
                ts: afterInstall(100),
                command: progressCommand,
            }),
            hookSuccessAttachment({
                sessionId: SESSION,
                toolUseId: "toolu_1",
                ts: afterInstall(200),
                command: `${progressCommand} --quiet`,
                hookEvent: "PreToolUse",
                stdout: "",
            }),
            failingToolResult({
                sessionId: SESSION,
                toolUseId: "toolu_1",
                ts: afterInstall(500),
                text: "error: pathspec did not match",
            }),
        ]);

        const { rows } = await ingestAndDerive(harness);
        expect(rows.map((r) => r.was_addressed)).toEqual([false]);
    });

    dtest("an uninstalled hook has unavailable evidence, not zero addressed", async () => {
        const harness = makeHarness("ax-opp-identity-uninstalled-");
        const command = "bun ~/.ax/hooks/guard.ts # ax:74da7418";
        await installHookExperiment(harness, {
            sig: "74da7418",
            eventName: "PreToolUse",
            settingsCommand: command,
            install: false,
        });
        await writeTranscript(harness, SESSION, [
            assistantToolUse({ sessionId: SESSION, toolUseId: "toolu_1", ts: afterInstall(0) }),
            failingToolResult({
                sessionId: SESSION,
                toolUseId: "toolu_1",
                ts: afterInstall(500),
                text: `PreToolUse:Bash hook error: [${command}]: BLOCKED`,
            }),
        ]);

        const { stats, rows } = await ingestAndDerive(harness);
        expect(stats.artifactUnavailable).toBe(1);
        expect(stats.byHookForm).toBe(0);
        expect(rows).toEqual([]);
    });
});

/** Seed an open guidance proposal, accept it, install the marker in the given
 *  file, and let `improve lint` record the file it actually found. Returns the
 *  experiment key the derived rows are keyed by. */
const installGuidanceExperiment = async (harness: Harness, opts: {
    readonly sig: string;
    readonly guidancePath: string;
    readonly install?: boolean;
}): Promise<string> => {
    const accepted = await harness.judgment(Effect.gen(function* () {
        const judgment = yield* Judgment;
        const now = new Date();
        yield* judgment.put("proposal", {
            id: `proposal-${opts.sig}`, form: "guidance", title: "Use rg",
            hypothesis: "grep is slow", dedupe_sig: opts.sig, frequency: 2, confidence: "high",
            status: "open", origin: "agent", hypothesis_template: null, evidence_query: null,
            reject_reason: null, baseline: null, created_at: now, updated_at: now,
        });
        yield* judgment.put("guidance_proposal", {
            id: `guidance-${opts.sig}`, proposal: `proposal-${opts.sig}`,
            // A BARE basename on purpose: the old detector expanded this to
            // `~/.claude/CLAUDE.md` and measured a file it never installed.
            file_target: "CLAUDE.md", section: "tools", suggested_text: "Use rg.",
        });
        return yield* acceptProposal({ sigOrId: opts.sig, taskDir: join(harness.root, "tasks") });
    }));
    const experimentKey = (accepted.experiment_id ?? "").replace(/^experiment:/, "");
    expect(experimentKey).not.toBe("");
    if (opts.install === false) return experimentKey;
    await Bun.write(opts.guidancePath, `<!--ax:${opts.sig}-->Use rg.<!--/ax:${opts.sig}-->\n`);
    const lint = await harness.judgment(lintFiles({ roots: [join(opts.guidancePath, "..")] }));
    expect(lint.reconciled).toHaveLength(1);
    return experimentKey;
};

const correctionRow = (id: string, ts: Date) => ({
    id,
    session: SESSION,
    turn: null,
    kind: "correction",
    text: "no, use rg",
    labels: null,
    metrics: null,
    raw: null,
    ts,
});

describe("guidance form: observed artifact path", () => {
    dtest("only the recorded file supplies evidence, even when two experiments name CLAUDE.md", async () => {
        const harness = makeHarness("ax-opp-identity-guidance-");
        const touchedDir = join(harness.root, "touched");
        const untouchedDir = join(harness.root, "untouched");
        await mkdir(touchedDir, { recursive: true });
        await mkdir(untouchedDir, { recursive: true });
        const touched = join(touchedDir, "CLAUDE.md");
        const untouched = join(untouchedDir, "CLAUDE.md");
        const touchedKey = await installGuidanceExperiment(harness, { sig: "use-rg-touched", guidancePath: touched });
        await installGuidanceExperiment(harness, { sig: "use-rg-untouched", guidancePath: untouched });

        // One correction after both installs; the two recorded files differ only
        // in mtime, so the addressed flag can come from nothing but the path.
        const correctionAt = new Date(Date.now() + 60_000);
        await utimes(touched, new Date(correctionAt.getTime() + 60_000), new Date(correctionAt.getTime() + 60_000));
        await utimes(untouched, new Date(correctionAt.getTime() - 3_600_000), new Date(correctionAt.getTime() - 3_600_000));

        const { stats, rows } = await ingestAndDerive(harness, (write) =>
            write.putMany("friction_event", [correctionRow("friction-1", correctionAt)]));

        expect(stats.byGuidanceForm).toBe(2);
        expect(stats.artifactUnavailable).toBe(0);
        expect(rows).toHaveLength(2);
        expect(rows.filter((r) => r.was_addressed).map((r) => r.in_id)).toEqual([touchedKey]);
        expect(rows.every((r) => r.out_table === "friction_event")).toBe(true);
    });

    dtest("an unreconciled guidance experiment reports unavailable evidence", async () => {
        const harness = makeHarness("ax-opp-identity-guidance-absent-");
        await installGuidanceExperiment(harness, {
            sig: "use-rg",
            guidancePath: join(harness.root, "CLAUDE.md"),
            install: false,
        });

        const { stats, rows } = await ingestAndDerive(harness, (write) =>
            write.putMany("friction_event", [correctionRow("friction-1", new Date(Date.now() + 60_000))]));

        // No recorded artifact - and emphatically NOT a fall back to a global
        // CLAUDE.md that happens to share the proposal's basename.
        expect(stats.artifactUnavailable).toBe(1);
        expect(stats.byGuidanceForm).toBe(0);
        expect(rows).toEqual([]);
    });
});

describe("stale opportunity rows", () => {
    dtest("re-derive rebuilds this experiment's rows and leaves others alone", async () => {
        const harness = makeHarness("ax-opp-identity-stale-");
        const guidancePath = join(harness.root, "CLAUDE.md");
        const experimentKey = await installGuidanceExperiment(harness, { sig: "use-rg", guidancePath });
        const correctionAt = new Date(Date.now() + 60_000);
        await utimes(guidancePath, correctionAt, correctionAt);

        const { rows } = await ingestAndDerive(harness, (write) =>
            Effect.gen(function* () {
                yield* write.putMany("friction_event", [correctionRow("friction-1", correctionAt)]);
                // A row the OLD matching rules produced, for evidence that no
                // longer matches, plus one belonging to a different experiment.
                yield* write.putMany("opportunity", [
                    {
                        id: "stale-row", in_id: experimentKey, out_id: "friction-gone",
                        out_table: "friction_event", matched_at: correctionAt, was_addressed: true,
                    },
                    {
                        id: "unrelated-row", in_id: "experiment-elsewhere", out_id: "friction-other",
                        out_table: "friction_event", matched_at: correctionAt, was_addressed: true,
                    },
                ]);
            }));

        expect(rows.some((r) => r.out_id === "friction-gone")).toBe(false);
        expect(rows).toContainEqual({
            in_id: "experiment-elsewhere", out_id: "friction-other",
            out_table: "friction_event", was_addressed: true,
        });
        expect(rows.some((r) => r.in_id === experimentKey && r.out_id === "friction-1")).toBe(true);
    });
});
