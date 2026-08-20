/**
 * Harvest tool for the golden transcript corpus (#876).
 *
 * Pulls ONE real transcript per provider off this machine, sanitizes it, and
 * commits it as a fixture plus its replayed golden. Run from the repo root:
 *
 *   bun apps/axctl/src/ingest/golden-corpus/harvest.ts claude   <session.jsonl>
 *   bun apps/axctl/src/ingest/golden-corpus/harvest.ts codex    <rollout.jsonl>
 *   bun apps/axctl/src/ingest/golden-corpus/harvest.ts pi       <session.jsonl>
 *   bun apps/axctl/src/ingest/golden-corpus/harvest.ts omp      <session.jsonl> [--head=N]
 *   bun apps/axctl/src/ingest/golden-corpus/harvest.ts opencode <opencode.db> --session=<id>
 *   bun apps/axctl/src/ingest/golden-corpus/harvest.ts cursor   <state.vscdb> --composer=<id>
 *   bun apps/axctl/src/ingest/golden-corpus/harvest.ts regen
 *
 * `regen` re-derives every golden from the COMMITTED fixtures (no source
 * access) - the only sanctioned way to update goldens after an intentional
 * parser change.
 *
 * Sanitization: the fixture pretends to live in a fake `/Users/user` home.
 * The harvester rewrites this machine's home dir (both path and Claude
 * project-slug form), redacts emails, then runs `redactShareText` for secret
 * patterns. Review the fixture by eye before committing - the tool reduces
 * the leak surface, it does not replace review.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { Database } from "bun:sqlite";
import { redactShareText } from "../../share/redact.ts";
import type { CursorSeed, OpenCodeSeed } from "./materialize.ts";
import { replayClaude, replayCodex, replayCursor, replayOmp, replayOpenCode, replayPi } from "./replay.ts";
import { projectBatch, stableStringify } from "./serialize.ts";
import type { NormalizedTranscriptBatch } from "../normalized/transcripts.ts";

const ROOT = import.meta.dir;
const fixturePath = (name: string): string => join(ROOT, "fixtures", name);
const goldenPath = (name: string): string => join(ROOT, "golden", name);

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Private-project codenames -> neutral stand-ins. A fixture may only name
 * projects that are public repos; anything else is rewritten here. Both sides
 * are alphanumeric, so unlike the secret patterns this rewrite can never eat
 * a JSON escape. Extend the list whenever a harvest pulls in a new private
 * name - the residual scan does not know project names, so this list is the
 * only guard.
 */
const CODENAMES: ReadonlyArray<readonly [pattern: RegExp, replacement: string]> = [
    [/quera/gi, "acme"],
    [/herdr/gi, "muster"],
    [/ponto/gi, "zephyr"],
];

/** Carry the match's case shape onto the replacement (HERDR_ENV -> MUSTER_ENV). */
const matchCase = (source: string, target: string): string => {
    if (source === source.toUpperCase()) return target.toUpperCase();
    if (source[0] === source[0]?.toUpperCase()) return `${target[0]?.toUpperCase() ?? ""}${target.slice(1)}`;
    return target;
};

export const sanitizeText = (input: string): { text: string; rules: string[] } => {
    const rules = new Set<string>();
    let text = input;
    const home = homedir();
    if (home && home !== "/") {
        if (text.includes(home)) {
            text = text.replaceAll(home, "/Users/user");
            rules.add("home-path");
        }
        const slug = home.replace(/\//g, "-");
        if (text.includes(slug)) {
            text = text.replaceAll(slug, "-Users-user");
            rules.add("home-slug");
        }
    }
    if (EMAIL_PATTERN.test(text)) {
        text = text.replace(EMAIL_PATTERN, "user@example.invalid");
        rules.add("email");
    }
    for (const [pattern, replacement] of CODENAMES) {
        const next = text.replace(pattern, (m) => matchCase(m, replacement));
        if (next !== text) {
            text = next;
            rules.add(`codename:${replacement}`);
        }
    }
    const redacted = redactShareText(text);
    for (const rule of redacted.rules) rules.add(rule);
    return { text: redacted.text, rules: [...rules].sort() };
};

/** Residual-risk scan AFTER sanitization - loud, never silently ignored. */
const scanResiduals = (text: string): string[] => {
    const findings: string[] = [];
    const home = homedir();
    const user = basename(home);
    if (user && user !== "user" && text.toLowerCase().includes(user.toLowerCase())) {
        findings.push(`residual username '${user}' - check whether it is a public handle or a leak`);
    }
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) findings.push("residual PRIVATE KEY block");
    if (/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\./.test(text)) findings.push("residual JWT-shaped token");
    return findings;
};

