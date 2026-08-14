import { ptr } from "bun:ffi";
import { describe, expect, test } from "bun:test";
import { noteSkippedDylib, resolveTestDylib } from "../testing/duckdb-dylib.ts";
import { cstr, DUCKDB_RESULT_SIZE, DUCKDB_SUCCESS, handleBuffer, openLibDuckDb, readCString } from "./ffi.ts";

// Resolved at module load (top-level await), not in `beforeAll`, so
// `test.skipIf` below sees a real boolean at test-registration time and bun
// reports a SKIP status - distinct from a pass - when no dylib is available.
// (`resolveTestDylib` never throws; it returns a `{ ok: false, reason }`
// instead, so this await is safe even offline.)
const found = await resolveTestDylib();
const dylib = found.ok ? found.path : null;
if (!found.ok) noteSkippedDylib("duckdb ffi", found.reason);

describe("openLibDuckDb", () => {
    test.skipIf(dylib === null)(
        "binds every symbol the client needs, including the row-major value accessors",
        () => {
            const lib = openLibDuckDb(dylib as string);
            try {
                for (const name of [
                    "duckdb_open_ext",
                    "duckdb_close",
                    "duckdb_connect",
                    "duckdb_disconnect",
                    "duckdb_query",
                    "duckdb_prepare",
                    "duckdb_bind_varchar",
                    "duckdb_bind_int64",
                    "duckdb_bind_double",
                    "duckdb_bind_boolean",
                    "duckdb_bind_null",
                    "duckdb_execute_prepared",
                    "duckdb_destroy_prepare",
                    "duckdb_prepare_error",
                    "duckdb_destroy_result",
                    "duckdb_result_error",
                    "duckdb_row_count",
                    "duckdb_rows_changed",
                    "duckdb_column_count",
                    "duckdb_column_name",
                    "duckdb_column_type",
                    "duckdb_value_boolean",
                    "duckdb_value_int64",
                    "duckdb_value_uint64",
                    "duckdb_value_double",
                    "duckdb_value_varchar",
                    "duckdb_value_is_null",
                    "duckdb_free",
                    "duckdb_create_config",
                    "duckdb_set_config",
                    "duckdb_destroy_config",
                ]) {
                    expect(typeof (lib.symbols as Record<string, unknown>)[name]).toBe("function");
                }
            } finally {
                lib.close();
            }
        },
    );

    test.skipIf(dylib === null)("runs an in-memory round trip through the bound symbols", () => {
        const lib = openLibDuckDb(dylib as string);
        const db = handleBuffer();
        const conn = handleBuffer();
        try {
            expect(lib.symbols.duckdb_open_ext(cstr(":memory:"), ptr(db), 0n, null)).toBe(DUCKDB_SUCCESS);
            expect(lib.symbols.duckdb_connect(db[0]!, ptr(conn))).toBe(DUCKDB_SUCCESS);
            const result = new Uint8Array(DUCKDB_RESULT_SIZE);
            expect(lib.symbols.duckdb_query(conn[0]!, cstr("SELECT 41 + 1 AS answer"), ptr(result))).toBe(
                DUCKDB_SUCCESS,
            );
            expect(lib.symbols.duckdb_row_count(ptr(result))).toBe(1n);
            expect(readCString(lib.symbols.duckdb_column_name(ptr(result), 0n))).toBe("answer");
            expect(lib.symbols.duckdb_value_int64(ptr(result), 0n, 0n)).toBe(42n);
            lib.symbols.duckdb_destroy_result(ptr(result));
        } finally {
            lib.symbols.duckdb_disconnect(ptr(conn));
            lib.symbols.duckdb_close(ptr(db));
            lib.close();
        }
    });

    // Regression test for readCString mishandling a bigint pointer. `char
    // **out_error` (duckdb_open_ext's 4th arg) writes into a BigUint64Array
    // we own, so reading `errorBuf[0]` back out gives a `bigint` pointer -
    // exactly the shape `readCString` must decode correctly. Before the
    // `Number(p)` coercion, `new CString(bigintValue)` silently returned the
    // literal string "TypeError [ERR_INVALID_ARG_TYPE]: ptr must be a
    // number." instead of throwing or decoding, so this assertion would have
    // failed (message would equal that TypeError text) against the
    // unfixed implementation.
    test.skipIf(dylib === null)("readCString decodes a bigint pointer read out of a BigUint64Array", () => {
        const lib = openLibDuckDb(dylib as string);
        const db = handleBuffer();
        const errorBuf = handleBuffer();
        try {
            const state = lib.symbols.duckdb_open_ext(
                cstr("/nonexistent-dir-ax-duckdb-ffi-test/db.duckdb"),
                ptr(db),
                0n,
                ptr(errorBuf),
            );
            expect(state).not.toBe(DUCKDB_SUCCESS);
            const errorPtr = errorBuf[0]!;
            expect(typeof errorPtr).toBe("bigint");
            const message = readCString(errorPtr);
            expect(message).not.toBeNull();
            expect(message).not.toContain("ERR_INVALID_ARG_TYPE");
            expect(message).toContain("nonexistent-dir-ax-duckdb-ffi-test");
            // duckdb_open_ext's out_error is caller-owned, like duckdb_value_varchar.
            lib.symbols.duckdb_free(Number(errorPtr) as never);
        } finally {
            lib.symbols.duckdb_close(ptr(db));
            lib.close();
        }
    });
});
