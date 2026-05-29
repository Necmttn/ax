# Skill roles as plays_role relation

**Status:** Accepted (2026-05-28)

## Context

`ax` needs to rank skills by usage × role weight to answer "what made X work" - framing skills that open a session matter more than incidental tool-call skills. Friction F5 in the dogfood session `3d6a3531` showed that flat invocation-count ranking inverts importance: `dogfood` (1 invocation, produced the entire demo) ranked below `batch-read-upfront` (5 invocations, mechanical reads).

Two design constraints made a flat field on `skill` inadequate:

1. **Multi-role is natural.** A skill like `dogfood` is both a framing skill and a producer. Encoding a single `role: string` loses the secondary role; encoding `roles: array<string>` loses per-role metadata.
2. **Source and confidence matter.** A role tagged by the user (`source="user"`) overrides a role inferred from a brief (`source="brief"`), which in turn outranks one parsed from frontmatter (`source="frontmatter"`). These priorities cannot be expressed on a flat field without collapsing provenance.

The grill decision Q3 (role: enum field vs RELATE edge) resolved to RELATE edge on both grounds.

## Decision

Model skill→role linkage as a `plays_role` RELATION in SurrealDB:

```sql
DEFINE TABLE IF NOT EXISTS role SCHEMAFULL;
DEFINE FIELD name   ON role TYPE string;
DEFINE FIELD weight ON role TYPE float DEFAULT 1.0;
DEFINE INDEX IF NOT EXISTS role_name_uq ON role FIELDS name UNIQUE;

DEFINE TABLE IF NOT EXISTS plays_role TYPE RELATION FROM skill TO role;
DEFINE FIELD confidence ON plays_role TYPE float DEFAULT 1.0;
DEFINE FIELD source     ON plays_role TYPE string;        -- "frontmatter" | "brief" | "user"
DEFINE FIELD weight     ON plays_role TYPE option<float>; -- per-edge override of role.weight
DEFINE FIELD rationale  ON plays_role TYPE option<string>;
DEFINE FIELD since      ON plays_role TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS plays_role_in  ON plays_role FIELDS in;
DEFINE INDEX IF NOT EXISTS plays_role_out ON plays_role FIELDS out;
```

Role nodes are upserted lazily as briefs and frontmatter pull them in. No static taxonomy seed file is shipped; ax-owned skills declare `role:` in their frontmatter, third-party skills are classified via agent-filled briefs (P3.3). The weighted query traverses `invoked → skill → plays_role → role` and multiplies invocation score by `coalesce(edge.weight, role.weight)`.

## Consequences

**Pros:**
- Multi-role is natural - one skill emits as many `plays_role` edges as needed with independent confidence values.
- Per-edge metadata (confidence, source, weight override, rationale) travels with the linkage rather than being embedded in a JSON blob on the skill row.
- Source provenance is distinguishable at query time: `source="user"` edges can be given query-time priority over `source="brief"` or `source="frontmatter"` without re-ingesting.
- Weighted queries compose naturally: `invoked → skill → plays_role → role` is a single graph traversal with no application-side join.

**Cons:**
- Graph traversal cost vs flat-field scan. `DEFINE INDEX plays_role_in/out` covers the common traversal patterns, but a `WHERE role = "framing"` scan cannot hit a covering index the way a scalar field on `skill` could.
- `recordLiteral` helpers are required to safely embed role record IDs in UPSERT/RELATE statements (consistent with the existing `src/lib/surql.ts` toolkit, but adds surface area).
- Re-ingest idempotency is non-trivial: sweep logic must match on `(in, out, source)` to avoid duplicate edges on repeated ingests (P3.2 addresses this).

## Related work

- **P3.1** - schema landed in commit `a8b809cf`; position fields on `invoked` (`turn_index`, `total_turns`, `is_first`) added in the same pass.
- **P3.2** - frontmatter ingest: reads `role:` from ax-owned `SKILL.md` files, writes `plays_role` edges with `source="frontmatter"`.
- **P3.3** - `ax skills classify`: emits agent-fill briefs for unclassified skills with ≥3 invocations; lint pipeline reads filled briefs → writes edges with `source="brief"`.
- **P3.5** - lint pipeline (`ax improve lint` / `ax skills lint`): idempotent sweep that reconciles brief-derived edges.
- **P3.6** - `ax skills weighted [--window=...]`: graph-traversal query with doctor-mode guidance when N+ unclassified skills exist.
- **P3.7** - read commands: `ax skills by-role`, `ax skills roles`, `ax roles`, `ax session show --by-role`.