const writeFixtureAndGolden = (
    fixtureName: string,
    goldenName: string,
    content: string,
    replay: (content: string) => NormalizedTranscriptBatch,
): void => {
    writeFileSync(fixturePath(fixtureName), content);
    const batch = replay(content);
    writeFileSync(goldenPath(goldenName), stableStringify(projectBatch(batch)));
    console.log(`wrote fixtures/${fixtureName} + golden/${goldenName}`);
    console.log(
        `  batch: ${batch.sessions.length} session(s), ${batch.events.length} events, ` +
            `${batch.turns.length} turns, ${batch.toolCalls.length} tool calls`,
    );
    for (const finding of scanResiduals(content)) console.log(`  ⚠ ${finding}`);
};

/**
 * Sanitize DECODED values, never the raw JSON line: `redactShareText`'s
 * secret-assignment pattern can swallow the escape character before an
 * escaped quote (`TOKEN=\"x\"`) and break the line's JSON-ness.
 */
const deepSanitize = (value: unknown, rules: Set<string>): unknown => {
    if (typeof value === "string") return sanitizeJsonScalar(value, rules);
    if (Array.isArray(value)) return value.map((item) => deepSanitize(item, rules));
    if (typeof value === "object" && value !== null) {
        return Object.fromEntries(
            Object.entries(value).map(([key, nested]) => [
                sanitizeJsonScalar(key, rules),
                deepSanitize(nested, rules),
            ]),
        );
    }
    return value;
};

const harvestJsonl = (
    provider: "claude" | "codex" | "pi" | "omp",
    sourcePath: string,
    head: number | null,
): void => {
    const raw = readFileSync(sourcePath, "utf8");
    let lines = raw.split("\n").filter((line) => line.trim().length > 0);
    if (head !== null) lines = lines.slice(0, head);
    const rules = new Set<string>();
    const sanitized = lines.map((line) => JSON.stringify(deepSanitize(JSON.parse(line), rules)));
    console.log(`sanitize rules fired: ${[...rules].sort().join(", ") || "(none)"}`);
    const content = `${sanitized.join("\n")}\n`;
    const replay = { claude: replayClaude, codex: replayCodex, pi: replayPi, omp: replayOmp }[provider];
    writeFixtureAndGolden(`${provider}.jsonl`, `${provider}.batch.json`, content, replay);
};

const sanitizeJsonScalar = (value: string, rules: Set<string>): string => {
    const out = sanitizeText(value);
    for (const rule of out.rules) rules.add(rule);
    return out.text;
};

const harvestOpenCode = (dbPath: string, sessionId: string): void => {
    const db = new Database(dbPath, { readonly: true });
    const rules = new Set<string>();
    try {
        const session = db
            .query<Record<string, unknown>, [string]>(
                "SELECT id, parent_id, directory, title, version, model, time_created, time_updated FROM session WHERE id = ?",
            )
            .get(sessionId);
        if (!session) throw new Error(`opencode session ${sessionId} not found in ${dbPath}`);
        const messages = db
            .query<Record<string, unknown>, [string]>(
                "SELECT id, session_id, time_created, time_updated, data FROM message WHERE session_id = ? ORDER BY time_created, id",
            )
            .all(sessionId);
        const parts = db
            .query<Record<string, unknown>, [string]>(
                "SELECT id, message_id, session_id, time_created, time_updated, data FROM part WHERE session_id = ? ORDER BY time_created, id",
            )
            .all(sessionId);
        const seed: OpenCodeSeed = {
            sessions: [{
                id: String(session.id),
                parent_id: session.parent_id === null ? null : String(session.parent_id),
                directory: sanitizeJsonScalar(String(session.directory), rules),
                title: sanitizeJsonScalar(String(session.title), rules),
                version: session.version === null ? null : String(session.version),
                model: session.model === null ? null : String(session.model),
                time_created: Number(session.time_created),
                time_updated: Number(session.time_updated),
            }],
            messages: messages.map((row) => ({
                id: String(row.id),
                session_id: String(row.session_id),
                time_created: Number(row.time_created),
                time_updated: Number(row.time_updated),
                data: sanitizeJsonScalar(String(row.data), rules),
            })),
            parts: parts.map((row) => ({
                id: String(row.id),
                message_id: String(row.message_id),
                session_id: String(row.session_id),
                time_created: Number(row.time_created),
                time_updated: Number(row.time_updated),
                data: sanitizeJsonScalar(String(row.data), rules),
            })),
        };
        console.log(`sanitize rules fired: ${[...rules].sort().join(", ") || "(none)"}`);
        const content = stableStringify(seed);
        writeFileSync(fixturePath("opencode.seed.json"), content);
        const batch = replayOpenCode(seed);
        writeFileSync(goldenPath("opencode.batch.json"), stableStringify(projectBatch(batch)));
        console.log("wrote fixtures/opencode.seed.json + golden/opencode.batch.json");
        for (const finding of scanResiduals(content)) console.log(`  ⚠ ${finding}`);
    } finally {
        db.close();
    }
};

