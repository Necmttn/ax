/** Minimal git-command-line tokenizer for hook guards.
 *
 *  Splits a Bash command string on shell separators and extracts every git
 *  invocation: its verb (first non-flag token), the global `-C <path>` value,
 *  and the remaining args. Deliberately naive about quoting: a separator
 *  inside quotes missplits the segment, which degrades to "no git invocation
 *  found" (fail open) - the same class of imprecision the old bash greps had,
 *  minus their substring false-positives (`echo git merge` never matches here
 *  because `git` must be the segment's command word).
 */

export interface GitInvocation {
  /** first non-flag token after `git` (e.g. "merge", "checkout"). */
  readonly verb: string;
  /** value of the global `-C <path>` flag, if present (quotes stripped). */
  readonly cPath: string | null;
  /** tokens after the verb. */
  readonly args: ReadonlyArray<string>;
}

const SEPARATORS = /\|\||&&|;|\||\n/;
const VAR_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

const stripQuotes = (s: string): string => {
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'")))
  ) {
    return s.slice(1, -1);
  }
  return s;
};

/** All git invocations in `command`, one per shell segment that starts with
 *  `git` (after leading VAR=value assignments). */
export const findGitInvocations = (command: string): GitInvocation[] => {
  const out: GitInvocation[] = [];
  for (const segment of command.split(SEPARATORS)) {
    const tokens = segment.trim().split(/\s+/).filter((t) => t !== "");
    let i = 0;
    while (i < tokens.length && VAR_ASSIGNMENT.test(tokens[i] as string)) i++;
    if (tokens[i] !== "git") continue;
    i++;

    let cPath: string | null = null;
    let verb: string | null = null;
    while (i < tokens.length) {
      const t = tokens[i] as string;
      if (t === "-C") {
        const v = tokens[i + 1];
        if (v !== undefined) cPath = stripQuotes(v);
        i += 2;
        continue;
      }
      if (t === "-c" || t === "--git-dir" || t === "--work-tree") {
        i += 2; // flag + its value
        continue;
      }
      if (t.startsWith("-")) {
        i++; // any other global flag (incl. --git-dir=x / --work-tree=x)
        continue;
      }
      verb = t;
      i++;
      break;
    }
    if (verb === null) continue;
    out.push({ verb, cPath, args: tokens.slice(i) });
  }
  return out;
};
