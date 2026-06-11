import { commandTokenSegments } from "./tool-calls.ts";

/**
 * Single source of truth for "is this command a verification check, and which
 * family?" - consumed by the ingest outcome classifier and the churn metric.
 *
 * Classification is anchored to command position: a family is only assigned
 * when the check is the command being run (`bun test`, `tsc --noEmit`), never
 * because a keyword appears somewhere in the text (`ls test/`, `cat build.log`).
 */
export type CheckFamily =
    | "test"
    | "typecheck"
    | "lint"
    | "eslint"
    | "oxlint"
    | "build"
    | "check";

const DIRECT_BINARIES = new Map<string, CheckFamily>([
    ["vitest", "test"],
    ["jest", "test"],
    ["pytest", "test"],
    ["tsc", "typecheck"],
    ["tsgo", "typecheck"],
    ["eslint", "eslint"],
    ["oxlint", "oxlint"],
    ["oxc", "oxlint"],
    ["golangci-lint", "lint"],
]);

/** Script/target names as run via `bun run X`, `pnpm X`, `make X`, or bare. */
const SCRIPT_FAMILIES = new Map<string, CheckFamily>([
    ["test", "test"],
    ["tsc", "typecheck"],
    ["typecheck", "typecheck"],
    ["lint", "lint"],
    ["eslint", "eslint"],
    ["oxlint", "oxlint"],
    ["build", "build"],
    ["check", "check"],
]);

/** Bare script tokens classify too, except `test` (shell builtin). */
const BARE_SCRIPT_TOKENS = new Set(["typecheck", "lint", "build", "check"]);

const PACKAGE_RUNNERS = new Set(["bun", "npm", "pnpm", "yarn", "deno", "npx", "bunx", "pnpx"]);
const RUN_ALIASES = new Set(["run", "x", "exec"]);
const TARGET_RUNNERS = new Set(["make", "just"]);

const CARGO_FAMILIES = new Map<string, CheckFamily>([
    ["test", "test"],
    ["check", "check"],
    ["build", "build"],
    ["clippy", "lint"],
]);

const GO_FAMILIES = new Map<string, CheckFamily>([
    ["test", "test"],
    ["build", "build"],
    ["vet", "lint"],
]);

const ALL_FAMILIES: ReadonlySet<string> = new Set<CheckFamily>([
    "test", "typecheck", "lint", "eslint", "oxlint", "build", "check",
]);

export const isCheckFamily = (value: string | null | undefined): value is CheckFamily =>
    value !== null && value !== undefined && ALL_FAMILIES.has(value);

/** Accept an already-canonical family verbatim, else classify as a command. */
export const coerceCheckFamily = (raw: string | null | undefined): CheckFamily | null =>
    isCheckFamily(raw) ? raw : checkFamilyFromCommand(raw);

export const checkFamilyFromCommand = (raw: string | null | undefined): CheckFamily | null => {
    if (raw === null || raw === undefined || raw.trim().length === 0) return null;

    for (const segment of commandTokenSegments(raw)) {
        const family = segmentFamily(segment);
        if (family !== null) return family;
    }
    return null;
};

const segmentFamily = (segment: readonly string[]): CheckFamily | null => {
    const tool = basename(segment[0] ?? "").toLowerCase();
    if (tool.length === 0) return null;

    const direct = DIRECT_BINARIES.get(tool);
    if (direct !== undefined) return direct;

    const args = segment.slice(1).filter((token) => !token.startsWith("-"));
    const arg0 = args[0]?.toLowerCase() ?? null;

    if (tool === "playwright") return arg0 === "test" ? "test" : null;
    if (tool === "cargo") return arg0 === null ? null : CARGO_FAMILIES.get(arg0) ?? null;
    if (tool === "go") return arg0 === null ? null : GO_FAMILIES.get(arg0) ?? null;
    if (TARGET_RUNNERS.has(tool)) return scriptFamily(arg0);

    if (PACKAGE_RUNNERS.has(tool)) {
        if (arg0 === "test") return "test";
        const script = arg0 !== null && RUN_ALIASES.has(arg0) ? args[1]?.toLowerCase() ?? null : arg0;
        return scriptFamily(script);
    }

    if (segment.length === 1 || BARE_SCRIPT_TOKENS.has(tool)) {
        return BARE_SCRIPT_TOKENS.has(tool) ? SCRIPT_FAMILIES.get(tool) ?? null : null;
    }
    return null;
};

/**
 * A normalized command ("bun run", "npx") that cannot classify on its own but
 * may resolve to a check family once the full command text is known.
 */
const RUNNER_AMBIGUOUS_NORM = /^(?:bun|npm|pnpm|yarn|deno|npx|bunx|pnpx)(?:\s+(?:run|x|exec))?$/;

export const commandNormNeedsText = (norm: string | null | undefined): boolean =>
    norm !== null && norm !== undefined && RUNNER_AMBIGUOUS_NORM.test(norm.trim().toLowerCase());

const scriptFamily = (script: string | null | undefined): CheckFamily | null => {
    if (script === null || script === undefined) return null;
    const head = script.split(":")[0] ?? "";
    return SCRIPT_FAMILIES.get(head) ?? null;
};

const basename = (token: string): string => token.split("/").pop() ?? token;
