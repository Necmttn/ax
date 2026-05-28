import { Schema } from "effect";

/** Raw transcript or filesystem ingestion. Carries: skills, commands, claude,
 *  codex, git. */
export const IngestTag = Schema.Literal("ingest");
export type IngestTag = typeof IngestTag.Type;

/** Re-derives evidence from already-ingested rows. Carries: signals, outcomes,
 *  session-health, closure, proposals, opportunities, retro-proposals. */
export const DeriveTag = Schema.Literal("derive");
export type DeriveTag = typeof DeriveTag.Type;

/** Retrospective surface (proposal clustering, learning candidates). Carries:
 *  retro-proposals. */
export const RetroTag = Schema.Literal("retro");
export type RetroTag = typeof RetroTag.Type;

/** Harness Doctor / readiness rollup. Carries: harness, session-health. */
export const HealthTag = Schema.Literal("health");
export type HealthTag = typeof HealthTag.Type;

/** Union of all known Ingest Stage tags. Adding a tag = add a literal above +
 *  one entry here. */
export const IngestStageTag = Schema.Union([IngestTag, DeriveTag, RetroTag, HealthTag]);
export type IngestStageTag = typeof IngestStageTag.Type;
