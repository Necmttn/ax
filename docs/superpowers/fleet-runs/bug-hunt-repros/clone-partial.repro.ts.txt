import { describe, test } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, writeFileSync, existsSync, statSync, mkfifoSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneFile } from "/Users/necmttn/Projects/ax/.claude/worktrees/audit-storage/packages/lib/src/duckdb/clone-file.ts";

const probe = async (label: string, src: string, dst: string) => {
    const out = await Effect.runPromise(cloneFile(src, dst));
    const exists = existsSync(dst);
    console.log(
        `${label}: cloneable=${out.cloneable} reason=${out.reason ?? "-"} | dst exists=${exists}` +
        (exists ? ` size=${statSync(dst).size}` : ""),
    );
};

describe("cloneFile failure leaves-behind", () => {
    test("various failing sources", async () => {
        const dir = mkdtempSync(join(tmpdir(), "ax-clonep-"));
        // 1. char device source
        await probe("char-dev src (/dev/null)", "/dev/null", join(dir, "d1"));
        // 2. char device source with data
        await probe("char-dev src (/dev/zero)", "/dev/zero", join(dir, "d2"));
        // 3. a directory as source
        await probe("dir src", dir, join(dir, "d3"));
        // 4. missing source
        await probe("missing src", join(dir, "nope"), join(dir, "d4"));
        // 5. dst parent missing
        const good = join(dir, "good");
        writeFileSync(good, "x".repeat(4096));
        await probe("dst parent missing", good, join(dir, "no-such-dir", "d5"));
        // 6. control: real clone
        await probe("control ok", good, join(dir, "d6"));
    }, 30000);
});
