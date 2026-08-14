// Shared FFI binding module for the duckdb C API via bun:ffi.
// Exposes a small end-to-end surface: open (file db) -> connect -> query
// (CREATE TABLE / INSERT / SELECT) -> read a value back -> disconnect -> close.
import { dlopen, FFIType, ptr, CString, suffix } from "bun:ffi";

const { i32, u64, ptr: PTR, cstring } = FFIType;

export function openDuckDB(dylibPath: string) {
  const lib = dlopen(dylibPath, {
    duckdb_open: {
      args: [cstring, PTR], // (path, duckdb_database *out_database)
      returns: i32,
    },
    duckdb_close: {
      args: [PTR], // (duckdb_database *database)
      returns: FFIType.void,
    },
    duckdb_connect: {
      // (duckdb_database database [by-value opaque handle], duckdb_connection *out_connection [real ptr])
      args: [u64, PTR],
      returns: i32,
    },
    duckdb_disconnect: {
      args: [PTR], // (duckdb_connection *connection)
      returns: FFIType.void,
    },
    duckdb_query: {
      // (connection [by-value opaque handle], query, duckdb_result *out_result [real ptr])
      args: [u64, cstring, PTR],
      returns: i32,
    },
    duckdb_destroy_result: {
      args: [PTR], // (duckdb_result *result)
      returns: FFIType.void,
    },
    duckdb_result_error: {
      args: [PTR],
      returns: cstring,
    },
    duckdb_column_count: {
      args: [PTR],
      returns: u64,
    },
    duckdb_row_count: {
      args: [PTR],
      returns: u64,
    },
    duckdb_value_varchar: {
      args: [PTR, u64, u64], // (result, col, row)
      returns: PTR, // char* -- must be freed with duckdb_free, but we'll just read it
    },
    duckdb_free: {
      args: [PTR],
      returns: FFIType.void,
    },
  });
  return lib;
}

// duckdb_result struct layout (see duckdb.h):
//   idx_t deprecated_column_count;   // 8
//   idx_t deprecated_row_count;      // 8
//   idx_t deprecated_rows_changed;   // 8
//   duckdb_column *deprecated_columns; // 8
//   char *deprecated_error_message;  // 8
//   void *internal_data;             // 8
// total 48 bytes; round up for safety.
export const DUCKDB_RESULT_SIZE = 64;
// duckdb_database / duckdb_connection are single-pointer-sized opaque handles.
export const HANDLE_SIZE = 8;

export function readCStringFromPtr(p: bigint | number | null): string | null {
  if (p === null || p === 0 || p === 0n) return null;
  // @ts-expect-error - CString accepts a pointer value
  return new CString(p).toString();
}

export { ptr, FFIType, CString };
