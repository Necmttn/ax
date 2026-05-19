import { Effect } from "effect";
import type { DbError } from "../lib/errors.ts";
import { SurrealClient } from "../lib/db.ts";
import {
    buildFileContextHookEvidence,
    type FileContextPack,
    type FileMemoryCommit,
    type FileMemoryCorrection,
    type FileMemoryCoTouch,
} from "../context/file-context.ts";
import { findRecentInjects } from "./dedup.ts";

type PriorFileSession = FileContextPack["evidence"]["prior_file_sessions"][number];

export type FileContextHookEvent = "pre-edit" | "read" | "write" | "search" | "unknown";
export type FileContextHookFormat = "plain" | "json" | "claude";

export interface FileContextHookInput {
    readonly event: FileContextHookEvent;
    readonly task: string;
    readonly files: readonly string[];
    /** Extra path strings to try when resolving file records, in addition to
     *  `files`. Used by the Claude adapter to feed cwd-relative and
     *  repo-relative variants of an absolute file path without inflating the
     *  telemetry row count. */
    readonly lookupPaths?: readonly string[] | undefined;
    readonly sessionId?: string | undefined;
    readonly format: FileContextHookFormat;
}

export interface FileContextHookDecision {
    readonly inject: boolean;
    readonly reason: string;
}

export interface FileContextHookResponse {
    readonly inject: boolean;
    readonly reason: string;
    readonly context: string;
    readonly evidence: {
        readonly prior_file_sessions: readonly PriorFileSession[];
        readonly corrections: readonly FileMemoryCorrection[];
        readonly commits: readonly FileMemoryCommit[];
        readonly co_touched: readonly FileMemoryCoTouch[];
    };
}

const KNOWN_EVENTS = new Set<FileContextHookEvent>(["pre-edit", "read", "write", "search"]);
const KNOWN_FORMATS = new Set<FileContextHookFormat>(["plain", "json", "claude"]);

const SUPPRESSED_BASENAMES = new Set([
    "bun.lock",
    "bun.lockb",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "Cargo.lock",
    "poetry.lock",
    "Pipfile.lock",
    "uv.lock",
    "composer.lock",
    "go.sum",
]);

const SUPPRESSED_SUBSTRINGS = [
    "/node_modules/",
    "/dist/",
    "/build/",
    "/.next/",
    "/.turbo/",
    "/.nuxt/",
    "/coverage/",
    "/.output/",
];

const SUPPRESSED_SUFFIXES = [
    ".map",
    ".min.js",
    ".min.css",
    "routeTree.gen.ts",
    ".generated.ts",
    ".g.ts",
    ".gen.ts",
];

function normalizeEvent(value: string | null | undefined): FileContextHookEvent {
    if (!value) return "unknown";
    const lowered = value.toLowerCase();
    if (KNOWN_EVENTS.has(lowered as FileContextHookEvent)) return lowered as FileContextHookEvent;
    return "unknown";
}

function normalizeFormat(value: string | null | undefined): FileContextHookFormat {
    if (!value) return "plain";
    const lowered = value.toLowerCase();
    if (KNOWN_FORMATS.has(lowered as FileContextHookFormat)) return lowered as FileContextHookFormat;
    return "plain";
}

function dedupeFiles(files: readonly (string | null | undefined)[]): readonly string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const raw of files) {
        if (typeof raw !== "string") continue;
        const trimmed = raw.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        out.push(trimmed);
    }
    return out;
}

export interface FileContextHookFlagInput {
    readonly event?: string | null;
    readonly task?: string | null;
    readonly files?: readonly string[] | null;
    readonly lookupPaths?: readonly string[] | null;
    readonly sessionId?: string | null;
    readonly format?: string | null;
}

export function parseFileContextHookFlags(args: FileContextHookFlagInput): FileContextHookInput {
    const lookup = dedupeFiles(args.lookupPaths ?? []);
    return {
        event: normalizeEvent(args.event),
        task: (args.task ?? "").trim(),
        files: dedupeFiles(args.files ?? []),
        lookupPaths: lookup.length > 0 ? lookup : undefined,
        sessionId: args.sessionId?.trim() || undefined,
        format: normalizeFormat(args.format),
    };
}

