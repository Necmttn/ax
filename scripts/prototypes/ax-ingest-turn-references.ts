#!/usr/bin/env bun
// PROTOTYPE - derive first-class graph references from turn text.
// Emits turn -> mentioned_file/symbol/error edges so context injection can use
// graph traversal instead of repeatedly fuzzy-scanning raw transcript text.

import { Surreal } from "surrealdb";
import {
    classifySymbolKind,
    extractTurnReferences,
    normalizeErrorSignature,
} from "../../src/ingest/turn-references.ts";
import {
    errorSignatureRecordKey,
    mentionedRelationRecordKey,
    symbolRecordKey,
} from "../../src/ingest/record-keys.ts";

const cfg = {
    url: process.env.AX_DB_URL ?? process.env.AGENTCTL_DB_URL ?? "ws://127.0.0.1:8521",
    ns: process.env.AX_DB_NS ?? process.env.AGENTCTL_DB_NS ?? "ax",
    db: process.env.AX_DB_DB ?? process.env.AGENTCTL_DB_DB ?? "main",
    user: process.env.AX_DB_USER ?? process.env.AGENTCTL_DB_USER ?? "root",
    pass: process.env.AX_DB_PASS ?? process.env.AGENTCTL_DB_PASS ?? "root",
};

interface TurnRow {
    readonly id: string;
    readonly session: string;
    readonly repository?: string | null;
    readonly workspace?: string | null;
    readonly seq?: number | null;
    readonly ts?: string | null;
    readonly intent_kind?: string | null;
    readonly text?: string | null;
    readonly text_excerpt?: string | null;
}

interface FileRow {
    readonly id: string;
    readonly path: string;
}

const argValue = (name: string): string | null => {
    const eq = process.argv.find((arg) => arg.startsWith(`${name}=`));
    if (eq) return eq.slice(name.length + 1);
    const index = process.argv.indexOf(name);
    return index >= 0 ? (process.argv[index + 1] ?? null) : null;
};

const sqlString = (value: string): string => JSON.stringify(value);
const clip = (value: string, n = 240): string => (value.length <= n ? value : `${value.slice(0, n - 1)}...`);
const GENERIC_BASENAMES = new Set(["index.ts", "index.tsx", "index.js", "README.md", "package.json", "tsconfig.json"]);

async function connect(): Promise<Surreal> {
    const db = new Surreal();
    await db.connect(cfg.url);
    await db.signin({ username: cfg.user, password: cfg.pass });
    await db.use({ namespace: cfg.ns, database: cfg.db });
    return db;
}

function recordKey(recordId: string): string {
    const match = recordId.match(/^[a-z_]+:`?([^`]+)`?$/);
    return match?.[1] ?? recordId;
}

async function loadTurns(db: Surreal): Promise<TurnRow[]> {
    const session = argValue("--session");
    const limit = Number(argValue("--limit") ?? "200");
    const where = [
        'message_kind = "task"',
        "text IS NOT NONE",
        'intent_kind IN ["organic_task", "correction", "preference"]',
    ];
    if (session) where.push(`session = session:\`${session.replace(/`/g, "")}\``);
    const [rows] = await db.query<[TurnRow[]]>(`
        SELECT
            <string>id AS id,
            <string>session AS session,
            <string>session.repository AS repository,
            <string>session.workspace AS workspace,
            seq,
            <string>ts AS ts,
            intent_kind,
            text,
            text_excerpt
        FROM turn
        WHERE ${where.join(" AND ")}
        ORDER BY ts DESC
        LIMIT ${Number.isFinite(limit) && limit > 0 ? Math.min(limit, 5000) : 200};
    `);
    return rows;
}

