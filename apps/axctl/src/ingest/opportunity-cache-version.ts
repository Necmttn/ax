/**
 * The opportunity-derivation version sentinel (#1133 / #1134).
 *
 * One row in the existing `ingest_file_state` bookkeeping table certifies that
 * the PUBLISHED snapshot's `opportunity` rows were produced by the corrected
 * artifact-identity derivation. The opportunities stage invalidates it before it
 * starts replacing rows and stamps it again only after the complete pass
 * succeeds, so a partially-changed cache that gets published carries no success
 * certificate.
 *
 * What it proves is narrow, and worth stating: ALGORITHM COMPATIBILITY, not
 * freshness, not that an artifact worked, not a causal improvement. A checkpoint
 * reader that finds a missing, null, old or unknown token must treat the
 * opportunity rows as needing derivation rather than measuring them.
 *
 * These constants live in their own module so a reader (the checkpoint side owns
 * the read) can have them without importing the whole derive stage.
 */

/** `ingest_file_state.source_kind` for the sentinel. */
export const OPPORTUNITY_VERSION_SOURCE = "opportunity_derivation";

/** `ingest_file_state.path` for the sentinel - globally unique, never a real
 *  file, and deliberately not shared with a transcript or content-hash mark. */
export const OPPORTUNITY_VERSION_PATH = "__opportunity_derivation__";

/** The token stored in `sha`. Bump it when matching semantics change again. */
export const OPPORTUNITY_VERSION = "artifact-identity-v2";
