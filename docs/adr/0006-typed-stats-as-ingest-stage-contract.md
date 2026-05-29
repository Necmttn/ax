# Typed stats are the Ingest Stage contract; the DB is the inter-stage data contract

`axctl` will model each **Ingest Stage** as a co-located `StageDef` whose `run` returns a typed `BaseStageStats`-extending value carrying `durationMs`, `summary`, and stage-specific counts. Stages do not pass in-memory row collections to downstream stages; downstream stages read evidence back from SurrealDB. Deps express ordering, not data flow.

The deletion test confirms this: most stages share ordering, not row payloads. Stages like `derive-opportunities` and `derive-retro-proposals` already read cross-table evidence (proposals, signals, friction events, edges) that Surreal joins better than in-memory plumbing. Passing structured rows through the **Ingest Pipeline** would create one-adapter pretend-seams without a real second consumer.

Stage keys and tags are themselves co-located `Schema.Literal`s - each stage file exports `SignalsKey = Schema.Literal("signals")`; a central registry composes the union via `Schema.Union`. Tags follow the same per-tag-literal pattern with a central union. JSDoc `{@link}` references between keys give IDE-navigable dependency graphs and a place to scribble TODOs about not-yet-wired stages.

Consequence: adding a stage edits one file plus a tiny registry import; typed stats survive end-to-end through Effect; pipeline reasoning stays focused on ordering and concurrency rather than buffer management.
