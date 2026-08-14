#!/bin/bash
# Verify: a reader holding snapshot.duckdb open (read-only) survives a writer
# rebuilding + atomically renaming a NEW snapshot over the same path (POSIX
# rename-over-open-file semantics: old fd keeps the old inode; a fresh open
# after the rename sees the new file).
set -eu
cd "$(dirname "$0")"
DUCKDB=/private/tmp/claude-501/-Users-necmttn-Projects-ax/804f55a8-97eb-4c19-8b56-9e49dd1cffd9/scratchpad/spike-b/duckdb/build/release/duckdb

rm -f snapshot.duckdb snapshot_v2.duckdb reader_out.txt
cp bench.duckdb snapshot.duckdb  # stand-in snapshot v1 (already compacted copy exists too; this is just for the fd test)

FIFO=/tmp/duckdb_reader_fifo.$$
mkfifo "$FIFO"

# Start a reader against snapshot.duckdb, fed by the FIFO, output captured.
( "$DUCKDB" -readonly snapshot.duckdb < "$FIFO" > reader_out.txt 2>&1 ) &
READER_PID=$!

exec 3>"$FIFO"   # keep the write end open so the FIFO doesn't EOF between statements

echo "before_rename: $(stat -f%i snapshot.duckdb)"
echo "SELECT 'before_rename' AS phase, count(*) AS n FROM turn;" >&3
sleep 1

# Writer: build a fresh snapshot under a temp name, then atomically rename over the original path.
cp bench.duckdb snapshot_v2.duckdb
INODE_BEFORE=$(stat -f%i snapshot.duckdb)
mv -f snapshot_v2.duckdb snapshot.duckdb
INODE_AFTER_ON_DISK=$(stat -f%i snapshot.duckdb)

echo "SELECT 'after_rename_same_conn' AS phase, count(*) AS n FROM turn;" >&3
sleep 1

exec 3>&-  # close write end -> reader sees EOF and exits
wait "$READER_PID" 2>/dev/null || true

echo "--- reader output (same held-open connection across the rename) ---"
cat reader_out.txt

echo "--- inode check ---"
echo "on-disk inode before rename: $INODE_BEFORE"
echo "on-disk inode after rename : $INODE_AFTER_ON_DISK (should differ -- new file)"

echo "--- fresh reader after rename (should see NEW file/inode) ---"
"$DUCKDB" -readonly -c "SELECT 'fresh_open_after_rename' AS phase, count(*) AS n FROM turn;" snapshot.duckdb

rm -f "$FIFO"
