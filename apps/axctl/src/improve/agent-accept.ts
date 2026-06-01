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

import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

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
    const planPath = join(dirname(ctx.skillPath), "PLAN.md");
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

const safeMtime = (path: string): number | null => {
    try {
        return existsSync(path) ? statSync(path).mtimeMs : null;
    } catch {
        return null;
    }
};

export const runAgentAccept = async (
    ctx: AgentAcceptContext,
): Promise<AgentAcceptResult> => {
    const planPath = join(dirname(ctx.skillPath), "PLAN.md");
    const prompt = buildAgentAcceptPrompt(ctx);
    const beforeSkillMtime = safeMtime(ctx.skillPath);
    const planExistedBefore = existsSync(planPath);

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

    const afterSkillMtime = safeMtime(ctx.skillPath);
    const skillEnriched =
        afterSkillMtime !== null
        && (beforeSkillMtime === null || afterSkillMtime > beforeSkillMtime);
    const planWritten = !planExistedBefore && existsSync(planPath);

    return {
        exitCode,
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        skillEnriched,
        planWritten,
        planPath: planWritten || existsSync(planPath) ? planPath : null,
    };
};
