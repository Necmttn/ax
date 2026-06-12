import { describe, expect, test } from "bun:test";
import { checkFamilyFromCommand } from "./check-family.ts";

describe("checkFamilyFromCommand", () => {
    test("classifies direct check binaries", () => {
        expect(checkFamilyFromCommand("tsc --noEmit")).toBe("typecheck");
        expect(checkFamilyFromCommand("tsgo")).toBe("typecheck");
        expect(checkFamilyFromCommand("vitest run")).toBe("test");
        expect(checkFamilyFromCommand("jest")).toBe("test");
        expect(checkFamilyFromCommand("pytest -x")).toBe("test");
        expect(checkFamilyFromCommand("playwright test")).toBe("test");
        expect(checkFamilyFromCommand("eslint src")).toBe("eslint");
        expect(checkFamilyFromCommand("oxlint --fix")).toBe("oxlint");
        expect(checkFamilyFromCommand("oxc")).toBe("oxlint");
    });

    test("classifies runner subcommands and run-scripts", () => {
        expect(checkFamilyFromCommand("bun test apps/foo.test.ts")).toBe("test");
        expect(checkFamilyFromCommand("npm test")).toBe("test");
        expect(checkFamilyFromCommand("bun run typecheck")).toBe("typecheck");
        expect(checkFamilyFromCommand("bun run lint")).toBe("lint");
        expect(checkFamilyFromCommand("pnpm lint")).toBe("lint");
        expect(checkFamilyFromCommand("npm run lint:fix")).toBe("lint");
        expect(checkFamilyFromCommand("bun run build")).toBe("build");
        expect(checkFamilyFromCommand("bun run check:no-node-fs")).toBe("check");
        expect(checkFamilyFromCommand("cargo test")).toBe("test");
        expect(checkFamilyFromCommand("cargo check")).toBe("check");
        expect(checkFamilyFromCommand("cargo build")).toBe("build");
        expect(checkFamilyFromCommand("cargo clippy")).toBe("lint");
        expect(checkFamilyFromCommand("go test ./...")).toBe("test");
        expect(checkFamilyFromCommand("go vet ./...")).toBe("lint");
        expect(checkFamilyFromCommand("make build")).toBe("build");
    });

    test("classifies bare script tokens except shell-builtin test", () => {
        expect(checkFamilyFromCommand("lint")).toBe("lint");
        expect(checkFamilyFromCommand("typecheck")).toBe("typecheck");
        expect(checkFamilyFromCommand("test -f foo")).toBeNull();
    });

    test("looks past leading env assignments, cd prefixes, and earlier segments", () => {
        expect(checkFamilyFromCommand("CI=1 bun test")).toBe("test");
        expect(checkFamilyFromCommand("cd apps/axctl && bun test")).toBe("test");
        expect(checkFamilyFromCommand("echo done && bun run typecheck")).toBe("typecheck");
        expect(checkFamilyFromCommand("bun test || true")).toBe("test");
    });

    test("does not classify commands that merely mention check keywords", () => {
        expect(checkFamilyFromCommand(null)).toBeNull();
        expect(checkFamilyFromCommand("")).toBeNull();
        expect(checkFamilyFromCommand("date")).toBeNull();
        expect(checkFamilyFromCommand("ls test/")).toBeNull();
        expect(checkFamilyFromCommand("rg foo test/ -l")).toBeNull();
        expect(checkFamilyFromCommand("cat build.log")).toBeNull();
        expect(checkFamilyFromCommand("git push")).toBeNull();
        expect(checkFamilyFromCommand("git checkout build")).toBeNull();
        expect(checkFamilyFromCommand("bun install")).toBeNull();
        expect(checkFamilyFromCommand("bun ~/.ax/hooks/enforce-worktree.ts")).toBeNull();
        expect(checkFamilyFromCommand("echo test")).toBeNull();
        expect(checkFamilyFromCommand("bash scripts/test.sh")).toBeNull();
    });
});
