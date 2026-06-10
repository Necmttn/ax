/**
 * Migration harness for the parser-normalization seam (Phase 4).
 *
 * Compares the statement MULTISET a legacy per-parser builder produced against
 * the normalized-batch path. Order-insensitive on purpose: every statement is
 * an independent idempotent UPSERT/RELATE (see plan ledger delta D3); the only
 * intra-batch ordering that matters (event clears before event upserts) is
 * owned by buildAgentEventStatements and unchanged.
 *
 * Byte-level equality per statement IS required - any non-empty delta means
 * the adapter mapping is wrong, never that the harness should be loosened.
 */
export interface StatementParityDelta {
    /** Statements the legacy builder produced that the normalized path lost. */
    readonly missing: readonly string[];
    /** Statements the normalized path produced that legacy never did. */
    readonly added: readonly string[];
}

export const diffStatementSets = (
    legacy: readonly string[],
    next: readonly string[],
): StatementParityDelta => {
    const remaining = new Map<string, number>();
    for (const statement of legacy) {
        remaining.set(statement, (remaining.get(statement) ?? 0) + 1);
    }
    const added: string[] = [];
    for (const statement of next) {
        const count = remaining.get(statement) ?? 0;
        if (count === 0) {
            added.push(statement);
        } else if (count === 1) {
            remaining.delete(statement);
        } else {
            remaining.set(statement, count - 1);
        }
    }
    const missing = [...remaining.entries()].flatMap(([statement, count]) =>
        Array.from({ length: count }, () => statement)
    );
    return { missing, added };
};