const CLAUDE_TOOL_TO_EVENT: Record<string, FileContextHookEvent> = {
    Edit: "pre-edit",
    Write: "pre-edit",
    MultiEdit: "pre-edit",
    Read: "read",
    Grep: "search",
    Glob: "search",
};

/** Generate up to ~5 path strings to try when looking up the file record. The
 *  agent reports an absolute path; the file table stores repo-relative paths,
 *  which may sit at cwd, the parent dir, or further up in monorepos. */
function generateLookupCandidates(filePath: string, cwd: string | null): string[] {
    if (!cwd || !filePath.startsWith(cwd + "/")) return [];
    const candidates = new Set<string>([filePath.slice(cwd.length + 1)]);
    let parent = cwd;
    for (let i = 0; i < 3; i++) {
        const next = parent.replace(/\/[^/]+$/, "");
        if (!next || next === parent) break;
        if (filePath.startsWith(next + "/")) candidates.add(filePath.slice(next.length + 1));
        parent = next;
    }
    return Array.from(candidates);
}

/** Claude Code's `session_id` is a bare UUID. Telemetry + dedup need a
 *  SurrealQL record literal, so prefix `session:` when no table is present. */
function normalizeSessionId(raw: string | null): string | null {
    if (!raw) return null;
    return raw.includes(":") ? raw : `session:${raw}`;
}

function adaptClaudePayload(payload: Record<string, unknown>): FileContextHookFlagInput {
    const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
    const toolInput = payload.tool_input && typeof payload.tool_input === "object"
        ? payload.tool_input as Record<string, unknown>
        : {};
    const filePath = typeof toolInput.file_path === "string" ? toolInput.file_path : null;
    const cwd = typeof payload.cwd === "string" ? payload.cwd : null;
    const sessionId = normalizeSessionId(typeof payload.session_id === "string" ? payload.session_id : null);
    const event = CLAUDE_TOOL_TO_EVENT[toolName] ?? "unknown";
    return {
        event,
        task: null,
        files: filePath ? [filePath] : [],
        lookupPaths: filePath ? generateLookupCandidates(filePath, cwd) : [],
        sessionId,
        format: "claude",
    };
}

export function parseFileContextHookStdin(text: string): FileContextHookInput {
    let payload: Record<string, unknown> = {};
    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object") payload = parsed as Record<string, unknown>;
    } catch {
        return parseFileContextHookFlags({});
    }

    if (typeof payload.hook_event_name === "string") {
        return parseFileContextHookFlags(adaptClaudePayload(payload));
    }

    const event = typeof payload.event === "string" ? payload.event : null;
    const task = typeof payload.task === "string" ? payload.task : null;
    const sessionId = typeof payload.session_id === "string"
        ? payload.session_id
        : typeof payload.sessionId === "string" ? payload.sessionId : null;
    const format = typeof payload.format === "string" ? payload.format : null;
    const filesArr = Array.isArray(payload.files) ? payload.files.filter((f): f is string => typeof f === "string") : [];
    const single = typeof payload.file === "string" ? [payload.file] : [];
    return parseFileContextHookFlags({
        event,
        task,
        files: [...filesArr, ...single],
        sessionId,
        format,
    });
}

function basename(path: string): string {
    return path.split("/").at(-1) ?? path;
}

function isSuppressedPath(path: string): boolean {
    if (!path) return true;
    const normalized = path.startsWith("/") ? path : `/${path}`;
    if (SUPPRESSED_BASENAMES.has(basename(path))) return true;
    if (SUPPRESSED_SUBSTRINGS.some((needle) => normalized.includes(needle))) return true;
    if (SUPPRESSED_SUFFIXES.some((suffix) => path.endsWith(suffix))) return true;
    return false;
}

function isHighSignalSession(session: PriorFileSession): boolean {
    if (session.weight >= 3) return true;
    if (session.corrections > 0) return true;
    if (session.produced_commits > 0) return true;
    if (session.merged_to_main) return true;
    if (session.review_pain && session.review_pain.length > 0) return true;
    return false;
}

