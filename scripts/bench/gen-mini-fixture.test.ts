import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JOIN_DRILL_SESSION, writeMiniFixture } from "./gen-mini-fixture.ts";

const SCRIPT = join(import.meta.dir, "gen-mini-fixture.ts");

const REQUIRED = [
    "turn.jsonl",
    "tool_call.jsonl",
    "session.jsonl",
    "commit.jsonl",
    "skill.jsonl",
    "invoked.jsonl",
    "spawned.jsonl",
    "telemetry_of.jsonl",
] as const;

const temps: string[] = [];
afterEach(() => {
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
    temps.length = 0;
});

const countLines = (dir: string, file: string): number => {
    const text = readFileSync(join(dir, file), "utf8");
    return text.split("\n").filter((line) => line.length > 0).length;
};

const dirBytes = (dir: string): number =>
    readdirSync(dir).reduce((sum, name) => sum + statSync(join(dir, name)).size, 0);

describe("writeMiniFixture", () => {
    test("writes ~5k turn rows plus proportional tables under 5MB", () => {
        const dir = mkdtempSync(join(tmpdir(), "ax-mini-fx-"));
        temps.push(dir);
        const result = writeMiniFixture(dir);
        expect(result.turnRows).toBeGreaterThanOrEqual(4500);
        expect(result.turnRows).toBeLessThanOrEqual(5500);
        expect(countLines(dir, "turn.jsonl")).toBe(result.turnRows);
        expect(countLines(dir, "tool_call.jsonl")).toBeGreaterThan(1000);
        expect(countLines(dir, "session.jsonl")).toBeGreaterThan(50);
        expect(countLines(dir, "commit.jsonl")).toBeGreaterThan(20);
        expect(countLines(dir, "skill.jsonl")).toBeGreaterThan(10);
        expect(countLines(dir, "invoked.jsonl")).toBeGreaterThan(50);
        expect(countLines(dir, "spawned.jsonl")).toBeGreaterThan(10);
        expect(countLines(dir, "telemetry_of.jsonl")).toBeGreaterThan(10);
        for (const name of REQUIRED) {
            expect(statSync(join(dir, name)).isFile()).toBe(true);
        }
        expect(dirBytes(dir)).toBeLessThan(5 * 1024 * 1024);
    });

    test("includes BM25 query text and the join-drill session id", () => {
        const dir = mkdtempSync(join(tmpdir(), "ax-mini-fx-"));
        temps.push(dir);
        writeMiniFixture(dir);
        const turns = readFileSync(join(dir, "turn.jsonl"), "utf8");
        expect(turns).toContain("ingest pipeline");
        expect(turns).toContain(JOIN_DRILL_SESSION);
        const sessions = readFileSync(join(dir, "session.jsonl"), "utf8");
        expect(sessions).toContain(JOIN_DRILL_SESSION);
    });
});

describe("gen-mini-fixture CLI", () => {
    test("writes the 8 JSONL files into the given directory", () => {
        const dir = mkdtempSync(join(tmpdir(), "ax-mini-cli-"));
        temps.push(dir);
        const proc = spawnSync("bun", [SCRIPT, dir], { encoding: "utf8" });
        expect(proc.status).toBe(0);
        for (const name of REQUIRED) {
            expect(statSync(join(dir, name)).isFile()).toBe(true);
        }
    });
});
