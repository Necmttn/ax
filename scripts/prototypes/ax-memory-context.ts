#!/usr/bin/env bun
// PROTOTYPE - throwaway terminal shell for ax memory/context usefulness.
// Question: using real local transcript data read-only, do inferred memories
// and evidence-backed context blocks feel useful enough to productize?

import { Surreal } from "surrealdb";
import { createInterface } from "node:readline/promises";
import { writeFile } from "node:fs/promises";
import { stdin as input, stdout as output } from "node:process";
import {
    decideMemories,
    renderContextBlock,
    scoreTurns,
    type SessionEvidence,
    type TaskTurn,
} from "./ax-memory-context-logic.ts";

const cfg = {
    url: process.env.AX_DB_URL ?? process.env.AGENTCTL_DB_URL ?? "ws://127.0.0.1:8521",
    ns: process.env.AX_DB_NS ?? process.env.AGENTCTL_DB_NS ?? "ax",
    db: process.env.AX_DB_DB ?? process.env.AGENTCTL_DB_DB ?? "main",
    user: process.env.AX_DB_USER ?? process.env.AGENTCTL_DB_USER ?? "root",
    pass: process.env.AX_DB_PASS ?? process.env.AGENTCTL_DB_PASS ?? "root",
};

const htmlArgIndex = process.argv.findIndex((arg) => arg === "--html" || arg.startsWith("--html="));
const htmlPath =
    htmlArgIndex === -1
        ? null
        : process.argv[htmlArgIndex]?.startsWith("--html=")
          ? process.argv[htmlArgIndex].slice("--html=".length)
          : (process.argv[htmlArgIndex + 1] ?? "scripts/prototypes/ax-memory-context-preview.html");
const runStartedAt = new Date().toISOString();

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const clear = () => output.write("\x1b[2J\x1b[H");
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

interface State {
    query: string;
    cwd: string;
    turnsLoaded: number;
    matches: ReturnType<typeof scoreTurns>;
    decisions: ReturnType<typeof decideMemories>;
    sessions: SessionEvidence[];
}

async function connect(): Promise<Surreal> {
    const db = new Surreal();
    await db.connect(cfg.url);
    await db.signin({ username: cfg.user, password: cfg.pass });
    await db.use({ namespace: cfg.ns, database: cfg.db });
    return db;
}

async function loadTaskTurns(db: Surreal): Promise<TaskTurn[]> {
    const [rows] = await db.query<[TaskTurn[]]>(`
        SELECT
            <string>id AS id,
            <string>session AS session,
            seq,
            <string>ts AS ts,
            session.source AS source,
            session.cwd AS cwd,
            intent_kind,
            text,
            text_excerpt
        FROM turn
        WHERE message_kind = "task"
          AND text IS NOT NONE
          AND ts < d"${runStartedAt}"
        ORDER BY ts DESC
        LIMIT 5000;
    `);
    return rows.filter((row) => {
        if (typeof row.text !== "string" || row.text.trim().length === 0) return false;
        if (row.source === "claude-subagent") return false;
        const text = row.text.trim();
        if (text.startsWith("<task>")) return false;
        if (text.startsWith("<task-notification>")) return false;
        if (text.startsWith("<subagent_notification>")) return false;
        if (text.startsWith("This session is being continued from a previous conversation")) return false;
        if (text.startsWith("Implementer subagent in SDD workflow")) return false;
        if (text.startsWith("You are dogfooding `agentctl`")) return false;
        if (text.startsWith("You are reconnoitering")) return false;
        if (/dogfood v2|dogfood run complete|prompts tested/i.test(text)) return false;
        return true;
    });
}

async function loadSessionEvidence(db: Surreal, sessions: readonly string[]): Promise<SessionEvidence[]> {
    const unique = Array.from(new Set(sessions)).slice(0, 8);
    if (unique.length === 0) return [];
    const [rows] = await db.query<[SessionEvidence[]]>(`
        SELECT
            <string>id AS id,
            source,
            cwd,
            ->produced.out.{
                sha,
                message,
                touched: ->touched.out.{ path }
            } AS commits
        FROM session
        WHERE id IN [${unique.join(", ")}];
    `);
    return rows;
}