const harvestCursor = (dbPath: string, composerId: string): void => {
    const db = new Database(dbPath, { readonly: true });
    const rules = new Set<string>();
    try {
        const rows = db
            .query<{ key: string; value: string }, [string, string]>(
                "SELECT key, value FROM cursorDiskKV WHERE key = ? OR key LIKE ? ORDER BY key",
            )
            .all(`composerData:${composerId}`, `bubbleId:${composerId}:%`);
        if (rows.length === 0) throw new Error(`cursor composer ${composerId} not found in ${dbPath}`);
        const seed: CursorSeed = {
            cursorDiskKV: rows.map((row) => ({ key: row.key, value: sanitizeJsonScalar(row.value, rules) })),
        };
        console.log(`sanitize rules fired: ${[...rules].sort().join(", ") || "(none)"}`);
        const content = stableStringify(seed);
        writeFileSync(fixturePath("cursor.seed.json"), content);
        const batch = replayCursor(seed);
        writeFileSync(goldenPath("cursor.batch.json"), stableStringify(projectBatch(batch)));
        console.log("wrote fixtures/cursor.seed.json + golden/cursor.batch.json");
        for (const finding of scanResiduals(content)) console.log(`  ⚠ ${finding}`);
    } finally {
        db.close();
    }
};

const regen = (): void => {
    const jsonl = { claude: replayClaude, codex: replayCodex, pi: replayPi, omp: replayOmp } as const;
    for (const [provider, replay] of Object.entries(jsonl)) {
        const content = readFileSync(fixturePath(`${provider}.jsonl`), "utf8");
        writeFileSync(goldenPath(`${provider}.batch.json`), stableStringify(projectBatch(replay(content))));
        console.log(`regenerated golden/${provider}.batch.json`);
    }
    const opencodeSeed = JSON.parse(readFileSync(fixturePath("opencode.seed.json"), "utf8")) as OpenCodeSeed;
    writeFileSync(goldenPath("opencode.batch.json"), stableStringify(projectBatch(replayOpenCode(opencodeSeed))));
    console.log("regenerated golden/opencode.batch.json");
    const cursorSeed = JSON.parse(readFileSync(fixturePath("cursor.seed.json"), "utf8")) as CursorSeed;
    writeFileSync(goldenPath("cursor.batch.json"), stableStringify(projectBatch(replayCursor(cursorSeed))));
    console.log("regenerated golden/cursor.batch.json");
};

const main = (): void => {
    const [command, source, ...flags] = process.argv.slice(2);
    const flag = (name: string): string | null => {
        const hit = flags.find((f) => f.startsWith(`--${name}=`));
        return hit ? hit.slice(name.length + 3) : null;
    };
    switch (command) {
        case "claude":
        case "codex":
        case "pi":
        case "omp": {
            if (!source) throw new Error(`usage: harvest.ts ${command} <session.jsonl> [--head=N]`);
            const head = flag("head");
            harvestJsonl(command, source, head === null ? null : Number(head));
            return;
        }
        case "opencode": {
            const sessionId = flag("session");
            if (!source || !sessionId) throw new Error("usage: harvest.ts opencode <opencode.db> --session=<id>");
            harvestOpenCode(source, sessionId);
            return;
        }
        case "cursor": {
            const composerId = flag("composer");
            if (!source || !composerId) throw new Error("usage: harvest.ts cursor <state.vscdb> --composer=<id>");
            harvestCursor(source, composerId);
            return;
        }
        case "regen":
            regen();
            return;
        default:
            throw new Error("usage: harvest.ts <claude|codex|pi|omp|opencode|cursor|regen> ...");
    }
};

if (import.meta.main) main();
