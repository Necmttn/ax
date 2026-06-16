// Semantic tool taxonomy: classify a tool_call label as verification or
// context work, ecosystem-aware instead of JS/TS-flavored substring matching.
//
// Before this module, "verification" was detected by one regex
// (/test|check|verify|lint|typecheck|tsc|vitest|bun test/i) substring-matched
// against the tool label. That over-counts `git checkout` (substring "check")
// and under-counts non-JS/TS runners whose names contain no English keyword:
// `rspec` has no "test", `rubocop` has no "lint", `bin/pw`/`playwright` browse.
// See issue #471.
//
// The label passed in is `command_norm ?? name` from the tool_call row
// (e.g. "bin/rspec", "git checkout", "mcp__playwright__browser_navigate",
// "Bash", "tsc --noEmit"). We match on the FIRST token (the program) where it
// matters so flag/argument noise can't trigger a false positive.

/** First whitespace-delimited token of a label, lowercased. */
function head(label: string): string {
    return label.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
}

/** Basename of a path-like token: "bin/rspec" -> "rspec", "/usr/bin/pytest" -> "pytest". */
function basename(token: string): string {
    const slash = token.lastIndexOf("/");
    return slash >= 0 ? token.slice(slash + 1) : token;
}

// Program basenames that ARE verification when invoked, across ecosystems.
// Ruby: rspec, rubocop, standardrb, reek; Python: pytest, ruff, flake8, pylint,
// mypy, pyright, tox; Go: (handled via "go test"/"go vet"), golangci-lint;
// Rust: (cargo test/clippy handled below); JS/TS: vitest, jest, mocha, ava,
// tsc, eslint, biome, oxlint, tsd, playwright, cypress; PHP: phpunit, phpstan,
// psalm, phpcs; Elixir: credo; .NET: (dotnet test handled below); generic e2e.
const VERIFICATION_PROGRAMS = new Set<string>([
    // test runners
    "rspec", "pytest", "tox", "nose", "nosetests", "phpunit", "vitest", "jest",
    "mocha", "ava", "jasmine", "karma", "ctest", "gtest", "rstest",
    // linters / formatters-as-checkers / static analysis
    "rubocop", "standardrb", "reek", "ruff", "flake8", "pylint", "pyflakes",
    "bandit", "eslint", "biome", "oxlint", "stylelint", "golangci-lint",
    "staticcheck", "clippy", "credo", "phpstan", "psalm", "phpcs", "phpmd",
    "shellcheck", "luacheck", "ameba",
    // type checkers
    "tsc", "tsd", "mypy", "pyright", "pyre", "sorbet", "srb", "flow",
    // e2e / browser drivers
    "playwright", "pw", "cypress", "puppeteer", "selenium", "webdriver",
    "testcafe", "nightwatch",
]);

// Multi-token program forms: program + first subcommand must both match.
// Keyed by program; value is the set of verifying subcommands.
const VERIFICATION_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
    go: new Set(["test", "vet"]),
    cargo: new Set(["test", "clippy", "nextest", "check"]),
    dotnet: new Set(["test"]),
    mix: new Set(["test", "credo", "dialyzer"]),
    npm: new Set(["test", "t"]),
    pnpm: new Set(["test"]),
    yarn: new Set(["test"]),
    bun: new Set(["test"]),
    swift: new Set(["test"]),
    gradle: new Set(["test", "check"]),
    rake: new Set(["test", "spec"]),
};

// Generic English keywords that signal verification when present as the program
// (NOT as a substring of an unrelated word). Kept narrow on purpose.
const VERIFICATION_KEYWORDS = /^(verify|typecheck|lint|test|check)/;

// `git` is never verification even though `git checkout` contains "check".
const NEVER_VERIFICATION_PROGRAMS = new Set<string>(["git"]);

/**
 * True if a tool_call label denotes verification work (running tests, linters,
 * type checkers, or e2e/browser drivers). Ecosystem-aware; excludes git.
 */
export function isVerificationTool(label: string | null | undefined): boolean {
    if (!label) return false;
    const tokens = label.trim().split(/\s+/);
    const prog = basename((tokens[0] ?? "").toLowerCase());
    if (!prog) return false;
    if (NEVER_VERIFICATION_PROGRAMS.has(prog)) return false;

    // MCP browser-automation suite (Playwright/Puppeteer MCP) is e2e verification.
    if (/^mcp__(playwright|puppeteer|cypress|browser)/.test(prog)) return true;

    if (VERIFICATION_PROGRAMS.has(prog)) return true;

    const subs = VERIFICATION_SUBCOMMANDS[prog];
    if (subs) {
        const sub = basename((tokens[1] ?? "").toLowerCase());
        if (sub && subs.has(sub)) return true;
    }

    // Generic keyword program (e.g. "typecheck", "bin/verify", "check-types"),
    // but only as the leading program token, never a substring of another word.
    if (VERIFICATION_KEYWORDS.test(prog)) return true;

    return false;
}

// Context-gathering tools (search / read / navigate). Unchanged in spirit from
// the original contextToolPattern, but matched on the program token so e.g.
// a path containing "read" in a different tool can't false-positive.
const CONTEXT_PROGRAMS = new Set<string>([
    "rg", "ripgrep", "grep", "ag", "ack", "sed", "cat", "bat", "find", "fd",
    "ls", "eza", "head", "tail", "read", "recall", "glob", "tree",
]);
const CONTEXT_KEYWORDS = /(recall|context|grep|search|read|open|find)/;

/** True if a tool_call label denotes context-gathering (search / read). */
export function isContextTool(label: string | null | undefined): boolean {
    if (!label) return false;
    const prog = basename(head(label));
    if (!prog) return false;
    if (CONTEXT_PROGRAMS.has(prog)) return true;
    // Native read/search tools (Read, Grep, Glob, mcp recall) and the like.
    return CONTEXT_KEYWORDS.test(prog);
}
