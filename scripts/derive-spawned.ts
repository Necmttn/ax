#!/usr/bin/env bun
import { Effect } from "effect";
import { AppLayer } from "@ax/lib/layers";
import { deriveSpawned } from "../src/ingest/derive-spawned.ts";

async function main(): Promise<void> {
    const stats = await Effect.runPromise(
        deriveSpawned().pipe(Effect.provide(AppLayer), Effect.scoped),
    );
    console.log("[derive-spawned]", stats);
}

void main();