export interface ShouldInjectInput {
    readonly files: readonly string[];
    readonly priorFileSessions: readonly PriorFileSession[];
    readonly alreadyInjectedPaths?: ReadonlySet<string> | undefined;
    readonly corrections?: readonly FileMemoryCorrection[] | undefined;
    readonly commits?: readonly FileMemoryCommit[] | undefined;
}

const COMMITS_INJECT_THRESHOLD = 2;

export function shouldInjectFileMemory(input: ShouldInjectInput): FileContextHookDecision {
    if (input.files.length === 0) {
        return { inject: false, reason: "no_files" };
    }
    const usable = input.files.filter((path) => !isSuppressedPath(path));
    if (usable.length === 0) {
        return { inject: false, reason: "suppressed_path" };
    }
    if (input.alreadyInjectedPaths && usable.every((path) => input.alreadyInjectedPaths!.has(path))) {
        return { inject: false, reason: "session_already_injected" };
    }
    // v2 high-precision signals - inject when ANY of these has content:
    // 1) a user correction explicitly mentioned this file (highest precision)
    // 2) >= 2 commits touched it (substantial history, beats `git log` only by
    //    being graph-linked to sessions, but kept as a fallback signal)
    // 3) at least one prior session showed high-signal (corrections, merged,
    //    review_pain, weight ≥ 3) - preserves the original behaviour
    if (input.corrections && input.corrections.length > 0) {
        return { inject: true, reason: "high_signal" };
    }
    if (input.commits && input.commits.length >= COMMITS_INJECT_THRESHOLD) {
        return { inject: true, reason: "high_signal" };
    }
    if (input.priorFileSessions.length === 0) {
        return { inject: false, reason: "no_prior_sessions" };
    }
    if (!input.priorFileSessions.some(isHighSignalSession)) {
        return { inject: false, reason: "low_signal_only" };
    }
    return { inject: true, reason: "high_signal" };
}

