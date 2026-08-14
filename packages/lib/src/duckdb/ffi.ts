/**
 * Raw `bun:ffi` bindings for the libduckdb C API. No Effect, no policy - the
 * bare symbol table plus the handle conventions the rest of the module relies
 * on.
 *
 * THE HANDLE GOTCHA (solved in scripts/duckdb-spike/ffi/duckdb-ffi.ts):
 * `duckdb_database`, `duckdb_connection`, `duckdb_config` and
 * `duckdb_prepared_statement` are opaque `void *` typedefs. In ARGUMENT
 * position they are passed BY VALUE, so they bind as `u64` and are read out of
 * a `BigUint64Array`. In OUT-PARAM position they are real pointers and bind as
 * `ptr`. Mixing the two up corrupts the handle and segfaults.
 *
 * Everything here takes `duckdb_result *`. The chunk API
 * (`duckdb_fetch_chunk`, `duckdb_result_chunk_count`) takes the 48-byte
 * `duckdb_result` struct BY VALUE, which `bun:ffi` cannot express, so the
 * row-major `duckdb_value_*` accessors are the only reachable read path.
 *
 * DEPRECATED-SYMBOL GUARD: the `duckdb_value_*` accessors AND
 * `duckdb_row_count` (duckdb.h `#ifndef DUCKDB_API_NO_DEPRECATED`) are marked
 * deprecated in duckdb.h and are absent from a dylib built with
 * `DUCKDB_API_NO_DEPRECATED`. `dlopen` resolves every symbol in `SYMBOLS`
 * eagerly and throws synchronously the moment one is missing, so opening such
 * a dylib fails loudly here (a plain JS `Error` naming the symbol) instead of
 * segfaulting on first call.
 */
import { CString, dlopen, FFIType } from "bun:ffi";

const { i32, u64, f64, bool, ptr: PTR, cstring, void: VOID } = FFIType;

/** `duckdb_result` is 48 bytes in duckdb.h; 64 leaves headroom. */
export const DUCKDB_RESULT_SIZE = 64;
/** `DuckDBSuccess` from `duckdb_state`. */
export const DUCKDB_SUCCESS = 0;

const SYMBOLS = {
    // --- lifecycle -------------------------------------------------------
    duckdb_open_ext: { args: [cstring, PTR, u64, PTR], returns: i32 },
    duckdb_close: { args: [PTR], returns: VOID },
    duckdb_connect: { args: [u64, PTR], returns: i32 },
    duckdb_disconnect: { args: [PTR], returns: VOID },
    // --- config ----------------------------------------------------------
    duckdb_create_config: { args: [PTR], returns: i32 },
    duckdb_set_config: { args: [u64, cstring, cstring], returns: i32 },
    duckdb_destroy_config: { args: [PTR], returns: VOID },
    // --- statements ------------------------------------------------------
    duckdb_query: { args: [u64, cstring, PTR], returns: i32 },
    duckdb_prepare: { args: [u64, cstring, PTR], returns: i32 },
    // `PTR`, not `cstring` (matches `duckdb_result_error`): `cstring` decodes
    // to a `CString` object, and a NULL `cstring` return decodes to `""`
    // rather than null - collapsing "no error" with "empty error". `PTR`
    // keeps the raw pointer so `readCString` can tell the two apart.
    duckdb_prepare_error: { args: [u64], returns: PTR },
    duckdb_destroy_prepare: { args: [PTR], returns: VOID },
    duckdb_execute_prepared: { args: [u64, PTR], returns: i32 },
    duckdb_bind_boolean: { args: [u64, u64, bool], returns: i32 },
    duckdb_bind_int64: { args: [u64, u64, FFIType.i64], returns: i32 },
    duckdb_bind_double: { args: [u64, u64, f64], returns: i32 },
    duckdb_bind_varchar: { args: [u64, u64, cstring], returns: i32 },
    duckdb_bind_null: { args: [u64, u64], returns: i32 },
    // --- results ---------------------------------------------------------
    duckdb_destroy_result: { args: [PTR], returns: VOID },
    duckdb_result_error: { args: [PTR], returns: PTR },
    duckdb_row_count: { args: [PTR], returns: u64 },
    duckdb_rows_changed: { args: [PTR], returns: u64 },
    duckdb_column_count: { args: [PTR], returns: u64 },
    duckdb_column_name: { args: [PTR, u64], returns: PTR },
    duckdb_column_type: { args: [PTR, u64], returns: i32 },
    // --- row-major value accessors (deprecated in duckdb.h - see guard note
    // above) --------------------------------------------------------------
    duckdb_value_boolean: { args: [PTR, u64, u64], returns: bool },
    duckdb_value_int64: { args: [PTR, u64, u64], returns: FFIType.i64 },
    duckdb_value_uint64: { args: [PTR, u64, u64], returns: u64 },
    duckdb_value_double: { args: [PTR, u64, u64], returns: f64 },
    // The returned `char *` is a fresh allocation OWNED BY THE CALLER - it
    // must be released with `duckdb_free` after reading, or every decoded
    // cell leaks. Bound `PTR` (not `cstring`) precisely so the caller gets
    // the raw pointer back to free, instead of bun eagerly copying it into a
    // `CString` and discarding the pointer.
    duckdb_value_varchar: { args: [PTR, u64, u64], returns: PTR },
    duckdb_value_is_null: { args: [PTR, u64, u64], returns: bool },
    duckdb_free: { args: [PTR], returns: VOID },
} as const;

export type LibDuckDb = ReturnType<typeof dlopen<typeof SYMBOLS>>;

/** `dlopen` libduckdb with the full symbol table. Throws on a missing symbol. */
export const openLibDuckDb = (dylibPath: string): LibDuckDb => dlopen(dylibPath, SYMBOLS);

/** Backing store for one opaque handle (database / connection / statement). */
export const handleBuffer = (): BigUint64Array => new BigUint64Array(1);

/** NUL-terminated buffer for a `const char *` argument. */
export const cstr = (s: string): Buffer => Buffer.from(`${s}\0`, "utf8");

/**
 * Read a `char *` return value, or null when the pointer is null.
 *
 * `p` is typically a `Pointer` (number) from a `PTR`-typed return, but is
 * also `bigint` when read out of a `BigUint64Array` (e.g. an out-param
 * handle buffer, or `duckdb_open_ext`'s `char **out_error`). `CString`'s
 * constructor only accepts its branded `Pointer` (number) type - handing it
 * a `bigint` neither decodes nor throws, it silently returns
 * `"TypeError [ERR_INVALID_ARG_TYPE]: ptr must be a number."` as if that
 * were the string content. `Number(p)` is lossless here: real pointers are
 * well under 2^53.
 */
export const readCString = (p: number | bigint | null | undefined): string | null => {
    if (p === null || p === undefined || p === 0 || p === 0n) return null;
    return new CString(Number(p) as never).toString();
};
