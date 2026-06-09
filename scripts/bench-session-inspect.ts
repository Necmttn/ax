import { Effect } from "effect";
import { AppLayer } from "@ax/lib/layers";
import { fetchSessionInspect } from "../apps/axctl/src/dashboard/session-inspect.ts";

const sessionId = process.argv[2];
if (!sessionId) {
    console.error("usage: bun scripts/bench-session-inspect.ts <session-id> [turn-offset] [turn-limit]");
    process.exit(2);
}

const turnOffset = Number(process.argv[3] ?? "0");
const turnLimit = Number(process.argv[4] ?? "100");

const started = performance.now();
const payload = await Effect.runPromise(
    fetchSessionInspect(sessionId, {
        turnOffset: Number.isFinite(turnOffset) ? turnOffset : 0,
        turnLimit: Number.isFinite(turnLimit) ? turnLimit : 100,
    }).pipe(Effect.provide(AppLayer), Effect.scoped),
);

console.log(JSON.stringify({
    session_id: payload.session_id,
    elapsed_ms: Math.round(performance.now() - started),
    total_turns: payload.total_turns,
    returned_turns: payload.turns.length,
    turn_window: payload.turn_window,
    content_blocks: payload.turns.reduce((n, turn) => n + (turn.content?.blocks.length ?? 0), 0),
    content_atoms: payload.turns.reduce(
        (n, turn) => n + (turn.content?.blocks.reduce((m, block) => m + block.atoms.length, 0) ?? 0),
        0,
    ),
}, null, 2));