const clipText = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}...`);

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

function tsDate(ts: string | null): string {
    if (!ts) return "unknown date";
    const date = new Date(ts);
    if (!Number.isFinite(date.getTime())) return "unknown date";
    return date.toISOString().slice(0, 10);
}

function describeCorrection(c: FileMemoryCorrection): string {
    const refs = [
        c.turn_id,
        c.session_id,
        tsDate(c.ts),
        c.delivery_status,
        c.pr_title ? `pr "${clipText(oneLine(c.pr_title), 80)}"` : null,
    ].filter(Boolean);
    return `- "${clipText(oneLine(c.text), 240)}"\n  ref: ${refs.join(" · ")}`;
}

function describeCommit(c: FileMemoryCommit): string {
    const sha = (c.sha ?? c.commit_id).slice(0, 10);
    const msg = c.message ? clipText(oneLine(c.message), 120) : "(no message)";
    return `- ${sha}  "${msg}"  (${tsDate(c.ts)})`;
}

function describeCoTouches(items: readonly FileMemoryCoTouch[]): string {
    return items
        .slice(0, 5)
        .map((c) => `${c.path} (${c.co_sessions}/${c.total_sessions})`)
        .join(" · ");
}

export interface FileMemoryRenderInput {
    readonly filePath: string;
    readonly priorFileSessions: readonly PriorFileSession[];
    readonly corrections: readonly FileMemoryCorrection[];
    readonly commits: readonly FileMemoryCommit[];
    readonly coTouched: readonly FileMemoryCoTouch[];
}

export function renderFileMemoryBlock(input: FileMemoryRenderInput): string {
    const sections: string[][] = [];
    const refsFooter: string[] = [];

    if (input.corrections.length > 0) {
        sections.push([
            `Corrections targeting this file (${input.corrections.length}):`,
            ...input.corrections.slice(0, 5).map(describeCorrection),
        ]);
        refsFooter.push("turn/session ids resolve via SurrealDB MCP or `surreal sql`");
    }

    if (input.commits.length > 0) {
        sections.push([
            "Recent commits touching this file:",
            ...input.commits.slice(0, 5).map(describeCommit),
        ]);
        refsFooter.push("commit SHAs work with `git show <sha>`");
    }

    if (input.coTouched.length > 0) {
        sections.push([
            "Co-touched files (count = sessions that touched both):",
            `- ${describeCoTouches(input.coTouched)}`,
        ]);
    }

    // Fallback: prior_file_sessions list only when we have nothing concrete.
    if (sections.length === 0 && input.priorFileSessions.length > 0) {
        const lines = input.priorFileSessions.slice(0, 3).map((s) => {
            const stats = [
                `${s.weight} edits`,
                `${s.produced_commits} commits`,
                s.corrections > 0 ? `${s.corrections} corrections` : null,
                s.merged_to_main ? "merged_to_main" : null,
            ].filter(Boolean);
            const title = clipText(oneLine(s.title ?? s.project ?? s.session), 160) || s.session;
            return `- "${title}" -> ${stats.join(", ")}\n  ref: session:${s.session.replace(/^session:/, "")}`;
        });
        sections.push(["Prior sessions touching this file (no specific corrections recorded):", ...lines]);
    }

    if (sections.length === 0) return "";

    const lines: string[] = ["<ax_file_memory>", `File: ${input.filePath}`, ""];
    sections.forEach((section, i) => {
        lines.push(...section);
        if (i < sections.length - 1) lines.push("");
    });
    if (refsFooter.length > 0) {
        lines.push("", `Dig deeper: ${refsFooter.join(" · ")}`);
    }
    lines.push("</ax_file_memory>");
    return lines.join("\n");
}

const DEDUP_WINDOW_MINUTES = 30;

export const buildFileContextHookResponse = (
    input: FileContextHookInput,
): Effect.Effect<FileContextHookResponse, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const emptyEvidence = {
            prior_file_sessions: [] as readonly PriorFileSession[],
            corrections: [] as readonly FileMemoryCorrection[],
            commits: [] as readonly FileMemoryCommit[],
            co_touched: [] as readonly FileMemoryCoTouch[],
        };

        const usableFiles = input.files.filter((path) => !isSuppressedPath(path));
        if (input.files.length === 0 || usableFiles.length === 0) {
            const reason = input.files.length === 0 ? "no_files" : "suppressed_path";
            return { inject: false, reason, context: "", evidence: emptyEvidence };
        }

        const alreadyInjectedPaths = yield* findRecentInjects({
            sessionId: input.sessionId,
            filePaths: usableFiles,
            windowMinutes: DEDUP_WINDOW_MINUTES,
        }).pipe(
            // Dedup failure must never block the hook output. Same principle as
            // telemetry: degrade to "no dedup info" and continue.
            Effect.catch((err) =>
                Effect.sync(() => {
                    console.error("axctl hook dedup query failed:", err);
                    return new Set<string>() as ReadonlySet<string>;
                }),
            ),
        );
        if (alreadyInjectedPaths.size > 0 && usableFiles.every((p) => alreadyInjectedPaths.has(p))) {
            return { inject: false, reason: "session_already_injected", context: "", evidence: emptyEvidence };
        }

        const lookupPaths = (input.lookupPaths ?? []).filter((p) => !isSuppressedPath(p));
        const evidence = yield* buildFileContextHookEvidence({
            q: input.task,
            files: [...usableFiles, ...lookupPaths],
        });
        const decision = shouldInjectFileMemory({
            files: input.files,
            priorFileSessions: evidence.prior_file_sessions,
            corrections: evidence.corrections,
            commits: evidence.commits,
            alreadyInjectedPaths,
        });
        const rendered = decision.inject
            ? renderFileMemoryBlock({
                filePath: usableFiles[0] ?? "(unknown file)",
                priorFileSessions: evidence.prior_file_sessions,
                corrections: evidence.corrections,
                commits: evidence.commits,
                coTouched: evidence.co_touched,
            })
            : "";
        // shouldInjectFileMemory may say inject:true while every section ends
        // up empty (e.g. prior session weight ≥ 3 but no commits/corrections
        // and renderer fallback also empty). Don't emit an empty block.
        const inject = decision.inject && rendered.length > 0;
        return {
            inject,
            reason: inject ? decision.reason : decision.inject ? "empty_render" : decision.reason,
            context: rendered,
            evidence: {
                prior_file_sessions: evidence.prior_file_sessions,
                corrections: evidence.corrections,
                commits: evidence.commits,
                co_touched: evidence.co_touched,
            },
        };
    });
