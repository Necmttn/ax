import { describe, expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { ingestAdviceLog } from "./advice-stage.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("advice stage", { requireFts: true });

const ledgerRow = (sessionId: string, ts: string): string =>
  JSON.stringify({
    ts,
    session_id: sessionId,
    tool: "Agent",
    description: `dispatch ${sessionId}`,
    injected: null,
    verdict: "allow",
  }) + "\n";

describe("advice stage", () => {
  dtest("returns zero when the ledger directory does not exist", async () => {
    const home = tempDir("ax-advice-missing-");
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    let rows = -1;
    try {
      await runWithPlatform(
        publishCacheFixture(tempDir("ax-advice-empty-cache-"), dylibPath, (write) =>
          Effect.gen(function* () {
            rows = yield* ingestAdviceLog(write, new Date(0));
          }),
        ),
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
    expect(rows).toBe(0);
  });

  dtest("ingests rotated segments once and keeps one watermark per file", async () => {
    const home = tempDir("ax-advice-home-");
    const hooksDir = join(home, ".ax", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    const segment = join(hooksDir, "advise-log.2026-08-20T00-00-00-000Z-123.jsonl");
    const live = join(hooksDir, "advise-log.jsonl");
    writeFileSync(segment, ledgerRow("segment-session", "2026-08-20T00:00:00.000Z"));
    writeFileSync(live, ledgerRow("live-session", "2026-08-21T00:00:00.000Z"));

    const previousHome = process.env.HOME;
    process.env.HOME = home;
    let first = -1;
    let second = -1;
    let adviceRows = -1;
    let markPaths: string[] = [];
    try {
      await runWithPlatform(
        publishCacheFixture(tempDir("ax-advice-cache-"), dylibPath, (write) =>
          Effect.gen(function* () {
            first = yield* ingestAdviceLog(write, new Date(0));
            second = yield* ingestAdviceLog(write, new Date(0));
            adviceRows = (yield* write.rows(
              Schema.Struct({ count: Schema.Number }),
              "SELECT count(*)::INTEGER AS count FROM advice",
            ))[0]!.count;
            markPaths = (yield* write.rows(
              Schema.Struct({ path: Schema.String }),
              "SELECT path FROM ingest_file_state WHERE source_kind = 'advice_log' ORDER BY path",
            )).map((row) => row.path).filter((path) => !path.startsWith("__"));
          }),
        ),
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }

    expect({ first, second, adviceRows }).toEqual({ first: 2, second: 0, adviceRows: 2 });
    expect(new Set(markPaths)).toEqual(new Set([segment, live]));
  });
});
