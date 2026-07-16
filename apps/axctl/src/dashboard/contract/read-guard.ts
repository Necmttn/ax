/**
 * Read-only guard for the studio /api/query surface. SurrealDB runs every
 * `;`-separated statement, so a prefix-only allow (`/^SELECT/`) lets
 * `SELECT 1; DELETE …` through. We reject any input that is more than ONE
 * statement, then require a read prefix. String literals and comments are
 * blanked first so a `;` inside them is not mistaken for a separator.
 */

/** Replace string-literal and comment spans with spaces, preserving length. */
function stripLiteralsAndComments(sql: string): string {
    let out = "";
    let i = 0;
    const n = sql.length;
    while (i < n) {
        const c = sql[i]!;
        // single- or double-quoted string
        if (c === "'" || c === '"') {
            const quote = c;
            out += " ";
            i++;
            while (i < n) {
                if (sql[i] === "\\") { out += "  "; i += 2; continue; }
                if (sql[i] === quote) { out += " "; i++; break; }
                out += " ";
                i++;
            }
            continue;
        }
        // line comment -- ... or # ... to end of line
        if ((c === "-" && sql[i + 1] === "-") || c === "#") {
            while (i < n && sql[i] !== "\n") { out += " "; i++; }
            continue;
        }
        // block comment /* ... */
        if (c === "/" && sql[i + 1] === "*") {
            out += "  ";
            i += 2;
            while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) { out += " "; i++; }
            if (i < n) { out += "  "; i += 2; }
            continue;
        }
        out += c;
        i++;
    }
    return out;
}

const READ_PREFIX_RE = /^(SELECT|RETURN|INFO)\b/i;

/**
 * True only when `sql` is a single read statement (SELECT/RETURN/INFO), with at
 * most one optional trailing `;`. Multi-statement input is rejected outright.
 */
export function isSingleReadStatement(sql: string): boolean {
    const trimmed = sql.trim();
    if (!trimmed) return false;
    const stripped = stripLiteralsAndComments(trimmed);
    // Drop a single trailing semicolon (plus trailing ws), then any remaining
    // `;` means a second statement.
    const withoutTrailing = stripped.replace(/;\s*$/, "");
    if (withoutTrailing.includes(";")) return false;
    return READ_PREFIX_RE.test(trimmed);
}
