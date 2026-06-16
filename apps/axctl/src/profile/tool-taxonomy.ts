// Semantic tool taxonomy: classify a tool_call label as verification or
// context work, ecosystem-aware instead of JS/TS-flavored substring matching.
//
// Before this module, "verification" was one regex
// (/test|check|verify|lint|typecheck|tsc|vitest|bun test/i) substring-matched
// against the tool label. That over-counted `git checkout` (substring "check")
// and under-counted non-JS/TS runners whose names carry no English keyword
// (`rspec` has no "test", `rubocop` has no "lint"). See issue #471.
//
// Rather than maintain a parallel program list, this builds on the existing
// ingest classifiers so the two can never drift on the cases they share:
//   - commandTokenSegments  - the shell tokenizer that strips env/cd prefixes
//     and splits `a && b | c` into segments (so `NODE_ENV=test vitest` and
//     `cd app && pytest` classify, which a naive whitespace split misses).
//   - checkFamilyFromCommand - the churn metric's "is this a check, which
//     family" classifier. It already handles JS/TS direct binaries, package
//     runners + run-scripts (`bun run lint`, `pnpm typecheck`), `cargo`/`go`
//     subcommands, `make`/`just` targets, and deliberately excludes the shell
//     builtin `test`.
//   - isReadTool / READ_COMMANDS - the canonical read/search classifier
//     (handles `git grep`, rg, sed, cat, find, plus Read/Grep/Glob names).
// On top of that we layer the cross-ecosystem programs check-family does not
// model (Ruby, Python, PHP, Elixir, .NET, JVM, Scala, Haskell, Swift, C/C++,
// shell) and credit e2e/browser drivers (Playwright/Cypress/MCP browser suite)
// as verification, which is the workload issue #471 was raised about.

import { isReadTool } from "@ax/lib/shared/tool-classes";
import { checkFamilyFromCommand } from "../ingest/check-family.ts";
import { commandTokenSegments } from "../ingest/tool-calls.ts";

const basename = (token: string): string => token.split("/").pop() ?? token;

/** First whitespace-delimited program token of a label, basename + lowercased. */
function programOf(label: string): string {
    return basename((label.trim().split(/\s+/, 1)[0] ?? "").toLowerCase());
}

// --- verification ------------------------------------------------------------

// MCP browser-automation suites (Playwright/Puppeteer/Cypress/generic browser).
// These tool labels are not shell commands - they arrive as `mcp__server__tool`
// and never normalize, so match the raw label prefix. Driving a browser to
// exercise the app IS the verification workload on an e2e-heavy stack (#471).
const MCP_BROWSER_RE = /^mcp__(playwright|puppeteer|cypress|browser|selenium|webdriver)/;

// Bare e2e/browser driver programs (`bin/pw`, `playwright`, `cypress run`...).
// `playwright test` is already caught by checkFamilyFromCommand; this covers
// the bare-driver and non-`test` subcommand invocations.
const E2E_PROGRAMS = new Set<string>([
    "playwright", "pw", "cypress", "puppeteer", "selenium", "webdriver",
    "testcafe", "nightwatch", "codeceptjs", "wdio",
]);

// Programs that ARE verification when invoked, across ecosystems that
// check-family.ts does not model. Excludes anything already in its
// DIRECT_BINARIES (vitest/jest/pytest/tsc/tsgo/eslint/oxlint/oxc/golangci-lint)
// to avoid a second copy of the same entry.
const ECO_PROGRAMS = new Set<string>([
    // Ruby
    "rspec", "rubocop", "standardrb", "reek", "brakeman", "sorbet", "srb",
    // Python (linters / type checkers / runners not covered above)
    "ruff", "flake8", "pylint", "pyflakes", "bandit", "mypy", "pyright", "pyre",
    "tox", "nose", "nosetests",
    // PHP
    "phpunit", "phpstan", "psalm", "phpcs", "phpmd",
    // JS/TS extras
    "biome", "stylelint", "ava", "mocha", "jasmine", "karma", "tsd", "flow",
    // Elixir
    "credo", "dialyzer", "dialyxir",
    // JVM (Java / Kotlin)
    "ktlint", "detekt", "checkstyle", "spotbugs", "pmd",
    // Scala / Clojure
    "scalafix", "clj-kondo", "bloop",
    // Haskell
    "hlint",
    // Swift
    "swiftlint",
    // C / C++
    "clang-tidy", "cppcheck", "ctest", "cpplint", "iwyu",
    // shell / infra / cross-cutting checkers
    "shellcheck", "luacheck", "hadolint", "yamllint", "ameba", "vale",
    "markdownlint", "actionlint", "tflint", "staticcheck", "revive", "gosec",
    "bats",
    // generic check scripts (exact program name, not a substring)
    "verify",
]);