async function findFileRows(db: Surreal, turn: TurnRow, paths: readonly string[]): Promise<FileRow[]> {
    const clean = Array.from(new Set(paths.map((path) => path.trim()).filter(Boolean))).slice(0, 32);
    if (clean.length === 0) return [];
    const clauses = clean.flatMap((path) => {
        const base = path.split("/").at(-1) ?? path;
        const pathClauses = [
            `path = ${sqlString(path)}`,
            `string::ends_with(path, ${sqlString(path)})`,
        ];
        if (path.includes("/") && !GENERIC_BASENAMES.has(base)) {
            pathClauses.push(`string::ends_with(path, ${sqlString(base)})`);
        }
        return pathClauses;
    });
    const scope = turn.repository?.startsWith("repository:")
        ? `repository = ${turn.repository} AND `
        : turn.workspace?.startsWith("workspace:")
          ? `workspace = ${turn.workspace} AND `
          : "";
    const [rows] = await db.query<[FileRow[]]>(`
        SELECT <string>id AS id, path
        FROM file
        WHERE ${scope}(${clauses.join(" OR ")})
        LIMIT 50;
    `);
    return rows;
}

async function ingestTurnReferences(db: Surreal, turn: TurnRow): Promise<{ files: number; symbols: number; errors: number }> {
    const text = turn.text ?? turn.text_excerpt ?? "";
    const refs = extractTurnReferences(text);
    const excerpt = clip(text.replace(/\s+/g, " "));
    let files = 0;
    let symbols = 0;
    let errors = 0;

    for (const file of await findFileRows(db, turn, refs.files)) {
        const edgeKey = mentionedRelationRecordKey({
            turnKey: recordKey(turn.id),
            targetKey: recordKey(file.id),
            source: "text",
        });
        await db.query(`
            RELATE ${turn.id}->mentioned_file:\`${edgeKey}\`->${file.id}
            SET source = "text", confidence = 0.85, excerpt = ${sqlString(excerpt)}, ts = d"${turn.ts ?? new Date().toISOString()}";
        `);
        files += 1;
    }

    for (const symbol of refs.symbols) {
        const symbolKey = symbolRecordKey(symbol);
        await db.query(`
            UPSERT symbol:\`${symbolKey}\` CONTENT {
                name: ${sqlString(symbol)},
                kind: ${sqlString(classifySymbolKind(symbol))},
                created_at: time::now()
            };
        `);
        const edgeKey = mentionedRelationRecordKey({
            turnKey: recordKey(turn.id),
            targetKey: symbolKey,
            source: "text",
        });
        await db.query(`
            RELATE ${turn.id}->mentioned_symbol:\`${edgeKey}\`->symbol:\`${symbolKey}\`
            SET source = "text", confidence = 0.75, excerpt = ${sqlString(excerpt)}, ts = d"${turn.ts ?? new Date().toISOString()}";
        `);
        symbols += 1;
    }

    for (const error of refs.errors) {
        const normalized = normalizeErrorSignature(error);
        const errorKey = errorSignatureRecordKey(normalized);
        await db.query(`
            UPSERT error_signature:\`${errorKey}\` CONTENT {
                text: ${sqlString(error)},
                normalized: ${sqlString(normalized)},
                created_at: time::now()
            };
        `);
        const edgeKey = mentionedRelationRecordKey({
            turnKey: recordKey(turn.id),
            targetKey: errorKey,
            source: "text",
        });
        await db.query(`
            RELATE ${turn.id}->mentioned_error:\`${edgeKey}\`->error_signature:\`${errorKey}\`
            SET source = "text", confidence = 0.9, excerpt = ${sqlString(excerpt)}, ts = d"${turn.ts ?? new Date().toISOString()}";
        `);
        errors += 1;
    }

    return { files, symbols, errors };
}

async function main() {
    const db = await connect();
    try {
        const turns = await loadTurns(db);
        const totals = { turns: turns.length, files: 0, symbols: 0, errors: 0 };
        for (const turn of turns) {
            const counts = await ingestTurnReferences(db, turn);
            totals.files += counts.files;
            totals.symbols += counts.symbols;
            totals.errors += counts.errors;
        }
        console.log(JSON.stringify(totals, null, 2));
    } finally {
        await db.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
