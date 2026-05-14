#!/usr/bin/env bun
import { Effect } from "effect";
import { AppLayer } from "../src/lib/layers.ts";
import { deriveClaudeSubagents } from "../src/ingest/derive-claude-subagents.ts";

async function main(): Promise<void> {
    const stats = await Effect.runPromise(
        deriveClaudeSubagents().pipe(Effect.provide(AppLayer), Effect.scoped),
    );
    console.log("[derive-claude-subagents]", stats);
}

void main();