// Program + first non-flag argument forms (`sbt test`, `mvn verify`,
// `./gradlew check`, `dotnet test`, `mix credo`, `xcodebuild test`, ...).
const ECO_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
    sbt: new Set(["test"]),
    "scala-cli": new Set(["test"]),
    lein: new Set(["test", "check"]),
    mvn: new Set(["test", "verify"]),
    mvnw: new Set(["test", "verify"]),
    gradle: new Set(["test", "check"]),
    gradlew: new Set(["test", "check"]),
    dotnet: new Set(["test"]),
    mix: new Set(["test", "credo", "dialyzer"]),
    swift: new Set(["test"]),
    xcodebuild: new Set(["test"]),
    stack: new Set(["test"]),
    cabal: new Set(["test"]),
};

// Wrappers that run another program (`bundle exec rspec`, `poetry run pytest`,
// `uv run mypy`). Re-dispatch on the wrapped command.
const WRAPPER_RUNNERS = new Set<string>([
    "bundle", "poetry", "uv", "pdm", "rye", "hatch", "pipenv",
]);
const WRAPPER_ALIASES = new Set(["exec", "run"]);

/** Does a single command segment (already prefix-stripped) denote verification? */
function segmentIsVerification(segment: readonly string[]): boolean {
    const prog = basename((segment[0] ?? "").toLowerCase());
    if (!prog) return false;

    if (WRAPPER_RUNNERS.has(prog)) {
        let rest = segment.slice(1);
        if (rest[0] && WRAPPER_ALIASES.has(rest[0].toLowerCase())) rest = rest.slice(1);
        // Re-dispatch through the full classifier so the wrapped command hits
        // check-family too (e.g. `uv run pytest`, `bundle exec rake test`).
        return rest.length > 0 ? isVerificationTool(rest.join(" ")) : false;
    }

    if (E2E_PROGRAMS.has(prog) || ECO_PROGRAMS.has(prog)) return true;

    const subs = ECO_SUBCOMMANDS[prog];
    if (subs) {
        const arg0 = segment.slice(1).find((t) => !t.startsWith("-"))?.toLowerCase();
        if (arg0 && subs.has(arg0)) return true;
    }
    return false;
}

/**
 * True if a tool_call label denotes verification work - running tests,
 * linters, type checkers, or e2e/browser drivers - across ecosystems.
 * `git checkout` and the shell builtin `test` are excluded.
 */
export function isVerificationTool(label: string | null | undefined): boolean {
    if (!label || label.trim().length === 0) return false;

    if (MCP_BROWSER_RE.test(label.trim().toLowerCase())) return true;

    // Reuse the churn classifier for everything it already models (JS/TS direct
    // binaries, package run-scripts, cargo/go subcommands, make/just targets);
    // `build` is not verification.
    const family = checkFamilyFromCommand(label);
    if (family !== null && family !== "build") return true;

    for (const segment of commandTokenSegments(label)) {
        if (segmentIsVerification(segment)) return true;
    }
    return false;
}

// --- context -----------------------------------------------------------------

// Context-gathering programs that the canonical READ classifier does not list
// (it owns cat/sed/rg/grep/find/`git grep` + Read/Grep/Glob names). These are
// the extras the original contextToolPattern counted.
const CONTEXT_EXTRAS = new Set<string>(["recall", "context", "open"]);

/** True if a tool_call label denotes context-gathering (search / read). */
export function isContextTool(label: string | null | undefined): boolean {
    if (!label || label.trim().length === 0) return false;
    // isReadTool inspects both the tool name and command_norm sets; the merged
    // label can satisfy either, so pass it as both.
    if (isReadTool({ name: label, command_norm: label })) return true;
    return CONTEXT_EXTRAS.has(programOf(label));
}
