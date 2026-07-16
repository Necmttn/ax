/**
 * Shared "non-negative number env var" parser (#697 follow-up).
 *
 * `Number("")` and `Number("  ")` are both `0` - finite and `>= 0` - so a
 * naive `Number.isFinite(raw) && raw >= 0` guard reads a BLANK env var as an
 * explicit "0" rather than "unset". An exported-but-blank var is a real
 * trigger, not a hypothetical: an empty string in a launchd plist, or a bare
 * `export AX_FOO=` line in a shell profile. `reapIntervalSeconds`
 * (dashboard/reap-loop.ts) already guarded against this; `staleIngestThresholdMs`
 * (queries/ingest-staleness.ts) and `deriveReserveMs` (ingest/stage/derive-budget.ts)
 * did not - three parsers hand-rolled the same shape and two got it wrong, so
 * it lives here once.
 *
 * Semantics: undefined / blank / whitespace-only / unparseable -> `fallback`.
 * A valid non-negative number (including the literal `"0"`) -> that number;
 * each call site treats an explicit `0` as its own meaningful "disabled" /
 * "no reserve" value, so `0` must never be confused with "unset".
 *
 * Dep-free (no Effect, no DB) - `ax doctor`'s no-layer probe imports from
 * this directory.
 */
export const nonNegativeNumberEnv = (raw: string | undefined, fallback: number): number => {
    const trimmed = raw?.trim();
    if (!trimmed) return fallback;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};
