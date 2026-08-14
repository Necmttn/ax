// Shared end-to-end duckdb C-API exercise, reused by phase1 (source mode)
// and phase2 (compiled binary mode).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDuckDB, DUCKDB_RESULT_SIZE, ptr, CString } from "./duckdb-ffi";

export function runDuckDBRoundTrip(dylibPath: string, log: (s: string) => void) {
  log(`loading dylib from: ${dylibPath}`);
  const { symbols } = openDuckDB(dylibPath);

  const workDir = mkdtempSync(join(tmpdir(), "ax-duckdb-spike-"));
  const dbPath = join(workDir, "spike.db");
  log(`db file path: ${dbPath}`);

  function checkState(state: number, label: string) {
    if (state !== 0) throw new Error(`${label} failed with duckdb_state=${state}`);
  }

  const dbHandleBuf = new BigUint64Array(1);
  const dbHandlePtr = ptr(dbHandleBuf);
  checkState(
    symbols.duckdb_open(Buffer.from(dbPath + "\0"), dbHandlePtr),
    "duckdb_open",
  );
  log("duckdb_open OK");

  const connHandleBuf = new BigUint64Array(1);
  const connHandlePtr = ptr(connHandleBuf);
  checkState(
    symbols.duckdb_connect(dbHandleBuf[0], connHandlePtr),
    "duckdb_connect",
  );
  log("duckdb_connect OK");
  const connHandle = connHandleBuf[0];

  function runQuery(sql: string) {
    const resultBuf = new Uint8Array(DUCKDB_RESULT_SIZE);
    const resultPtr = ptr(resultBuf);
    const state = symbols.duckdb_query(connHandle, Buffer.from(sql + "\0"), resultPtr);
    if (state !== 0) {
      const errPtr = symbols.duckdb_result_error(resultPtr);
      const msg = errPtr ? new CString(errPtr as any).toString() : "(no message)";
      symbols.duckdb_destroy_result(resultPtr);
      throw new Error(`query failed: ${sql}\n  -> ${msg}`);
    }
    return resultPtr;
  }

  let res = runQuery("CREATE TABLE spike (id INTEGER, note VARCHAR)");
  symbols.duckdb_destroy_result(res);
  log("CREATE TABLE OK");

  res = runQuery("INSERT INTO spike VALUES (1, 'bun-ffi-duckdb-spike-value')");
  symbols.duckdb_destroy_result(res);
  log("INSERT OK");

  res = runQuery("SELECT id, note FROM spike WHERE id = 1");
  const rowCount = symbols.duckdb_row_count(res);
  const colCount = symbols.duckdb_column_count(res);
  log(`SELECT returned rowCount=${rowCount} colCount=${colCount}`);
  if (rowCount !== 1n) throw new Error(`expected 1 row, got ${rowCount}`);

  const valPtr = symbols.duckdb_value_varchar(res, 1n, 0n);
  if (!valPtr) throw new Error("duckdb_value_varchar returned null");
  const value = new CString(valPtr as any).toString();
  symbols.duckdb_free(valPtr);
  symbols.duckdb_destroy_result(res);
  log(`SELECT value = ${JSON.stringify(value)}`);

  if (value !== "bun-ffi-duckdb-spike-value") {
    throw new Error(`unexpected value read back: ${value}`);
  }

  symbols.duckdb_disconnect(connHandlePtr);
  log("duckdb_disconnect OK");
  symbols.duckdb_close(dbHandlePtr);
  log("duckdb_close OK");

  rmSync(workDir, { recursive: true, force: true });
  return value;
}
