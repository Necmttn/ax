import { describe, expect, test } from "bun:test";

import { findRetiredCommandCopy, validatePackageScripts } from "./check-active-command-copy.ts";

describe("findRetiredCommandCopy", () => {
    test("rejects retired commands in active files", () => {
        expect(findRetiredCommandCopy({ "README.md": "Run axctl serve." })).toEqual([
            "README.md: retired command: axctl serve",
        ]);
    });

    test("accepts the studio command", () => {
        expect(findRetiredCommandCopy({ "README.md": "Run axctl studio." })).toEqual([]);
    });
});

describe("validatePackageScripts", () => {
    test("rejects retired aliases and missing config targets", () => {
        expect(validatePackageScripts("package.json", {
            search: "bun cli search",
            serve: "bun cli serve",
            "dashboard:dev": "vite --config apps/axctl/src/dashboard/web/vite.config.ts",
        })).toEqual([
            "package.json: ambiguous search script",
            "package.json: retired serve script",
            "package.json: dashboard:dev uses a missing dashboard Vite config",
        ]);
    });

    test("accepts current aliases", () => {
        expect(validatePackageScripts("package.json", {
            studio: "bun cli studio",
            "dashboard:dev": "bun --filter @ax/studio dev",
        })).toEqual([]);
    });
});
