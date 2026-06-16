import { describe, expect, test } from "bun:test";
import { isContextTool, isVerificationTool } from "./tool-taxonomy.ts";

describe("isVerificationTool", () => {
    test("credits ecosystem test runners with no English keyword in name", () => {
        // The bug (#471): rspec has no "test", rubocop has no "lint".
        for (const label of ["rspec", "bin/rspec", "rubocop", "bin/rubocop", "pytest", "phpunit"]) {
            expect(isVerificationTool(label)).toBe(true);
        }
    });

    test("covers every requested ecosystem", () => {
        const byEcosystem: Record<string, string[]> = {
            ruby: ["rspec", "rubocop", "standardrb", "brakeman"],
            python: ["pytest", "ruff", "flake8", "pylint", "mypy", "pyright", "tox"],
            go: ["go test ./...", "go vet", "golangci-lint run", "staticcheck"],
            rust: ["cargo test", "cargo clippy"],
            jsts: ["vitest", "jest", "tsc --noEmit", "eslint .", "oxlint", "biome check"],
            php: ["phpunit", "phpstan analyse", "psalm", "phpcs"],
            elixir: ["mix test", "mix credo", "credo"],
            dotnet: ["dotnet test"],
            jvm: ["mvn test", "mvn verify", "./gradlew check", "gradlew test", "ktlint", "detekt"],
            scala: ["sbt test", "scala-cli test", "clj-kondo", "lein test"],
            haskell: ["cabal test", "stack test", "hlint"],
            swift: ["swift test", "xcodebuild test", "swiftlint"],
            ccpp: ["clang-tidy", "cppcheck", "ctest", "bats tests/"],
            shell: ["shellcheck script.sh", "yamllint .", "actionlint"],
        };
        for (const [eco, labels] of Object.entries(byEcosystem)) {
            for (const label of labels) {
                expect(`${eco}:${label}=${isVerificationTool(label)}`).toBe(`${eco}:${label}=true`);
            }
        }
    });

    test("credits e2e/browser drivers including Playwright + MCP suite (issue #471)", () => {
        for (
            const label of [
                "playwright", "bin/pw", "pw", "cypress run", "playwright test",
                "mcp__playwright__browser_navigate", "mcp__playwright__browser_screenshot",
                "mcp__puppeteer__navigate", "mcp__cypress__run",
            ]
        ) {
            expect(isVerificationTool(label)).toBe(true);
        }
    });

    test("credits package run-scripts for lint/typecheck/check, not just test (regression)", () => {
        // Old regex counted lint/typecheck; the first taxonomy draft dropped them.
        for (
            const label of [
                "bun test", "bun run typecheck", "npm run lint", "pnpm lint",
                "yarn check", "pnpm run typecheck", "npm test",
            ]
        ) {
            expect(isVerificationTool(label)).toBe(true);
        }
    });

    test("robust to env prefixes, cd, and && / pipe chains (reuses shell tokenizer)", () => {
        expect(isVerificationTool("NODE_ENV=test vitest")).toBe(true);
        expect(isVerificationTool("cd app && pytest")).toBe(true);
        expect(isVerificationTool("bundle exec rspec")).toBe(true);
        expect(isVerificationTool("poetry run mypy .")).toBe(true);
        expect(isVerificationTool("uv run pytest")).toBe(true);
    });

    test("module runners and option-bearing subcommands", () => {
        expect(isVerificationTool("python -m pytest")).toBe(true);
        expect(isVerificationTool("python3 -m unittest")).toBe(true);
        expect(isVerificationTool("python -m mypy src")).toBe(true);
        expect(isVerificationTool("node --test")).toBe(true);
        expect(isVerificationTool("rake test")).toBe(true);
        expect(isVerificationTool("mvn clean test")).toBe(true);
        // the `-scheme App` option value must not be read as the action
        expect(isVerificationTool("xcodebuild -scheme App test")).toBe(true);
        // a python interpreter NOT running a test module is not verification
        expect(isVerificationTool("python -m http.server")).toBe(false);
        expect(isVerificationTool("python app.py")).toBe(false);
    });

    test("e2e driver setup/inspection subcommands are not verification", () => {
        expect(isVerificationTool("playwright install")).toBe(false);
        expect(isVerificationTool("playwright codegen")).toBe(false);
        expect(isVerificationTool("pw --help")).toBe(false);
        // but the bare normalized driver label still counts (ambiguous -> run)
        expect(isVerificationTool("playwright")).toBe(true);
    });

    test("classifies the full command text (production feeds command_text)", () => {
        // These collapse under normalizeCommand (mvn test -> mvn, npm run lint
        // -> npm run, bundle exec rspec -> bundle); only the full command sees
        // the verifier. The profile/wrapped queries now classify command_text.
        for (const label of ["mvn test", "sbt test", "dotnet test", "npm run lint", "bundle exec rspec"]) {
            expect(`${label}=${isVerificationTool(label)}`).toBe(`${label}=true`);
        }
    });

    test("non-verifying subcommands of the same program do NOT match", () => {
        expect(isVerificationTool("go build")).toBe(false);
        expect(isVerificationTool("cargo build")).toBe(false);
        expect(isVerificationTool("mvn package")).toBe(false);
        expect(isVerificationTool("./gradlew assemble")).toBe(false);
    });

    test("excludes git subcommands and the shell builtin test", () => {
        expect(isVerificationTool("git checkout")).toBe(false);
        expect(isVerificationTool("git checkout -b feat/x")).toBe(false);
        expect(isVerificationTool("git check-ignore")).toBe(false);
        // `test -f foo` normalizes to `test` (shell builtin) - not verification.
        expect(isVerificationTool("test")).toBe(false);
        expect(isVerificationTool("test -f foo")).toBe(false);
    });

    test("does not match keywords as substrings of unrelated programs", () => {
        expect(isVerificationTool("fastest-cli")).toBe(false);
        expect(isVerificationTool("contest")).toBe(false);
        expect(isVerificationTool("Bash")).toBe(false);
        expect(isVerificationTool("Read")).toBe(false);
        expect(isVerificationTool("Agent")).toBe(false);
    });

    test("null/empty safe", () => {
        expect(isVerificationTool(null)).toBe(false);
        expect(isVerificationTool(undefined)).toBe(false);
        expect(isVerificationTool("")).toBe(false);
        expect(isVerificationTool("   ")).toBe(false);
    });
});

describe("isContextTool", () => {
    test("credits search/read programs and native tools", () => {
        for (const label of ["rg", "grep", "fd", "find", "cat", "sed", "Read", "Grep", "recall"]) {
            expect(isContextTool(label)).toBe(true);
        }
    });

    test("credits multi-token git grep (regression - head-token reduction dropped it)", () => {
        // command_norm normalizes `git grep foo` -> `git grep` at ingest.
        expect(isContextTool("git grep")).toBe(true);
    });

    test("credits NotebookRead (regression - old /read/i matched it)", () => {
        expect(isContextTool("NotebookRead")).toBe(true);
    });

    test("does not credit verification or unrelated tools", () => {
        expect(isContextTool("rspec")).toBe(false);
        expect(isContextTool("Agent")).toBe(false);
        expect(isContextTool("")).toBe(false);
    });
});