async function evaluate(db: Surreal, query: string, turns: readonly TaskTurn[]): Promise<State> {
    const cwd = process.cwd();
    const matches = scoreTurns(query, turns, cwd);
    const decisions = decideMemories(query, matches);
    const evidenceSessions = decisions.flatMap((decision) => decision.evidenceTurns.map((turn) => turn.session));
    const sessions = await loadSessionEvidence(db, evidenceSessions);
    return { query, cwd, turnsLoaded: turns.length, matches, decisions, sessions };
}

const escapeHtml = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function renderAiBlock(state: State): string {
    const injected = state.decisions.filter((decision) => decision.status === "inject");
    if (injected.length === 0) {
        return "<ax_memory>\nNo active memory matched above threshold.\n</ax_memory>";
    }
    return [
        "<ax_memory>",
        ...injected.map((decision) => {
            const evidence = decision.evidenceTurns.length;
            const sessions = new Set(decision.evidenceTurns.map((turn) => turn.session)).size;
            return `- ${decision.guidance}\n  Evidence: ${evidence} turns across ${sessions} sessions. Confidence: ${decision.confidence.toFixed(2)}.`;
        }),
        "</ax_memory>",
    ].join("\n");
}

async function writeHtmlPreview(state: State) {
    if (!htmlPath) return;
    const aiBlock = renderAiBlock(state);
    const decisions = state.decisions
        .map(
            (decision) => `
                <tr>
                    <td><span class="pill ${decision.status}">${decision.status.toUpperCase()}</span></td>
                    <td>${escapeHtml(decision.title)}</td>
                    <td>${decision.confidence.toFixed(2)}</td>
                    <td>${escapeHtml(decision.why.join("; "))}</td>
                    <td>${escapeHtml(decision.rejectedBecause.join("; ") || "-")}</td>
                </tr>`,
        )
        .join("");
    const evidence = state.matches
        .slice(0, 12)
        .map(
            (match) => `
                <li>
                    <div><strong>${match.score}</strong> <span class="muted">${escapeHtml(match.intentKind)} ${escapeHtml(match.source ?? "?")} ${escapeHtml(match.ts)}</span></div>
                    <div>${escapeHtml(clip(match.text.replace(/\s+/g, " "), 220))}</div>
                    <div class="muted">${escapeHtml(match.why.join(" | "))}</div>
                </li>`,
        )
        .join("");
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Ax Memory Context Preview</title>
  <style>
    body { margin: 0; font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #171717; background: #f6f5f2; }
    main { max-width: 1120px; margin: 0 auto; padding: 32px; }
    h1, h2 { margin: 0 0 12px; letter-spacing: 0; }
    h1 { font-size: 28px; }
    h2 { font-size: 18px; margin-top: 28px; }
    .meta { color: #666; margin-bottom: 20px; }
    .grid { display: grid; grid-template-columns: 1.05fr 1fr; gap: 18px; align-items: start; }
    section { background: #fff; border: 1px solid #d8d4ca; border-radius: 8px; padding: 18px; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; background: #111; color: #f6f1e8; padding: 16px; border-radius: 6px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; vertical-align: top; border-bottom: 1px solid #e4e0d7; padding: 8px; }
    th { font-size: 12px; text-transform: uppercase; color: #666; }
    .pill { display: inline-block; min-width: 58px; padding: 2px 6px; border-radius: 999px; font-size: 11px; font-weight: 700; text-align: center; }
    .inject { background: #dff3df; color: #176129; }
    .reject { background: #f4dfdd; color: #7a231d; }
    .muted { color: #6d6a63; font-size: 12px; }
    li { margin: 0 0 12px; }
    @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } main { padding: 18px; } }
  </style>
</head>
<body>
  <main>
    <h1>Ax Memory Context Preview</h1>
    <div class="meta">Task: ${escapeHtml(state.query)}<br>CWD: ${escapeHtml(state.cwd)}<br>Scanned ${state.turnsLoaded} turns. Generated ${new Date().toISOString()}.</div>
    <div class="grid">
      <section>
        <h2>What The AI Sees</h2>
        <pre>${escapeHtml(aiBlock)}</pre>
      </section>
      <section>
        <h2>Decision Debug</h2>
        <table>
          <thead><tr><th>Status</th><th>Memory</th><th>Conf</th><th>Why</th><th>Rejected Because</th></tr></thead>
          <tbody>${decisions}</tbody>
        </table>
      </section>
    </div>
    <section>
      <h2>Top Matched Turns</h2>
      <ol>${evidence}</ol>
    </section>
  </main>
</body>
</html>`;
    await writeFile(htmlPath, html);
}

function render(state: State | null, loading = false) {
    clear();
    console.log(bold("ax memory context prototype"));
    console.log(dim("Throwaway, read-only over local SurrealDB. No memory rows are written."));
    console.log("");

    if (loading) {
        console.log("Loading real task turns...");
        return;
    }

    if (!state) {
        console.log("Enter a task to see candidate memories and evidence.");
    } else {
        console.log(`${bold("Task")} ${state.query}`);
        console.log(`${bold("CWD")}  ${state.cwd}`);
        console.log(`${bold("Rows")} ${state.turnsLoaded} task turns scanned, ${state.matches.length} matches`);
        console.log("");

        console.log(bold("Memory decisions"));
        for (const [i, decision] of state.decisions.entries()) {
            const status = decision.status === "inject" ? "INJECT" : "REJECT";
            console.log(`${i + 1}. ${status} ${decision.title} ${dim(`confidence ${decision.confidence.toFixed(2)}`)}`);
            console.log(`   ${decision.guidance}`);
            console.log(`   ${dim(decision.why.join(", "))}`);
            if (decision.rejectedBecause.length > 0) {
                console.log(`   ${dim(`rejected: ${decision.rejectedBecause.join("; ")}`)}`);
            }
        }

        console.log("");
        console.log(bold("Top matched turns"));
        for (const [i, match] of state.matches.slice(0, 8).entries()) {
            console.log(`${i + 1}. score ${match.score} ${dim(`${match.intentKind} ${match.source ?? "?"} ${match.ts} ${match.session}`)}`);
            console.log(`   ${clip(match.text.replace(/\s+/g, " "), 170)}`);
            console.log(`   ${dim(match.why.join(" | "))}`);
        }

        const contextBlock = renderContextBlock(state.decisions, state.sessions);
        console.log("");
        console.log(bold("Context block preview"));
        console.log(contextBlock);
        if (htmlPath) {
            console.log("");
            console.log(`${bold("HTML preview")} ${htmlPath}`);
        }
    }

    console.log("");
    console.log(`${bold("Commands")} enter new task  ${bold("/r")} rerun  ${bold("/q")} quit`);
}

async function main() {
    render(null, true);
    const db = await connect();
    const turns = await loadTaskTurns(db);
    let lastQuery = "change transcript ingest to store user messages and graph references";
    let state: State | null = await evaluate(db, lastQuery, turns);
    await writeHtmlPreview(state);
    render(state);

    if (!input.isTTY) {
        const chunks: Buffer[] = [];
        for await (const chunk of input) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const lines = Buffer.concat(chunks)
            .toString("utf8")
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0 && line !== "/q");
        for (const line of lines) {
            lastQuery = line === "/r" ? lastQuery : line;
            state = await evaluate(db, lastQuery, turns);
            await writeHtmlPreview(state);
            render(state);
        }
        await db.close();
        return;
    }

    const rl = createInterface({ input, output });
    while (true) {
        let rawAnswer: string;
        try {
            rawAnswer = await rl.question("\nprototype> ");
        } catch (err) {
            if (err && typeof err === "object" && "code" in err && err.code === "ERR_USE_AFTER_CLOSE") break;
            throw err;
        }
        const answer = rawAnswer.trim();
        if (answer === "/q") break;
        if (answer === "/r" || answer.length === 0) {
            state = await evaluate(db, lastQuery, turns);
        } else {
            lastQuery = answer;
            state = await evaluate(db, lastQuery, turns);
        }
        await writeHtmlPreview(state);
        render(state);
    }
    rl.close();
    await db.close();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
