import { describe, expect, test } from "bun:test";
import {
    DuckDbDecodeError,
    DuckDbDylibError,
    DuckDbOpenError,
    DuckDbQueryError,
    DuckDbUnsupportedTypeError,
    SnapshotPublishError,
} from "./errors.ts";

describe("duckdb errors", () => {
    test("each error carries its discriminating tag", () => {
        expect(new DuckDbOpenError({ path: "/tmp/x.db", readOnly: true, message: "boom" })._tag)
            .toBe("DuckDbOpenError");
        expect(new DuckDbQueryError({ sql: "SELECT 1", message: "boom" })._tag)
            .toBe("DuckDbQueryError");
        expect(new DuckDbDecodeError({ sql: "SELECT 1", message: "bad row" })._tag)
            .toBe("DuckDbDecodeError");
        expect(new DuckDbUnsupportedTypeError({ column: "payload", typeId: 18 })._tag)
            .toBe("DuckDbUnsupportedTypeError");
        expect(new DuckDbDylibError({ message: "not found" })._tag).toBe("DuckDbDylibError");
        expect(new SnapshotPublishError({ snapshotPath: "/tmp/s.db", message: "boom" })._tag)
            .toBe("SnapshotPublishError");
    });

    test("the unsupported-type error names the column and how to work around it", () => {
        const err = new DuckDbUnsupportedTypeError({ column: "payload", typeId: 18 });
        expect(err.message).toContain("payload");
        expect(err.message).toContain("BLOB");
        expect(err.message).toContain("hex(payload)");
    });

    test("nested types suggest to_json instead of hex", () => {
        const err = new DuckDbUnsupportedTypeError({ column: "tags", typeId: 24 /* LIST */ });
        expect(err.message).toContain("to_json(tags)");
    });

    test("an unknown future scalar type suggests CAST(col AS VARCHAR)", () => {
        const err = new DuckDbUnsupportedTypeError({ column: "future", typeId: 999 });
        expect(err.message).toContain("CAST(future AS VARCHAR)");
    });
});
