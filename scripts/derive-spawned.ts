#!/usr/bin/env bun
import { Effect } from "effect";
import { LegacySurrealAppLayer } from "@ax/lib/layers";
import { deriveSpawned } from "../apps/axctl/src/ingest/derive-spawned.ts";

async function main(): Promise<void> {
    const stats = await Effect.runPromise(
        deriveSpawned().pipe(Effect.provide(LegacySurrealAppLayer), Effect.scoped),
    );
    console.log("[derive-spawned]", stats);
}

void main();
