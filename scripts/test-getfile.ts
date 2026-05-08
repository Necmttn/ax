import { Effect } from "effect";
import { SurrealClient } from "../src/lib/db.ts";
import { AppLayer } from "../src/lib/layers.ts";

const program = Effect.gen(function* () {
    const db = yield* SurrealClient;
    const sessionId = process.argv[2] ?? "8a53d7e0-69b9-4b51-8828-7fdccfaf4899";
    const bucket = process.argv[3] ?? "transcripts";
    const content = yield* db.getFile(bucket, `${sessionId}.jsonl`);
    console.log(`bucket=${bucket} session=${sessionId} bytes=${content.length}`);
    console.log("--- first 300 chars ---");
    console.log(content.slice(0, 300));
});

await Effect.runPromise(
    program.pipe(Effect.provide(AppLayer), Effect.scoped) as Effect.Effect<void>,
);
