/**
 * Materialize the committed SQLite seed fixtures (#876).
 *
 * The SQLite-backed providers (OpenCode, Cursor) have no in-memory seam below
 * `extract*(dbPath)`, so their corpus fixtures are committed as JSON seeds -
 * diffable and sanitizable - and this module writes them into a throwaway
 * SQLite file with the same table shapes the real stores use (OpenCode's
 * drizzle "observed" schema; Cursor's cursorDiskKV key/value store).
 */
import { Database } from "bun:sqlite";

export interface OpenCodeSeedSession {
    readonly id: string;
    readonly directory: string;
    readonly title: string;
    readonly time_created: number;
    readonly time_updated: number;
    readonly parent_id?: string | null;
    readonly version?: string | null;
    readonly model?: string | null;
}

export interface OpenCodeSeedMessage {
    readonly id: string;
    readonly session_id: string;
    readonly time_created: number;
    readonly time_updated: number;
    readonly data: string;
}

export interface OpenCodeSeedPart {
    readonly id: string;
    readonly message_id: string;
    readonly session_id: string;
    readonly time_created: number;
    readonly time_updated: number;
    readonly data: string;
}

export interface OpenCodeSeed {
    readonly sessions: readonly OpenCodeSeedSession[];
    readonly messages: readonly OpenCodeSeedMessage[];
    readonly parts: readonly OpenCodeSeedPart[];
}

export const materializeOpenCodeSeed = (seed: OpenCodeSeed, dbPath: string): void => {
    const db = new Database(dbPath, { create: true });
    try {
        db.exec(`
            CREATE TABLE session (
                id TEXT PRIMARY KEY,
                parent_id TEXT,
                directory TEXT NOT NULL,
                title TEXT NOT NULL,
                version TEXT,
                model TEXT,
                time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL
            );
            CREATE TABLE message (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL,
                data TEXT NOT NULL
            );
            CREATE TABLE part (
                id TEXT PRIMARY KEY,
                message_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL,
                data TEXT NOT NULL
            );
        `);
        const insertSession = db.prepare(
            "INSERT INTO session (id, parent_id, directory, title, version, model, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        );
        for (const row of seed.sessions) {
            insertSession.run(
                row.id, row.parent_id ?? null, row.directory, row.title,
                row.version ?? null, row.model ?? null, row.time_created, row.time_updated,
            );
        }
        const insertMessage = db.prepare(
            "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
        );
        for (const row of seed.messages) {
            insertMessage.run(row.id, row.session_id, row.time_created, row.time_updated, row.data);
        }
        const insertPart = db.prepare(
            "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
        );
        for (const row of seed.parts) {
            insertPart.run(row.id, row.message_id, row.session_id, row.time_created, row.time_updated, row.data);
        }
    } finally {
        db.close();
    }
};

export interface CursorSeed {
    readonly cursorDiskKV: ReadonlyArray<{ readonly key: string; readonly value: string }>;
}

export const materializeCursorSeed = (seed: CursorSeed, dbPath: string): void => {
    const db = new Database(dbPath, { create: true });
    try {
        db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
        const insert = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
        for (const row of seed.cursorDiskKV) insert.run(row.key, row.value);
    } finally {
        db.close();
    }
};
