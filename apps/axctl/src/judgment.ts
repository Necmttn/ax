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
 * written by an ingest stage will be visible to the next statement in that same
 * stage. Ingest is merged now so that the port can land without re-wiring every
 * runtime.
 *
 * WHAT IS PORTED SO FAR - and what is NOT, because the difference is currently
 * visible to a user. `ax skills tag` writes a user's tag here at request time,
 * and the role read surface (`ax roles`, `ax skills roles|by-role`) answers from
 * here. The MINED writer has not moved yet: `ingest/skill-role.ts` still writes
 * frontmatter-sourced tags to SurrealDB through `RELATE ...->plays_role->...`,
 * and never touches this service. Until that stage is ported, frontmatter role
 * tags do not appear in the role read surface. When it lands, both writers will
 * share this one service and see each other's rows - `plays_role` already carries
 * `source` in its natural key so the two can coexist on one skill-role pair.
 */
import { JudgmentLayer, type Judgment } from "@ax/lib/sqlite";
import { SIDECAR_SCHEMA_SQL } from "@ax/schema/sidecar-ddl";
import type { Layer } from "effect";

/** `Judgment` over `~/.ax/judgment.sqlite` (or `AX_SIDECAR_PATH`), with the
 *  committed sidecar DDL applied on open. */
export const JudgmentLive: Layer.Layer<Judgment> = JudgmentLayer({
    schemaSql: SIDECAR_SCHEMA_SQL,
});
