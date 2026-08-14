#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const JOIN_DRILL_SESSION = "session:`claude-subagent-af3f3b45c70ccf85c`";
export const TURN_ROWS = 5000;
export const TOOL_CALL_ROWS = 4000;
export const SESSION_ROWS = 200;
export const COMMIT_ROWS = 150;
export const SKILL_ROWS = 40;
export const INVOKED_ROWS = 400;
export const SPAWNED_ROWS = 80;
export const TELEMETRY_ROWS = 60;

const iso = (i: number): string =>
    new Date(Date.UTC(2026, 0, 1, 0, 0, i % 86_400)).toISOString();

const sessionId = (i: number): string =>
    i === 0 ? JOIN_DRILL_SESSION : `session:s${String(i).padStart(4, "0")}`;

const skillId = (i: number): string => `skill:sk${String(i).padStart(3, "0")}`;

const writeJsonl = (dir: string, name: string, rows: unknown[]): void => {
    writeFileSync(
        join(dir, name),
        `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
        "utf8",
    );
};

export const writeMiniFixture = (
    dir: string,
): { turnRows: number; bytes: number } => {
    mkdirSync(dir, { recursive: true });

    const sessions = Array.from({ length: SESSION_ROWS }, (_, i) => ({
        id: sessionId(i),
        source: i % 5 === 0 ? "claude-subagent" : "claude",
        project: i % 3 === 0 ? "ax" : "other",
        model: i % 2 === 0 ? "opus" : "sonnet",
        started_at: iso(i * 60),
        ended_at: iso(i * 60 + 30),
    }));

    const turns = Array.from({ length: TURN_ROWS }, (_, i) => ({
        id: `turn:t${String(i).padStart(5, "0")}`,
        session: i < 54 ? JOIN_DRILL_SESSION : sessionId(1 + (i % (SESSION_ROWS - 1))),
        ts: iso(i),
        role: i % 3 === 0 ? "user" : "assistant",
        text_excerpt:
            i % 40 === 0
                ? "ingest pipeline load FTS snapshot query"
                : `synthetic turn ${i} about routing and cost`,
    }));

    const toolCalls = Array.from({ length: TOOL_CALL_ROWS }, (_, i) => ({
        id: `tool_call:tc${String(i).padStart(5, "0")}`,
        session: sessionId(i % SESSION_ROWS),
        ts: iso(i + 1),
        name: i % 4 === 0 ? "Bash" : i % 4 === 1 ? "Read" : i % 4 === 2 ? "Edit" : "Grep",
        status: i % 17 === 0 ? "error" : "success",
    }));

    const commits = Array.from({ length: COMMIT_ROWS }, (_, i) => ({
        id: `commit:c${String(i).padStart(4, "0")}`,
        sha: `sha${String(i).padStart(8, "0")}deadbeef`,
        message: i % 11 === 0 ? "ingest pipeline timing" : `commit message ${i}`,
        ts: iso(i * 120),
        repo: "Necmttn/ax",
    }));

    const skills = Array.from({ length: SKILL_ROWS }, (_, i) => ({
        id: skillId(i),
        name: `skill-${i}`,
        dir_path: `~/.claude/skills/skill-${i}`,
        scope: i % 2 === 0 ? "user" : "project",
    }));

    const invoked = Array.from({ length: INVOKED_ROWS }, (_, i) => ({
        turn_id: `turn:t${String(i % TURN_ROWS).padStart(5, "0")}`,
        skill_id: skillId(i % SKILL_ROWS),
        session: sessionId(i % SESSION_ROWS),
        ts: iso(i + 3),
    }));

    const spawned = Array.from({ length: SPAWNED_ROWS }, (_, i) => ({
        parent_session: sessionId(i % SESSION_ROWS),
        child_session: sessionId((i + 1) % SESSION_ROWS),
        ts: iso(i * 15),
        agent_type: i % 2 === 0 ? "Explore" : "general-purpose",
        description: `dispatch ${i}`,
    }));

    const telemetry = Array.from({ length: TELEMETRY_ROWS }, (_, i) => ({
        session_id: sessionId(i % SESSION_ROWS),
        otel_id: `otel:o${String(i).padStart(4, "0")}`,
        linked_at: iso(i * 9),
    }));

    writeJsonl(dir, "session.jsonl", sessions);
    writeJsonl(dir, "turn.jsonl", turns);
    writeJsonl(dir, "tool_call.jsonl", toolCalls);
    writeJsonl(dir, "commit.jsonl", commits);
    writeJsonl(dir, "skill.jsonl", skills);
    writeJsonl(dir, "invoked.jsonl", invoked);
    writeJsonl(dir, "spawned.jsonl", spawned);
    writeJsonl(dir, "telemetry_of.jsonl", telemetry);

    const bytes = [
        "session.jsonl",
        "turn.jsonl",
        "tool_call.jsonl",
        "commit.jsonl",
        "skill.jsonl",
        "invoked.jsonl",
        "spawned.jsonl",
        "telemetry_of.jsonl",
    ].reduce((sum, name) => sum + Bun.file(join(dir, name)).size, 0);

    return { turnRows: TURN_ROWS, bytes };
};

if (import.meta.main) {
    const out = process.argv[2] ?? ".bench-fixture";
    const result = writeMiniFixture(out);
    console.log(
        `wrote ${result.turnRows} turns (${result.bytes} bytes) -> ${out}`,
    );
}
