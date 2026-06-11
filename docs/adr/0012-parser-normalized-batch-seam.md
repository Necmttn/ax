# Parsers are adapters producing NormalizedTranscriptBatch; statement building lives behind the seam

`axctl`'s five harness parsers (claude, codex, pi, opencode, cursor) no longer
compose their own dual-write SurrealQL. Each parser is an adapter whose job ends
at a `NormalizedTranscriptBatch` - providers, sessions, events, Turns, Tool
Calls, tool-file evidence, parent edges, synthetic skill invocations, plan
snapshots, compactions - built by a module-private `to<Provider>NormalizedBatch`
function. `buildNormalizedTranscriptStatements` (with a
`BuildNormalizedTranscriptStatementsOptions` bag; `clearExisting` defaults true,
threaded per-batch for streaming parsers like codex) owns statement emission:
the dual write to provider events (`agent_*`) and normalized records
(`session`/`turn`/`tool_call`), idempotence clears, and edge wiring. This is
within-stage normalization; ADR-0006's stage contract (typed stats, DB as the
inter-stage data contract) is untouched.

Provider-specific writes that the seam deliberately does NOT absorb stay as
extras appended outside the batch: per-provider token-usage rows, claude hook
evidence, and claude's effectful `relateInvocations` (routing real-skill edges
through the synthetic-skill builder would clobber real skill rows). The rule is
"normalized batch + provider extras", not "everything through one type".

Conversions were proven behavior-preserving with a statement-parity harness:
`diffStatementSets` (order-insensitive, multiplicity-respecting multiset diff)
between the legacy builder and the seam path had to come back empty on rich
fixtures, modulo a five-entry documented delta ledger (D1 invoked SET order
canonicalized, D2 `agent_event: NONE` key omitted when null, D3 ordering
covered by idempotent UPSERT/RELATE semantics, D4 cosmetic, D5 claude's seven
write spans collapsing into one `normalizedBatch` span). After conversion the
legacy builders were deleted and the parity tests converted to golden
assertions. Byte equality modulo the ledger is the contract: a non-empty delta
means the adapter is wrong - never loosen the harness.

Consequence: a sixth harness implements raw-format extraction and one
`to*NormalizedBatch` function and gets the dual write, idempotence, and edge
wiring for free; a schema change to turn/tool-call statements is edited once in
the seam, not five times; and parser behavior changes are detectable as golden
statement diffs rather than DB archaeology.
