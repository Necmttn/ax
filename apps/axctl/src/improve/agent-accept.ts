/**
 * Subagent-driven enrichment for `axctl improve accept --with-agent`.
 *
 * The base scaffold (skill-scaffold.ts) writes a SKILL.md stub from the
 * proposal's hypothesis + proposed_behavior. That stub is honest but
 * skeletal: it doesn't read related skills, doesn't know about your
 * conventions, and doesn't translate the trigger into concrete steps.
 *
 * `--with-agent` opt-in: after the stub lands and the experiment row is
 * UPSERTed, spawn a one-shot `claude -p` subagent with `bypassPermissions`
 * so it can read the stub, look at sibling skills, and REWRITE the file
 * with real content. Optionally writes a PLAN.md alongside.
 *
 * Schema-untouched: the agent writes to `experiment.artifact_path`'s
 * directory; the PLAN.md path is not tracked in DB this round. We detect
 * "agent did work" via mtime delta + sibling existence after the spawn.
 *
 * Streaming, not buffered: the user wants to watch the subagent in their
 * terminal, so stdout from the child is forwarded line-by-line to the
 * parent's stdout in real time. We still capture into a buffer for the
 * AgentAcceptResult shape so callers can inspect after the fact.
 */

import { Effect, FileSystem, Option, type PlatformError } from "effect";
import { orAbsent } from "@ax/lib/shared/fs-error";
import { posixPath } from "@ax/lib/shared/path";

export interface AgentAcceptContext {
    readonly skillPath: string;
    readonly proposalTitle: string;
    readonly hypothesis: string;
    readonly triggerPattern: string;
    readonly proposedBehavior: string;
    readonly retroSummaries: readonly string[];
    readonly relatedSkillsDir: string;
}

export interface AgentAcceptResult {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly skillEnriched: boolean;
    readonly planWritten: boolean;
    readonly planPath: string | null;
}

export const buildAgentAcceptPrompt = (ctx: AgentAcceptContext): string => {
    const retrosBlock = ctx.retroSummaries.length === 0
        ? "(no recent retros captured)"
        : ctx.retroSummaries.map((s) => `  - ${s}`).join("\n");
    const planPath = posixPath.join(posixPath.dirname(ctx.skillPath), "PLAN.md");
    return [
        "You are improving a skill stub for the `ax` agent-experience graph.",
        "",
        `Stub file: ${ctx.skillPath}`,
        `Sibling skills directory: ${ctx.relatedSkillsDir}`,
        `Optional sibling plan: ${planPath}`,
        "",
        `Proposal title: ${ctx.proposalTitle}`,
        `Hypothesis: ${ctx.hypothesis}`,
        `Trigger pattern: ${ctx.triggerPattern}`,
        `Proposed behavior: ${ctx.proposedBehavior}`,
        "",
        "Recent retros that motivated this proposal:",
        retrosBlock,
        "",
        "Task:",
        `1. Read ${ctx.skillPath} (it has placeholders).`,
        `2. Skim ${ctx.relatedSkillsDir} for naming + structure conventions.`,
        `3. REWRITE ${ctx.skillPath} with concrete actionable guidance:`,
        "   - when this skill should fire (precise triggers)",
        "   - exact steps the agent should follow",
        "   - anti-patterns to avoid",
        `4. Optionally write ${planPath} with a 3-bullet experimentation plan`,
        "   (what to measure, success criterion, kill criterion).",
        "",
        "Use the Write/Edit tools. Do not exit until the SKILL.md is saved.",
        "Be concise: under 200 lines for SKILL.md, under 30 lines for PLAN.md.",
    ].join("\n");
};

// existsSync+statSync().mtimeMs in try/catch→null: a missing file or any stat
// fault yields null (orAbsent(none) collapses both; an absent mtime → null too).
const safeMtime = (
    path: string,
): Effect.Effect<number | null, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const info = yield* fs.stat(path).pipe(Effect.asSome, orAbsent(Option.none()));
        if (Option.isNone(info)) return null;
        return Option.match(info.value.mtime, {
            onNone: () => null,
            onSome: (d) => d.getTime(),
        });
    });

const fileExists = (
    path: string,
): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.exists(path).pipe(orAbsent(false));
    });

// Spawn the subagent and stream its output. The Bun.spawn lifecycle stays in a
// single async closure wrapped by Effect.promise (it never throws a typed
// error - process failures surface as a non-zero exitCode in the result).
const spawnAgent = async (
    prompt: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
    const cmd = ["claude", "-p", "--permission-mode=bypassPermissions", prompt];
    const child = Bun.spawn(cmd, {
        stdout: "pipe",
        stderr: "pipe",
    });

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    // Stream stdout live to parent stdout so the user watches the subagent
    // work. Tee into a string buffer for the result struct.
    const pumpStdout = (async () => {
        const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            stdoutChunks.push(text);
            await Bun.write(Bun.stdout, value);
        }
    })();

    const pumpStderr = (async () => {
        const reader = (child.stderr as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            stderrChunks.push(text);
            await Bun.write(Bun.stderr, value);
        }
    })();

    await Promise.all([pumpStdout, pumpStderr]);
    const exitCode = await child.exited;
    return { exitCode, stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") };
};

export const runAgentAccept = (
    ctx: AgentAcceptContext,
): Effect.Effect<AgentAcceptResult, PlatformError.PlatformError, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const planPath = posixPath.join(posixPath.dirname(ctx.skillPath), "PLAN.md");
        const prompt = buildAgentAcceptPrompt(ctx);
        const beforeSkillMtime = yield* safeMtime(ctx.skillPath);
        const planExistedBefore = yield* fileExists(planPath);

        const { exitCode, stdout, stderr } = yield* Effect.promise(() => spawnAgent(prompt));

        const afterSkillMtime = yield* safeMtime(ctx.skillPath);
        const skillEnriched =
            afterSkillMtime !== null
            && (beforeSkillMtime === null || afterSkillMtime > beforeSkillMtime);
        const planExistsAfter = yield* fileExists(planPath);
        const planWritten = !planExistedBefore && planExistsAfter;

        return {
            exitCode,
            stdout,
            stderr,
            skillEnriched,
            planWritten,
            planPath: planWritten || planExistsAfter ? planPath : null,
        };
    });
