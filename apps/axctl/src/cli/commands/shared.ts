/**
 * Shared helpers for the command-family modules under cli/commands/.
 * Extracted from cli/index.ts in the Phase 2 CLI split. Two kinds of helper
 * live here:
 *   - typed-flag plumbing (optionValue, requirePositiveInt, shared Flag specs)
 *   - string-array bridges (boolArg/intArg/stringArg) for registrations that
 *     delegate to external modules still taking `args: string[]`
 *     (share, project, retro reflect/meta/plan, dogfood terminal, version,
 *     update, daemon, classifiers eval/list, evidence).
 */
import { Option } from "effect";
import { Flag } from "effect/unstable/cli";

export const boolArg = (name: string, enabled: boolean): string[] =>
    enabled ? [`--${name}`] : [];

export const intArg = (name: string, value: number | undefined): string[] =>
    value === undefined ? [] : [`--${name}=${value}`];

export const stringArg = (name: string, value: string | undefined): string[] =>
    value === undefined ? [] : [`--${name}=${value}`];

export const optionValue = <A>(value: Option.Option<A>): A | undefined =>
    Option.getOrUndefined(value);

export const positiveLimit = (fallback: number) =>
    Flag.integer("limit").pipe(Flag.withDefault(fallback));
export const optionalSince = Flag.integer("since").pipe(Flag.optional);
export const jsonFlag = Flag.boolean("json").pipe(Flag.withDefault(false));

/**
 * Typed replacement for the old string-based parsePositiveIntFlag: the Effect
 * CLI parser already guarantees an integer; this preserves the positivity
 * check (and exact error wording + exit 2) that used to run on the rebuilt
 * string array. See issues #38, #45 for why bad values must not reach SQL.
 */
export function requirePositiveInt(cmd: string, flagName: string, n: number): number {
    if (!Number.isInteger(n) || n <= 0) {
        console.error(
            `axctl ${cmd}: --${flagName} must be a positive integer (got "${n}")`,
        );
        process.exit(2);
    }
    return n;
}

/** Optional-flag variant: absent stays absent; present must be a positive integer. */
export function requireOptionalPositiveInt(
    cmd: string,
    flagName: string,
    n: number | undefined,
): number | undefined {
    if (n === undefined) return undefined;
    return requirePositiveInt(cmd, flagName, n);
}

/**
 * Format a numeric counter with thousand-separators (issue #46). Keeps short
 * values short; long ones become e.g. `597,508` rather than blowing the
 * column.
 */
export function fmtCount(v: unknown): string {
    const n = Number(v ?? 0);
    if (!Number.isFinite(n)) return "0";
    return n.toLocaleString("en-US");
}

/** Split a comma-separated file-hint flag into trimmed non-empty entries. */
export const parseFileHints = (value: Option.Option<string>): readonly string[] =>
    (Option.getOrUndefined(value) ?? "")
        .split(",")
        .map((file) => file.trim())
        .filter((file) => file.length > 0);
