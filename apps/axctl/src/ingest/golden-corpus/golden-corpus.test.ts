/**
 * Golden transcript corpus replay (#876, v3 plan Phase 0).
 *
 * One real (sanitized) transcript per provider, committed under `fixtures/`,
 * replayed through the pure extract -> normalize seam and compared row-for-row
 * against the committed golden batch. This is the parser CONTRACT: any parser
 * change that alters normalized output must show up here as a golden diff.
 *
 * On an INTENTIONAL parser change, regenerate with
 * `bun apps/axctl/src/ingest/golden-corpus/harvest.ts regen` and review the
 * golden diff in the PR - the diff is the point, never bypass it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CursorSeed, OpenCodeSeed } from "./materialize.ts";
import { replayClaude, replayCodex, replayCursor, replayOmp, replayOpenCode, replayPi } from "./replay.ts";
import { projectBatch, stableStringify } from "./serialize.ts";
import type { NormalizedTranscriptBatch } from "../normalized/transcripts.ts";

const ROOT = import.meta.dir;
const readFixture = (name: string): string => readFileSync(join(ROOT, "fixtures", name), "utf8");
const readGolden = (name: string): unknown => JSON.parse(readFileSync(join(ROOT, "golden", name), "utf8"));

interface JsonlCase {
    readonly provider: "claude" | "codex" | "pi" | "omp";
    readonly replay: (content: string) => NormalizedTranscriptBatch;
}

const JSONL_CASES: readonly JsonlCase[] = [
    { provider: "claude", replay: replayClaude },
    { provider: "codex", replay: replayCodex },
    { provider: "pi", replay: replayPi },
    { provider: "omp", replay: replayOmp },
];

describe("golden transcript corpus", () => {
    for (const { provider, replay } of JSONL_CASES) {
        describe(provider, () => {
            const batch = replay(readFixture(`${provider}.jsonl`));

            test("the fixture is not hollow (real transcripts have turns and events)", () => {
                expect(batch.sessions.length).toBeGreaterThanOrEqual(1);
                expect(batch.providers[0]?.name).toBe(provider);
                expect(batch.events.length).toBeGreaterThan(0);
                expect(batch.turns.length).toBeGreaterThan(0);
            });

            test("replays to exactly the committed golden batch", () => {
                expect(projectBatch(batch)).toEqual(readGolden(`${provider}.batch.json`));
            });

            test("replay is deterministic", () => {
                expect(stableStringify(projectBatch(replay(readFixture(`${provider}.jsonl`))))).toBe(
                    stableStringify(projectBatch(batch)),
                );
            });
        });
    }

    describe("opencode", () => {
        const seed = JSON.parse(readFixture("opencode.seed.json")) as OpenCodeSeed;
        const batch = replayOpenCode(seed);

        test("the fixture is not hollow", () => {
            expect(batch.sessions.length).toBeGreaterThanOrEqual(1);
            expect(batch.providers[0]?.name).toBe("opencode");
            expect(batch.turns.length).toBeGreaterThan(0);
            expect(batch.toolCalls.length).toBeGreaterThan(0);
        });

        test("replays to exactly the committed golden batch", () => {
            expect(projectBatch(batch)).toEqual(readGolden("opencode.batch.json"));
        });

        test("replay is deterministic across temp-dir materializations", () => {
            // A second materialization lands in a DIFFERENT temp dir; equality
            // proves no row id or field leaks the materialization path.
            expect(stableStringify(projectBatch(replayOpenCode(seed)))).toBe(
                stableStringify(projectBatch(batch)),
            );
        });
    });

    describe("cursor", () => {
        const seed = JSON.parse(readFixture("cursor.seed.json")) as CursorSeed;
        const batch = replayCursor(seed);

        test("the fixture is not hollow", () => {
            expect(batch.sessions.length).toBeGreaterThanOrEqual(1);
            expect(batch.providers[0]?.name).toBe("cursor");
            expect(batch.turns.length).toBeGreaterThan(0);
        });

        test("replays to exactly the committed golden batch", () => {
            expect(projectBatch(batch)).toEqual(readGolden("cursor.batch.json"));
        });

        test("replay is deterministic across temp-dir materializations", () => {
            expect(stableStringify(projectBatch(replayCursor(seed)))).toBe(
                stableStringify(projectBatch(batch)),
            );
        });
    });

    test("fixtures carry no machine-private home path", () => {
        const home = process.env.HOME ?? "";
        for (const name of ["claude.jsonl", "codex.jsonl", "pi.jsonl", "omp.jsonl", "opencode.seed.json", "cursor.seed.json"]) {
            const content = readFixture(name);
            if (home && home !== "/" && home !== "/Users/user") {
                expect(content.includes(home)).toBe(false);
            }
            expect(content.includes("-----BEGIN")).toBe(false);
        }
    });
});
