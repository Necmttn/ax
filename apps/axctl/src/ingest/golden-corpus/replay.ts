/**
 * Replay a committed corpus fixture through the pure parser seam (#876).
 *
 * One function per provider: fixture content in, NormalizedTranscriptBatch
 * out, no store anywhere. The replay test and the harvest tool both go
 * through here, so a golden can only ever be produced by the exact code path
 * the test replays.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testExtractClaudeJsonlLines, toClaudeNormalizedBatch } from "../transcripts.ts";
import { __testExtractCodexJsonlLines, toCodexNormalizedBatch } from "../codex.ts";
import { OMP_PROVIDER, PI_PROVIDER, __testExtractPiJsonlLines, toPiNormalizedBatch } from "../pi.ts";
import { __testToOpenCodeNormalizedBatch, extractOpenCodeDatabase } from "../opencode.ts";
import { __testToCursorNormalizedBatch, extractCursorStateDb } from "../cursor.ts";
import type { NormalizedTranscriptBatch } from "../normalized/transcripts.ts";
import {
    type CursorSeed,
    type OpenCodeSeed,
    materializeCursorSeed,
    materializeOpenCodeSeed,
} from "./materialize.ts";

/** Corpus fixtures live in a fake `/Users/user` home (see README.md). */
export const CLAUDE_FIXTURE_PROJECT_DIR = "-Users-user-Projects-ax";
export const CLAUDE_FIXTURE_SESSION_ID = "7846ccc7-f2f8-425a-8f4c-869c9c7ad8c7";
/** The default the real ingest path uses (`codexPayloadMaxBytes`). */
export const CODEX_FIXTURE_PAYLOAD_MAX_BYTES = 1200;
/** Fixed logical source paths so goldens never embed a temp dir. */
export const OPENCODE_FIXTURE_SOURCE_PATH = "golden-corpus/opencode.db";
export const CURSOR_FIXTURE_SOURCE_PATH = "golden-corpus/state.vscdb";

const jsonlLines = (content: string): string[] => content.split("\n").filter((line) => line.trim().length > 0);

export const replayClaude = (content: string): NormalizedTranscriptBatch => {
    const extracted = __testExtractClaudeJsonlLines(
        jsonlLines(content),
        CLAUDE_FIXTURE_PROJECT_DIR,
        CLAUDE_FIXTURE_SESSION_ID,
    );
    if (extracted === null) throw new Error("golden-corpus: claude fixture extracted to null");
    return toClaudeNormalizedBatch(extracted, extracted.skillRelations, extracted.invocations);
};

export const replayCodex = (content: string): NormalizedTranscriptBatch => {
    const extracted = __testExtractCodexJsonlLines(jsonlLines(content));
    if (extracted === null) throw new Error("golden-corpus: codex fixture extracted to null");
    return toCodexNormalizedBatch(extracted, CODEX_FIXTURE_PAYLOAD_MAX_BYTES);
};

export const replayPi = (content: string): NormalizedTranscriptBatch => {
    const extracted = __testExtractPiJsonlLines(jsonlLines(content), PI_PROVIDER);
    if (extracted === null) throw new Error("golden-corpus: pi fixture extracted to null");
    return toPiNormalizedBatch(extracted, PI_PROVIDER);
};

export const replayOmp = (content: string): NormalizedTranscriptBatch => {
    const extracted = __testExtractPiJsonlLines(jsonlLines(content), OMP_PROVIDER);
    if (extracted === null) throw new Error("golden-corpus: omp fixture extracted to null");
    return toPiNormalizedBatch(extracted, OMP_PROVIDER);
};

const withTempDir = <T>(run: (dir: string) => T): T => {
    const dir = mkdtempSync(join(tmpdir(), "ax-golden-corpus-"));
    try {
        return run(dir);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
};

export const replayOpenCode = (seed: OpenCodeSeed): NormalizedTranscriptBatch =>
    withTempDir((dir) => {
        const dbPath = join(dir, "opencode.db");
        materializeOpenCodeSeed(seed, dbPath);
        return __testToOpenCodeNormalizedBatch(extractOpenCodeDatabase(dbPath), OPENCODE_FIXTURE_SOURCE_PATH);
    });

export const replayCursor = (seed: CursorSeed): NormalizedTranscriptBatch =>
    withTempDir((dir) => {
        // Materialize under a `User/globalStorage` layout and hand the extractor
        // `cursorUserDir`, so the db identity that seeds every row id is the
        // stable relative `globalStorage/state.vscdb` - never the temp dir.
        const userDir = join(dir, "User");
        const dbPath = join(userDir, "globalStorage", "state.vscdb");
        mkdirSync(join(userDir, "globalStorage"), { recursive: true });
        materializeCursorSeed(seed, dbPath);
        return __testToCursorNormalizedBatch(
            extractCursorStateDb(dbPath, { cursorUserDir: userDir }),
            CURSOR_FIXTURE_SOURCE_PATH,
        );
    });
