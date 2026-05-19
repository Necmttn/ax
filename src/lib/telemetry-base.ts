import { createHash } from "node:crypto";
import { Effect } from "effect";
import { RecordId } from "surrealdb";
import { SurrealClient } from "./db.ts";
import type { DbError } from "./errors.ts";

export type TelemetryHarness = "claude" | "codex" | "unknown";

export interface TelemetryBaseRow {
    readonly id: string;
    readonly ts: Date;
    readonly kind: string;
    readonly session?: string | undefined;
    readonly file?: string | undefined;
    readonly file_path: string;
    readonly harness: TelemetryHarness;
    readonly ok: boolean;
    readonly latency_ms: number;
}

export function deterministicId(parts: readonly string[]): string {
    return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
}

function parseRecordRef(value: string | undefined): RecordId | null {
    if (!value) return null;
    const idx = value.indexOf(":");
    if (idx < 0) return null;
    const table = value.slice(0, idx);
    const id = value.slice(idx + 1).replace(/^⟨|⟩$/g, "");
    if (!table || !id) return null;
    return new RecordId(table, id);
}

export const writeTelemetryRow = <T extends TelemetryBaseRow>(
    table: string,
    row: T,
): Effect.Effect<void, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const { id, session, file, ...rest } = row;
        const sessionRid = parseRecordRef(session);
        const fileRid = parseRecordRef(file);
        const content: Record<string, unknown> = { ...rest };
        if (sessionRid) content.session = sessionRid;
        if (fileRid) content.file = fileRid;
        yield* db.upsert(new RecordId(table, id), content);
    });
