import { expect, test } from "bun:test";

import { buildSchemaImportArgs } from "./DesktopSchema.ts";

test("buildSchemaImportArgs targets the local surreal with ns=ax db=main", () => {
    const args = buildSchemaImportArgs({
        surrealPort: 8521,
        schemaFile: "/data/ax/.schema-cache.surql",
    });

    // surreal import sub-command, pointed at the spawned DB.
    expect(args[0]).toBe("import");
    expect(args).toContain("--endpoint");
    expect(args[args.indexOf("--endpoint") + 1]).toBe("http://127.0.0.1:8521");
    // Namespace/database must match makeAxServeConfig (ax/main).
    expect(args[args.indexOf("--ns") + 1]).toBe("ax");
    expect(args[args.indexOf("--db") + 1]).toBe("main");
    // The schema file is the final positional argument.
    expect(args[args.length - 1]).toBe("/data/ax/.schema-cache.surql");
});

test("buildSchemaImportArgs reflects a non-default surreal port", () => {
    const args = buildSchemaImportArgs({
        surrealPort: 9999,
        schemaFile: "/tmp/s.surql",
    });
    expect(args[args.indexOf("--endpoint") + 1]).toBe("http://127.0.0.1:9999");
});
