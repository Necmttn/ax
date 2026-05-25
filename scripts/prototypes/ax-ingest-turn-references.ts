#!/usr/bin/env bun
// PROTOTYPE - derive first-class graph references from turn/tool-call text.
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
    toolFileRelationRecordKey,
} from "../../src/ingest/record-keys.ts";
import {
    classifyToolFileEvidence,
    evidenceReason,
    type ToolFileEvidenceKind,
} from "../../src/ingest/tool-file-evidence.ts";

const cfg = {
    url: process.env.AX_DB_URL ?? "ws://127.0.0.1:8521",
    ns: process.env.AX_DB_NS ?? "ax",
    db: process.env.AX_DB_DB ?? "main",
    user: process.env.AX_DB_USER ?? "root",
    pass: process.env.AX_DB_PASS ?? "root",
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

interface ToolCallRow {
    readonly id: string;
    readonly turn?: string | null;
    readonly session: string;
    readonly repository?: string | null;
    readonly workspace?: string | null;
    readonly ts?: string | null;
    readonly name: string;
    readonly command_norm?: string | null;
    readonly input_json?: string | null;
    readonly command_text?: string | null;
    readonly output_excerpt?: string | null;
    readonly error_text?: string | null;
}

interface ReferenceSource {
    readonly turnId: string;
    readonly repository?: string | null;
    readonly workspace?: string | null;
    readonly ts?: string | null;
    readonly text: string;
    readonly source: "text" | "tool_input" | "tool_output";
}

interface FileRow {
    readonly id: string;
    readonly path: string;
}

interface ResolvedReference {
    readonly refs: ReturnType<typeof extractTurnReferences>;
    readonly excerpt: string;
    readonly files: readonly FileRow[];
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
const SOURCES = ["text", "tool_input", "tool_output"] as const;

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

async function deleteMentionEdges(db: Surreal, turnIds: readonly string[], sources: readonly typeof SOURCES[number][]): Promise<number> {
    if (turnIds.length === 0 || sources.length === 0) return 0;
    const sourceList = sources.map(sqlString).join(", ");
    let deleted = 0;
    for (const table of ["mentioned_file", "mentioned_symbol", "mentioned_error"]) {
        const [rows] = await db.query<[unknown[]]>(`
            DELETE ${table}
            WHERE in IN [${turnIds.join(", ")}]
              AND source IN [${sourceList}]
            RETURN BEFORE;
        `);
        deleted += Array.isArray(rows) ? rows.length : 0;
    }
    return deleted;
}

async function deleteToolFileEvidenceEdges(db: Surreal, toolCallIds: readonly string[]): Promise<number> {
    if (toolCallIds.length === 0) return 0;
    let deleted = 0;
    for (const table of ["read_file", "searched_file"]) {
        const [rows] = await db.query<[unknown[]]>(`
            DELETE ${table}
            WHERE in IN [${toolCallIds.join(", ")}]
            RETURN BEFORE;
        `);
        deleted += Array.isArray(rows) ? rows.length : 0;
    }
    return deleted;
}

async function loadTurns(db: Surreal): Promise<TurnRow[]> {
    const session = argValue("--session");
    const limit = Number(argValue("--limit") ?? "200");
    const where = [
        'message_kind = "task"',
        "text IS NOT NONE",
        'intent_kind IN ["organic_task", "correction", "preference"]',
        'session.source != "claude-subagent"',
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

async function loadToolCalls(db: Surreal): Promise<ToolCallRow[]> {
    const session = argValue("--session");
    const limit = Number(argValue("--tool-limit") ?? argValue("--limit") ?? "200");
    const where = [
        "turn IS NOT NONE",
        'session.source != "claude-subagent"',
        "(input_json IS NOT NONE OR command_text IS NOT NONE OR output_excerpt IS NOT NONE OR error_text IS NOT NONE)",
    ];
    if (session) where.push(`session = session:\`${session.replace(/`/g, "")}\``);
    const [rows] = await db.query<[ToolCallRow[]]>(`
        SELECT
            <string>id AS id,
            <string>turn AS turn,
            <string>session AS session,
            <string>session.repository AS repository,
            <string>session.workspace AS workspace,
            <string>ts AS ts,
            name,
            command_norm,
            input_json,
            command_text,
            output_excerpt,
            error_text
        FROM tool_call
        WHERE ${where.join(" AND ")}
        ORDER BY ts DESC
        LIMIT ${Number.isFinite(limit) && limit > 0 ? Math.min(limit, 5000) : 200};
    `);
    return rows.filter((row) => typeof row.turn === "string" && row.turn.length > 0);
}

async function findFileRows(db: Surreal, source: Pick<ReferenceSource, "repository" | "workspace">, paths: readonly string[]): Promise<FileRow[]> {
    const clean = Array.from(new Set(paths.map((path) => path.trim()).filter(Boolean))).slice(0, 32);
    if (clean.length === 0) return [];
    const scope = source.repository?.startsWith("repository:")
        ? `repository = ${source.repository} AND `
        : source.workspace?.startsWith("workspace:")
          ? `workspace = ${source.workspace} AND `
          : "";
    const hasScope = scope.length > 0;
    const clauses = clean.flatMap((path) => {
        const base = path.split("/").at(-1) ?? path;
        const pathClauses = [
            `path = ${sqlString(path)}`,
        ];
        if (hasScope && path.includes("/")) {
            pathClauses.push(`string::ends_with(path, ${sqlString(path)})`);
        }
        if (hasScope && path.includes("/") && !GENERIC_BASENAMES.has(base)) {
            pathClauses.push(`string::ends_with(path, ${sqlString(base)})`);
        }
        return pathClauses;
    });
    const [rows] = await db.query<[FileRow[]]>(`
        SELECT <string>id AS id, path
        FROM file
        WHERE ${scope}(${clauses.join(" OR ")})
        LIMIT 50;
    `);
    return rows;
}

async function resolveReferences(db: Surreal, source: ReferenceSource): Promise<ResolvedReference | null> {
    if (source.text.trim().length === 0) return null;
    const refs = extractTurnReferences(source.text);
    const excerpt = clip(source.text.replace(/\s+/g, " "));
    const files = await findFileRows(db, source, refs.files);
    return { refs, excerpt, files };
}

async function ingestReferences(db: Surreal, source: ReferenceSource): Promise<{ files: number; symbols: number; errors: number }> {
    const resolved = await resolveReferences(db, source);
    if (!resolved) return { files: 0, symbols: 0, errors: 0 };
    const { refs, excerpt, files: fileRows } = resolved;
    let files = 0;
    let symbols = 0;
    let errors = 0;

    for (const file of fileRows) {
        const edgeKey = mentionedRelationRecordKey({
            turnKey: recordKey(source.turnId),
            targetKey: recordKey(file.id),
            source: source.source,
        });
        await db.query(`
            RELATE ${source.turnId}->mentioned_file:\`${edgeKey}\`->${file.id}
            SET source = ${sqlString(source.source)}, confidence = 0.85, excerpt = ${sqlString(excerpt)}, ts = d"${source.ts ?? new Date().toISOString()}";
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
            turnKey: recordKey(source.turnId),
            targetKey: symbolKey,
            source: source.source,
        });
        await db.query(`
            RELATE ${source.turnId}->mentioned_symbol:\`${edgeKey}\`->symbol:\`${symbolKey}\`
            SET source = ${sqlString(source.source)}, confidence = 0.75, excerpt = ${sqlString(excerpt)}, ts = d"${source.ts ?? new Date().toISOString()}";
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
            turnKey: recordKey(source.turnId),
            targetKey: errorKey,
            source: source.source,
        });
        await db.query(`
            RELATE ${source.turnId}->mentioned_error:\`${edgeKey}\`->error_signature:\`${errorKey}\`
            SET source = ${sqlString(source.source)}, confidence = 0.9, excerpt = ${sqlString(excerpt)}, ts = d"${source.ts ?? new Date().toISOString()}";
        `);
        errors += 1;
    }

    return { files, symbols, errors };
}

async function ingestTurnReferences(db: Surreal, turn: TurnRow): Promise<{ files: number; symbols: number; errors: number }> {
    return ingestReferences(db, {
        turnId: turn.id,
        repository: turn.repository ?? null,
        workspace: turn.workspace ?? null,
        ts: turn.ts ?? null,
        text: turn.text ?? turn.text_excerpt ?? "",
        source: "text",
    });
}

async function ingestToolCallReferences(db: Surreal, tool: ToolCallRow): Promise<{ files: number; symbols: number; errors: number }> {
    if (!tool.turn) return { files: 0, symbols: 0, errors: 0 };
    const inputText = [tool.command_text, tool.input_json].filter((value): value is string => !!value).join("\n");
    const outputText = [tool.error_text, tool.output_excerpt].filter((value): value is string => !!value).join("\n");
    const inputCounts = await ingestReferences(db, {
        turnId: tool.turn,
        repository: tool.repository ?? null,
        workspace: tool.workspace ?? null,
        ts: tool.ts ?? null,
        text: inputText,
        source: "tool_input",
    });
    const outputCounts = await ingestReferences(db, {
        turnId: tool.turn,
        repository: tool.repository ?? null,
        workspace: tool.workspace ?? null,
        ts: tool.ts ?? null,
        text: outputText,
        source: "tool_output",
    });
    return {
        files: inputCounts.files + outputCounts.files,
        symbols: inputCounts.symbols + outputCounts.symbols,
        errors: inputCounts.errors + outputCounts.errors,
    };
}

async function relateToolFileEvidence(
    db: Surreal,
    tool: ToolCallRow,
    kind: ToolFileEvidenceKind,
    source: ReferenceSource,
): Promise<number> {
    const resolved = await resolveReferences(db, source);
    if (!resolved) return 0;
    const reason = evidenceReason({ name: tool.name, commandNorm: tool.command_norm ?? null }, kind);
    let count = 0;
    for (const file of resolved.files) {
        const edgeKey = toolFileRelationRecordKey({
            toolCallKey: recordKey(tool.id),
            fileKey: recordKey(file.id),
            kind,
        });
        await db.query(`
            RELATE ${tool.id}->${kind}:\`${edgeKey}\`->${file.id}
            SET evidence = ${sqlString(reason)}, path_seen = ${sqlString(file.path)}, excerpt = ${sqlString(resolved.excerpt)}, ts = d"${tool.ts ?? new Date().toISOString()}";
        `);
        count += 1;
    }
    return count;
}

async function ingestToolFileEvidence(db: Surreal, tool: ToolCallRow): Promise<{ read_files: number; searched_files: number }> {
    if (!tool.turn) return { read_files: 0, searched_files: 0 };
    const kinds = classifyToolFileEvidence({ name: tool.name, commandNorm: tool.command_norm ?? null });
    if (kinds.length === 0) return { read_files: 0, searched_files: 0 };

    const inputSource: ReferenceSource = {
        turnId: tool.turn,
        repository: tool.repository ?? null,
        workspace: tool.workspace ?? null,
        ts: tool.ts ?? null,
        text: [tool.command_text, tool.input_json].filter((value): value is string => !!value).join("\n"),
        source: "tool_input",
    };
    const outputSource: ReferenceSource = {
        turnId: tool.turn,
        repository: tool.repository ?? null,
        workspace: tool.workspace ?? null,
        ts: tool.ts ?? null,
        text: [tool.error_text, tool.output_excerpt].filter((value): value is string => !!value).join("\n"),
        source: "tool_output",
    };

    let readFiles = 0;
    let searchedFiles = 0;
    for (const kind of kinds) {
        const inputCount = await relateToolFileEvidence(db, tool, kind, inputSource);
        const outputCount = kind === "searched_file"
            ? await relateToolFileEvidence(db, tool, kind, outputSource)
            : 0;
        if (kind === "read_file") readFiles += inputCount;
        if (kind === "searched_file") searchedFiles += inputCount + outputCount;
    }

    return { read_files: readFiles, searched_files: searchedFiles };
}

async function main() {
    const db = await connect();
    try {
        const turns = await loadTurns(db);
        const includeTools = process.argv.includes("--include-tools");
        const toolCalls = includeTools ? await loadToolCalls(db) : [];
        const turnIds = Array.from(new Set(turns.map((turn) => turn.id)));
        const toolTurnIds = Array.from(new Set(toolCalls.map((tool) => tool.turn).filter((id): id is string => !!id)));
        const toolCallIds = Array.from(new Set(toolCalls.map((tool) => tool.id)));
        const deletedMentionEdges = (await deleteMentionEdges(db, turnIds, ["text"]))
            + (includeTools ? await deleteMentionEdges(db, toolTurnIds, ["tool_input", "tool_output"]) : 0);
        const deletedToolFileEdges = includeTools ? await deleteToolFileEvidenceEdges(db, toolCallIds) : 0;
        const totals = {
            turns: turns.length,
            tool_calls: toolCalls.length,
            deleted_mention_edges: deletedMentionEdges,
            deleted_tool_file_edges: deletedToolFileEdges,
            files: 0,
            symbols: 0,
            errors: 0,
            read_files: 0,
            searched_files: 0,
        };
        for (const turn of turns) {
            const counts = await ingestTurnReferences(db, turn);
            totals.files += counts.files;
            totals.symbols += counts.symbols;
            totals.errors += counts.errors;
        }
        for (const toolCall of toolCalls) {
            const counts = await ingestToolCallReferences(db, toolCall);
            totals.files += counts.files;
            totals.symbols += counts.symbols;
            totals.errors += counts.errors;
            const evidence = await ingestToolFileEvidence(db, toolCall);
            totals.read_files += evidence.read_files;
            totals.searched_files += evidence.searched_files;
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
