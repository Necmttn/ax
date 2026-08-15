// apps/axctl/src/judgment.ts
/**
 * The app's one `Judgment` layer.
 *
 * `@ax/lib`'s `JudgmentLayer` takes the DDL as a REQUIRED option rather than
 * importing it, because `@ax/lib` has no runtime dependency on `@ax/schema` (that
 * is a package cycle - see the note in `@ax/lib/stable-id`). So the wiring has to
 * happen somewhere that depends on both, which is here, ONCE. Every runtime that
 * can reach durable judgment merges this exact layer, so there is never a second
 * spelling of "which schema does the sidecar have".
 *
 * WHY IT IS IN EVERY RUNTIME, INCLUDING INGEST. Unlike `CacheRead`, this service
 * is safe to resolve anywhere. The cache seam has to keep reads and writes apart
 * because a read inside ingest answers from the PREVIOUS run's published snapshot
 * (F1) - the sidecar has no snapshot and no publish step, so a judgment row
 * written by an ingest stage is visible to the next statement in that same stage.
 * `ingest/skill-role.ts` writes mined role tags at ingest; `ax skills tag` writes
 * a user's tag at request time; both go through this one service and see each
 * other's rows.
 */
import { JudgmentLayer, type Judgment } from "@ax/lib/sqlite";
import { SIDECAR_SCHEMA_SQL } from "@ax/schema/sidecar-ddl";
import type { Layer } from "effect";

/** `Judgment` over `~/.ax/judgment.sqlite` (or `AX_SIDECAR_PATH`), with the
 *  committed sidecar DDL applied on open. */
export const JudgmentLive: Layer.Layer<Judgment> = JudgmentLayer({
    schemaSql: SIDECAR_SCHEMA_SQL,
});
