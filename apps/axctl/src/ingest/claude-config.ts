import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { Effect, FileSystem, Path, Schema } from "effect";
import { AxConfig } from "@ax/lib/config";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { safeKeyPart } from "@ax/lib/shared/derive-keys";
import { classifyNoFollow } from "@ax/lib/shared/fs-classify";
import { orAbsent } from "@ax/lib/shared/fs-error";
import { executeStatementsWith } from "@ax/lib/shared/statement-exec";
import {
    recordRef,
    surrealJsonTextOption,
    surrealObject,
    surrealOptionString,
    surrealString,
    surrealValue,
} from "@ax/lib/shared/surql";
import { BaseStageStats, IngestContext, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";

export const GUIDANCE_CONFIG_ARTIFACT_TABLE = "guidance_config_artifact";

export type GuidanceConfigProvider = "claude";
export type GuidanceConfigAuthorityKind = "user" | "project" | "plugin";
export type GuidanceConfigScope =
    | "managed"
    | "system"
    | "user"
    | "project"
    | "local"
    | "plugin"
    | "marketplace";
export type GuidanceConfigArtifactKind =
    | "guidance_doc"
    | "settings_config"
    | "rule"
    | "hook"
    | "mcp_server"
    | "skill"
    | "agent_definition"
    | "memory"
    | "workflow"
    | "output_style"
    | "plugin"
    | "worktreeinclude";
export type GuidanceConfigParseStatus = "ok" | "invalid_json" | "skipped_large";

export interface GuidanceConfigArtifact {
    readonly provider: GuidanceConfigProvider;
    readonly kind: GuidanceConfigArtifactKind;
    readonly scope: GuidanceConfigScope;
    readonly safePath: string;
    readonly pathHash: string;
    readonly authorityKind: GuidanceConfigAuthorityKind;
    readonly authorityHash: string;
    readonly contentHash: string | null;
    readonly parseStatus: GuidanceConfigParseStatus;
    readonly bytes: number;
    readonly tokenEstimate: number;
    readonly commandHashes: readonly string[];
    readonly hookEventNames: readonly string[];
    readonly matcherCount: number;
    readonly mcpServerNames: readonly string[];
    readonly envKeys: readonly string[];
    readonly enabledToolCount: number | null;
    readonly model: string | null;
    readonly reasoningEffort: string | null;
    readonly outputStyle: string | null;
    readonly permissionAllowCount: number;
    readonly permissionAskCount: number;
    readonly permissionDenyCount: number;
    readonly observedAt: Date;
    readonly metadata: Record<string, unknown>;
}

export interface ParseClaudeConfigArtifactInput {
    readonly provider?: GuidanceConfigProvider | undefined;
    readonly kind: GuidanceConfigArtifactKind;
    readonly scope: GuidanceConfigScope;
    readonly path: string;
    readonly home?: string | undefined;
    readonly projectRoot?: string | undefined;
    readonly text: string;
    readonly observedAt?: Date | undefined;
}

export interface ParseClaudeSettingsArtifactInput {
    readonly scope: GuidanceConfigScope;
    readonly path: string;
    readonly home?: string | undefined;
    readonly projectRoot?: string | undefined;
    readonly text: string;
    readonly observedAt?: Date | undefined;
}

export interface DiscoverClaudeConfigArtifactsOptions {
    readonly home: string;
    readonly projectRoot?: string | undefined;
}

export interface IngestClaudeConfigStats {
    readonly discovered: number;
    readonly written: number;
}

const MAX_ARTIFACT_READ_BYTES = 256 * 1024;

const sha256 = (input: string | Uint8Array): string =>
    createHash("sha256").update(input).digest("hex");

const normalizePath = (value: string): string =>
    value.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");

const normalizeRel = (value: string): string =>
    value.replace(/\\/g, "/").replace(/^\/+/, "");

const isWithin = (candidate: string, root: string): boolean => {
    const c = normalizePath(candidate);
    const r = normalizePath(root);
    return c === r || c.startsWith(`${r}/`);
};

const relFromRoot = (candidate: string, root: string): string =>
    normalizeRel(normalizePath(candidate).slice(normalizePath(root).length));

const safePathFor = (
    path: string,
    home?: string,
    projectRoot?: string,
): string => {
    if (projectRoot && isWithin(path, projectRoot)) {
        const rel = relFromRoot(path, projectRoot);
        return rel ? `$PROJECT/${rel}` : "$PROJECT";
    }
    if (home && isWithin(path, home)) {
        const rel = relFromRoot(path, home);
        return rel ? `~/${rel}` : "~";
    }
    const normalized = normalizePath(path);
    if (!normalized.startsWith("/")) return normalized;
    return `$PATH/${sha256(normalized).slice(0, 16)}`;
};

const pluginCacheRoot = (home: string): string =>
    `${normalizePath(home)}/.claude/plugins/cache`;

const authorityFor = (
    args: {
        readonly provider: GuidanceConfigProvider;
        readonly scope: GuidanceConfigScope;
        readonly path: string;
        readonly home?: string | undefined;
        readonly projectRoot?: string | undefined;
    },
): { authorityKind: GuidanceConfigAuthorityKind; authorityHash: string } => {
    const normalizedPath = normalizePath(args.path);
    let authorityKind: GuidanceConfigAuthorityKind = "user";
    let authorityRoot = args.home ? normalizePath(args.home) : normalizedPath;

    if (
        args.projectRoot &&
        (args.scope === "project" || isWithin(normalizedPath, args.projectRoot))
    ) {
        authorityKind = "project";
        authorityRoot = normalizePath(args.projectRoot);
    } else if (
        args.home &&
        (args.scope === "plugin" || isWithin(normalizedPath, pluginCacheRoot(args.home)))
    ) {
        authorityKind = "plugin";
        authorityRoot = pluginCacheRoot(args.home);
    } else if (args.home) {
        authorityRoot = normalizePath(args.home);
    }

    return {
        authorityKind,
        authorityHash: sha256(`${args.provider}\0${authorityKind}\0${authorityRoot}`),
    };
};

export const guidanceConfigAuthorityHashesForScan = (
    opts: DiscoverClaudeConfigArtifactsOptions,
): string[] => {
    const provider = "claude";
    const authorities = [
        authorityFor({ provider, scope: "user", path: opts.home, home: opts.home }).authorityHash,
        authorityFor({
            provider,
            scope: "plugin",
            path: pluginCacheRoot(opts.home),
            home: opts.home,
        }).authorityHash,
    ];
    if (opts.projectRoot) {
        authorities.push(
            authorityFor({
                provider,
                scope: "project",
                path: opts.projectRoot,
                home: opts.home,
                projectRoot: opts.projectRoot,
            }).authorityHash,
        );
    }
    return uniqueSorted(authorities);
};

const byteSize = (text: string): number => Buffer.byteLength(text, "utf8");

const tokenEstimate = (bytes: number): number => Math.max(1, Math.ceil(bytes / 4));

const uniqueSorted = (values: Iterable<string>): string[] =>
    [...new Set([...values].map((s) => s.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));

const countArrayLike = (value: unknown): number => {
    if (Array.isArray(value)) return value.length;
    if (typeof value === "string" && value.trim()) return 1;
    return 0;
};

const stringValue = (value: unknown): string | null =>
    typeof value === "string" && value.trim() ? value.trim() : null;

const asRecord = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;

const stringArrayOrCsvCount = (value: unknown): number | null => {
    if (Array.isArray(value)) {
        return value.filter((item) => typeof item === "string" && item.trim()).length;
    }
    if (typeof value === "string") {
        return value.split(",").map((item) => item.trim()).filter(Boolean).length;
    }
    return null;
};

const commandHashesFromHooks = (value: unknown): string[] => {
    const out: string[] = [];
    const visit = (node: unknown): void => {
        if (Array.isArray(node)) {
            for (const item of node) visit(item);
            return;
        }
        const rec = asRecord(node);
        if (!rec) return;
        const command = rec.command;
        if (typeof command === "string" && command.length > 0) {
            out.push(sha256(command));
        }
        for (const child of Object.values(rec)) visit(child);
    };
    visit(value);
    return uniqueSorted(out);
};

const hookMetadata = (
    root: Record<string, unknown>,
): { hookEventNames: string[]; matcherCount: number; commandHashes: string[] } => {
    const hooks = asRecord(root.hooks);
    if (!hooks) return { hookEventNames: [], matcherCount: 0, commandHashes: [] };

    const hookEventNames = uniqueSorted(Object.keys(hooks));
    let matcherCount = 0;
    for (const value of Object.values(hooks)) {
        const entries = Array.isArray(value) ? value : [value];
        for (const entry of entries) {
            if (asRecord(entry)?.matcher !== undefined) matcherCount++;
        }
    }

    return {
        hookEventNames,
        matcherCount,
        commandHashes: commandHashesFromHooks(hooks),
    };
};

const envKeysFromSettings = (root: Record<string, unknown>): string[] =>
    uniqueSorted(Object.keys(asRecord(root.env) ?? {}));

const mcpServerNamesFrom = (root: Record<string, unknown>): string[] => {
    const mcp = asRecord(root.mcpServers) ?? asRecord(root.mcp_servers);
    return uniqueSorted(Object.keys(mcp ?? {}));
};

const permissionCounts = (
    root: Record<string, unknown>,
): { allow: number; ask: number; deny: number } => {
    const permissions = asRecord(root.permissions) ?? {};
    return {
        allow: countArrayLike(permissions.allow),
        ask: countArrayLike(permissions.ask),
        deny: countArrayLike(permissions.deny),
    };
};

const extractFrontmatter = (text: string): Record<string, unknown> => {
    const match = text.match(/^---\n([\s\S]*?)\n---\n/);
    if (!match) return {};
    try {
        return (parseYaml(match[1] ?? "") ?? {}) as Record<string, unknown>;
    } catch {
        return {};
    }
};

const frontmatterMetadata = (
    text: string,
): Pick<GuidanceConfigArtifact, "model" | "reasoningEffort" | "outputStyle" | "enabledToolCount"> => {
    const fm = extractFrontmatter(text);
    return {
        model: stringValue(fm.model),
        reasoningEffort: stringValue(
            fm.effortLevel ??
            fm["effort-level"] ??
            fm.reasoning_effort ??
            fm["reasoning-effort"] ??
            fm.reasoningEffort,
        ),
        outputStyle: stringValue(fm.outputStyle ?? fm["output-style"] ?? fm.output_style),
        enabledToolCount: stringArrayOrCsvCount(fm.tools ?? fm.allowed_tools ?? fm["allowed-tools"] ?? fm.allowedTools),
    };
};

const baseRecord = (
    input: ParseClaudeConfigArtifactInput,
    overrides: Partial<GuidanceConfigArtifact>,
): GuidanceConfigArtifact => {
    const bytes = byteSize(input.text);
    const provider = input.provider ?? "claude";
    const safePath = safePathFor(input.path, input.home, input.projectRoot);
    const authority = authorityFor({
        provider,
        scope: input.scope,
        path: input.path,
        home: input.home,
        projectRoot: input.projectRoot,
    });
    const record: GuidanceConfigArtifact = {
        provider,
        kind: input.kind,
        scope: input.scope,
        safePath,
        pathHash: sha256(`${provider}\0${normalizePath(input.path)}`),
        authorityKind: authority.authorityKind,
        authorityHash: authority.authorityHash,
        contentHash: sha256(input.text),
        parseStatus: "ok",
        bytes,
        tokenEstimate: tokenEstimate(bytes),
        commandHashes: [],
        hookEventNames: [],
        matcherCount: 0,
        mcpServerNames: [],
        envKeys: [],
        enabledToolCount: null,
        model: null,
        reasoningEffort: null,
        outputStyle: null,
        permissionAllowCount: 0,
        permissionAskCount: 0,
        permissionDenyCount: 0,
        observedAt: input.observedAt ?? new Date(),
        metadata: {},
        ...overrides,
    };
    return {
        ...record,
        metadata: metadataFor(record),
    };
};

const metadataFor = (
    record: Omit<GuidanceConfigArtifact, "metadata">,
): Record<string, unknown> => ({
    command_hash_count: record.commandHashes.length,
    hook_event_count: record.hookEventNames.length,
    matcher_count: record.matcherCount,
    mcp_server_count: record.mcpServerNames.length,
    env_key_count: record.envKeys.length,
    enabled_tool_count: record.enabledToolCount,
    permission_allow_count: record.permissionAllowCount,
    permission_ask_count: record.permissionAskCount,
    permission_deny_count: record.permissionDenyCount,
    has_model_override: record.model !== null,
    has_reasoning_effort_override: record.reasoningEffort !== null,
    has_output_style: record.outputStyle !== null,
});

export const parseClaudeSettingsArtifact = (
    input: ParseClaudeSettingsArtifactInput,
): GuidanceConfigArtifact => {
    const common = {
        kind: "settings_config" as const,
        scope: input.scope,
        path: input.path,
        home: input.home,
        projectRoot: input.projectRoot,
        text: input.text,
        observedAt: input.observedAt,
    };
    try {
        const root = asRecord(JSON.parse(input.text)) ?? {};
        const hooks = hookMetadata(root);
        const perms = permissionCounts(root);
        return baseRecord(common, {
            parseStatus: "ok",
            model: stringValue(root.model),
            reasoningEffort: stringValue(root.effortLevel ?? root.reasoning_effort ?? root.reasoningEffort),
            outputStyle: stringValue(root.outputStyle ?? root.output_style),
            permissionAllowCount: perms.allow,
            permissionAskCount: perms.ask,
            permissionDenyCount: perms.deny,
            hookEventNames: hooks.hookEventNames,
            matcherCount: hooks.matcherCount,
            commandHashes: hooks.commandHashes,
            envKeys: envKeysFromSettings(root),
            mcpServerNames: mcpServerNamesFrom(root),
            enabledToolCount: stringArrayOrCsvCount(root.enabledTools ?? root.tools),
        });
    } catch {
        return baseRecord(common, {
            parseStatus: "invalid_json",
        });
    }
};

export const parseClaudeConfigArtifact = (
    input: ParseClaudeConfigArtifactInput,
): GuidanceConfigArtifact => {
    if (input.kind === "settings_config") {
        return parseClaudeSettingsArtifact({
            scope: input.scope,
            path: input.path,
            home: input.home,
            projectRoot: input.projectRoot,
            text: input.text,
            observedAt: input.observedAt,
        });
    }

    if (input.kind === "mcp_server") {
        try {
            const root = asRecord(JSON.parse(input.text)) ?? {};
            return baseRecord(input, { mcpServerNames: mcpServerNamesFrom(root) });
        } catch {
            return baseRecord(input, { parseStatus: "invalid_json" });
        }
    }

    if ((input.kind === "hook" || input.kind === "plugin") && isJsonFile(input.path)) {
        try {
            const root = asRecord(JSON.parse(input.text)) ?? {};
            const hooks = hookMetadata(root);
            return baseRecord(input, {
                hookEventNames: hooks.hookEventNames,
                matcherCount: hooks.matcherCount,
                commandHashes: hooks.commandHashes,
            });
        } catch {
            return baseRecord(input, { parseStatus: "invalid_json" });
        }
    }

    if (input.kind === "agent_definition" || input.kind === "skill" || input.kind === "output_style" || input.kind === "workflow") {
        return baseRecord(input, frontmatterMetadata(input.text));
    }

    return baseRecord(input, {});
};

const fileRecord = (
    args: {
        readonly path: string;
        readonly kind: GuidanceConfigArtifactKind;
        readonly scope: GuidanceConfigScope;
        readonly home: string;
        readonly projectRoot?: string | undefined;
    },
): Effect.Effect<GuidanceConfigArtifact | null, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const entryKind = yield* classifyNoFollow(args.path);
        if (entryKind !== "File") return null;
        const stat = yield* fs.stat(args.path).pipe(orAbsent(null as FileSystem.File.Info | null));
        if (stat === null || stat.type !== "File") return null;
        const size = Number(stat.size);
        if (size > MAX_ARTIFACT_READ_BYTES) {
            return {
                ...baseRecord({
                    kind: args.kind,
                    scope: args.scope,
                    path: args.path,
                    home: args.home,
                    projectRoot: args.projectRoot,
                    text: "",
                }, {
                    contentHash: null,
                    parseStatus: "skipped_large",
                    bytes: Math.trunc(size),
                    tokenEstimate: tokenEstimate(size),
                }),
            };
        }
        const text = yield* fs.readFileString(args.path).pipe(orAbsent(null as string | null));
        if (text === null) return null;
        return parseClaudeConfigArtifact({
            kind: args.kind,
            scope: args.scope,
            path: args.path,
            home: args.home,
            projectRoot: args.projectRoot,
            text,
        });
    });

const addIfPresent = (
    out: GuidanceConfigArtifact[],
    args: {
        readonly path: string;
        readonly kind: GuidanceConfigArtifactKind;
        readonly scope: GuidanceConfigScope;
        readonly home: string;
        readonly projectRoot?: string | undefined;
    },
): Effect.Effect<void, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const record = yield* fileRecord(args);
        if (record) out.push(record);
    });

const walkMatchingFiles = (
    args: {
        readonly dir: string;
        readonly home: string;
        readonly projectRoot?: string | undefined;
        readonly kind: GuidanceConfigArtifactKind;
        readonly scope: GuidanceConfigScope;
        readonly include: (path: string) => boolean;
        readonly maxDepth?: number | undefined;
        readonly depth?: number | undefined;
    },
): Effect.Effect<GuidanceConfigArtifact[], never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const depth = args.depth ?? 0;
        if (args.maxDepth !== undefined && depth > args.maxDepth) return [];
        const entryKind = yield* classifyNoFollow(args.dir);
        if (entryKind !== "Directory") return [];
        const entries = yield* fs.readDirectory(args.dir).pipe(orAbsent<ReadonlyArray<string>>([]));
        const out: GuidanceConfigArtifact[] = [];
        for (const entry of entries) {
            const full = path.join(args.dir, entry);
            const kind = yield* classifyNoFollow(full);
            if (kind === "Directory") {
                const nested = yield* walkMatchingFiles({ ...args, dir: full, depth: depth + 1 });
                out.push(...nested);
                continue;
            }
            if (kind !== "File" || !args.include(full)) continue;
            const record = yield* fileRecord({
                path: full,
                kind: args.kind,
                scope: args.scope,
                home: args.home,
                projectRoot: args.projectRoot,
            });
            if (record) out.push(record);
        }
        return out;
    });

const isMarkdownFile = (file: string): boolean => file.endsWith(".md");
const isWorkflowFile = (file: string): boolean => file.endsWith(".md") || file.endsWith(".workflow.js");
const isHookFile = (file: string): boolean =>
    file.endsWith(".json") || file.endsWith(".js") || file.endsWith(".ts") || file.endsWith(".sh");
const isJsonFile = (file: string): boolean => file.endsWith(".json");
const isMcpConfigFile = (file: string): boolean => {
    const normalized = normalizePath(file);
    return normalized.endsWith("/.mcp.json") || normalized.endsWith("/mcp.json") || normalized.endsWith("/mcp-servers.json");
};
const isOutputStylePath = (file: string): boolean =>
    file.includes("/output-styles/") || file.includes("/output_styles/");

const pluginArtifactKindFor = (file: string): GuidanceConfigArtifactKind | null => {
    const normalized = normalizePath(file);
    if (normalized.endsWith("/plugin.json")) return "plugin";
    if (normalized.endsWith("/SKILL.md")) return "skill";
    if (isMcpConfigFile(normalized)) return "mcp_server";
    if (isMarkdownFile(normalized) && (normalized.includes("/agents/") || normalized.includes("/subagents/"))) {
        return "agent_definition";
    }
    if (isMarkdownFile(normalized) && normalized.includes("/rules/")) return "rule";
    if (isHookFile(normalized) && normalized.includes("/hooks/")) return "hook";
    if (isWorkflowFile(normalized) && (normalized.includes("/commands/") || normalized.includes("/workflows/"))) {
        return "workflow";
    }
    if (isMarkdownFile(normalized) && isOutputStylePath(normalized)) return "output_style";
    return null;
};

const walkPluginArtifacts = (
    args: {
        readonly dir: string;
        readonly home: string;
        readonly projectRoot?: string | undefined;
        readonly maxDepth: number;
        readonly depth?: number | undefined;
    },
): Effect.Effect<GuidanceConfigArtifact[], never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const depth = args.depth ?? 0;
        if (depth > args.maxDepth) return [];
        const entryKind = yield* classifyNoFollow(args.dir);
        if (entryKind !== "Directory") return [];
        const entries = yield* fs.readDirectory(args.dir).pipe(orAbsent<ReadonlyArray<string>>([]));
        const out: GuidanceConfigArtifact[] = [];
        for (const entry of entries) {
            const full = path.join(args.dir, entry);
            const kind = yield* classifyNoFollow(full);
            if (kind === "Directory") {
                const nested = yield* walkPluginArtifacts({ ...args, dir: full, depth: depth + 1 });
                out.push(...nested);
                continue;
            }
            if (kind !== "File") continue;
            const artifactKind = pluginArtifactKindFor(full);
            if (!artifactKind) continue;
            const record = yield* fileRecord({
                path: full,
                kind: artifactKind,
                scope: "plugin",
                home: args.home,
                projectRoot: args.projectRoot,
            });
            if (record) out.push(record);
        }
        return out;
    });

const pluginArtifacts = (
    home: string,
    projectRoot: string | undefined,
): Effect.Effect<GuidanceConfigArtifact[], never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const path = yield* Path.Path;
        const pluginCache = path.join(home, ".claude", "plugins", "cache");
        return yield* walkPluginArtifacts({ dir: pluginCache, home, projectRoot, maxDepth: 8 });
    });

export const discoverClaudeConfigArtifacts = (
    opts: DiscoverClaudeConfigArtifactsOptions,
): Effect.Effect<GuidanceConfigArtifact[], never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const path = yield* Path.Path;
        const homeClaude = path.join(opts.home, ".claude");
        const out: GuidanceConfigArtifact[] = [];

        yield* addIfPresent(out, {
            path: path.join(homeClaude, "settings.json"),
            kind: "settings_config",
            scope: "user",
            home: opts.home,
            projectRoot: opts.projectRoot,
        });
        yield* addIfPresent(out, {
            path: path.join(homeClaude, "settings.local.json"),
            kind: "settings_config",
            scope: "local",
            home: opts.home,
            projectRoot: opts.projectRoot,
        });
        yield* addIfPresent(out, {
            path: path.join(homeClaude, "CLAUDE.md"),
            kind: "memory",
            scope: "user",
            home: opts.home,
            projectRoot: opts.projectRoot,
        });
        yield* addIfPresent(out, {
            path: path.join(homeClaude, ".mcp.json"),
            kind: "mcp_server",
            scope: "user",
            home: opts.home,
            projectRoot: opts.projectRoot,
        });

        out.push(...(yield* walkMatchingFiles({
            dir: path.join(homeClaude, "output-styles"),
            home: opts.home,
            projectRoot: opts.projectRoot,
            kind: "output_style",
            scope: "user",
            include: isMarkdownFile,
            maxDepth: 4,
        })));
        out.push(...(yield* walkMatchingFiles({
            dir: path.join(homeClaude, "agents"),
            home: opts.home,
            projectRoot: opts.projectRoot,
            kind: "agent_definition",
            scope: "user",
            include: isMarkdownFile,
            maxDepth: 3,
        })));
        out.push(...(yield* walkMatchingFiles({
            dir: path.join(homeClaude, "skills"),
            home: opts.home,
            projectRoot: opts.projectRoot,
            kind: "skill",
            scope: "user",
            include: (file) => file.endsWith("/SKILL.md"),
            maxDepth: 4,
        })));
        out.push(...(yield* walkMatchingFiles({
            dir: path.join(homeClaude, "rules"),
            home: opts.home,
            projectRoot: opts.projectRoot,
            kind: "rule",
            scope: "user",
            include: isMarkdownFile,
            maxDepth: 4,
        })));
        out.push(...(yield* walkMatchingFiles({
            dir: path.join(homeClaude, "workflows"),
            home: opts.home,
            projectRoot: opts.projectRoot,
            kind: "workflow",
            scope: "user",
            include: isWorkflowFile,
            maxDepth: 6,
        })));
        out.push(...(yield* walkMatchingFiles({
            dir: path.join(homeClaude, "commands"),
            home: opts.home,
            projectRoot: opts.projectRoot,
            kind: "workflow",
            scope: "user",
            include: isWorkflowFile,
            maxDepth: 6,
        })));
        out.push(...(yield* pluginArtifacts(opts.home, opts.projectRoot)));

        if (opts.projectRoot) {
            const projectClaude = path.join(opts.projectRoot, ".claude");
            for (const name of ["AGENTS.md", "CLAUDE.md"]) {
                yield* addIfPresent(out, {
                    path: path.join(opts.projectRoot, name),
                    kind: "guidance_doc",
                    scope: "project",
                    home: opts.home,
                    projectRoot: opts.projectRoot,
                });
            }
            yield* addIfPresent(out, {
                path: path.join(projectClaude, "settings.json"),
                kind: "settings_config",
                scope: "project",
                home: opts.home,
                projectRoot: opts.projectRoot,
            });
            yield* addIfPresent(out, {
                path: path.join(projectClaude, "settings.local.json"),
                kind: "settings_config",
                scope: "local",
                home: opts.home,
                projectRoot: opts.projectRoot,
            });
            yield* addIfPresent(out, {
                path: path.join(opts.projectRoot, ".mcp.json"),
                kind: "mcp_server",
                scope: "project",
                home: opts.home,
                projectRoot: opts.projectRoot,
            });
            yield* addIfPresent(out, {
                path: path.join(opts.projectRoot, ".worktreeinclude"),
                kind: "worktreeinclude",
                scope: "project",
                home: opts.home,
                projectRoot: opts.projectRoot,
            });
            out.push(...(yield* walkMatchingFiles({
                dir: path.join(projectClaude, "rules"),
                home: opts.home,
                projectRoot: opts.projectRoot,
                kind: "rule",
                scope: "project",
                include: isMarkdownFile,
                maxDepth: 4,
            })));
            out.push(...(yield* walkMatchingFiles({
                dir: path.join(projectClaude, "commands"),
                home: opts.home,
                projectRoot: opts.projectRoot,
                kind: "workflow",
                scope: "project",
                include: isWorkflowFile,
                maxDepth: 6,
            })));
            out.push(...(yield* walkMatchingFiles({
                dir: path.join(projectClaude, "workflows"),
                home: opts.home,
                projectRoot: opts.projectRoot,
                kind: "workflow",
                scope: "project",
                include: isWorkflowFile,
                maxDepth: 6,
            })));
            out.push(...(yield* walkMatchingFiles({
                dir: path.join(projectClaude, "agents"),
                home: opts.home,
                projectRoot: opts.projectRoot,
                kind: "agent_definition",
                scope: "project",
                include: isMarkdownFile,
                maxDepth: 3,
            })));
            out.push(...(yield* walkMatchingFiles({
                dir: path.join(projectClaude, "skills"),
                home: opts.home,
                projectRoot: opts.projectRoot,
                kind: "skill",
                scope: "project",
                include: (file) => file.endsWith("/SKILL.md"),
                maxDepth: 4,
            })));
        }

        return out.sort((a, b) => `${a.scope}:${a.kind}:${a.safePath}`.localeCompare(`${b.scope}:${b.kind}:${b.safePath}`));
    });

export const guidanceConfigArtifactKey = (
    record: Pick<GuidanceConfigArtifact, "provider" | "pathHash">,
): string => `${safeKeyPart(record.provider)}__${record.pathHash}`;

const intLiteral = (value: number): string =>
    Number.isFinite(value) ? Math.trunc(value).toString(10) : "0";

export const buildGuidanceConfigStatements = (
    records: readonly GuidanceConfigArtifact[],
): string[] =>
    records.map((record) =>
        `UPSERT ${recordRef(GUIDANCE_CONFIG_ARTIFACT_TABLE, guidanceConfigArtifactKey(record))} CONTENT ${surrealObject([
            ["provider", surrealString(record.provider)],
            ["kind", surrealString(record.kind)],
            ["scope", surrealString(record.scope)],
            ["safe_path", surrealString(record.safePath)],
            ["path_hash", surrealString(record.pathHash)],
            ["authority_kind", surrealString(record.authorityKind)],
            ["authority_hash", surrealString(record.authorityHash)],
            ["content_hash", surrealOptionString(record.contentHash)],
            ["parse_status", surrealString(record.parseStatus)],
            ["bytes", intLiteral(record.bytes)],
            ["token_estimate", intLiteral(record.tokenEstimate)],
            ["command_hashes_json", surrealJsonTextOption(record.commandHashes)],
            ["hook_event_names_json", surrealJsonTextOption(record.hookEventNames)],
            ["matcher_count", intLiteral(record.matcherCount)],
            ["mcp_server_names_json", surrealJsonTextOption(record.mcpServerNames)],
            ["env_keys_json", surrealJsonTextOption(record.envKeys)],
            ["enabled_tool_count", record.enabledToolCount === null ? "NONE" : intLiteral(record.enabledToolCount)],
            ["model", surrealOptionString(record.model)],
            ["reasoning_effort", surrealOptionString(record.reasoningEffort)],
            ["output_style", surrealOptionString(record.outputStyle)],
            ["permission_allow_count", intLiteral(record.permissionAllowCount)],
            ["permission_ask_count", intLiteral(record.permissionAskCount)],
            ["permission_deny_count", intLiteral(record.permissionDenyCount)],
            ["metadata_json", surrealJsonTextOption(record.metadata)],
            ["observed_at", "time::now()"],
        ])};`
    );

export const buildGuidanceConfigReconcileStatements = (
    records: readonly GuidanceConfigArtifact[],
    authorityHashes = uniqueSorted(records.map((record) => record.authorityHash)),
): string[] => {
    const pathHashes = uniqueSorted(records.map((record) => record.pathHash));
    const statements = [
        `DELETE ${GUIDANCE_CONFIG_ARTIFACT_TABLE} WHERE provider = ${surrealString("claude")} AND authority_hash IS NONE;`,
    ];
    if (authorityHashes.length > 0) {
        statements.unshift(
            `DELETE ${GUIDANCE_CONFIG_ARTIFACT_TABLE} WHERE provider = ${surrealString("claude")} AND authority_hash IN ${surrealValue(authorityHashes)} AND path_hash NOT IN ${surrealValue(pathHashes)};`,
        );
    }
    return statements;
};

export const buildGuidanceConfigPersistenceStatements = (
    records: readonly GuidanceConfigArtifact[],
    authorityHashes?: readonly string[] | undefined,
): string[] => [
    ...buildGuidanceConfigReconcileStatements(records, authorityHashes ? uniqueSorted(authorityHashes) : undefined),
    ...buildGuidanceConfigStatements(records),
];

export const ingestClaudeConfigArtifacts = (): Effect.Effect<
    IngestClaudeConfigStats,
    DbError,
    SurrealClient | AxConfig | FileSystem.FileSystem | Path.Path
> =>
    Effect.gen(function* () {
        const cfg = yield* AxConfig;
        const db = yield* SurrealClient;
        const records = yield* discoverClaudeConfigArtifacts({
            home: cfg.paths.home,
            projectRoot: process.cwd(),
        });
        const statements = buildGuidanceConfigPersistenceStatements(
            records,
            guidanceConfigAuthorityHashesForScan({
                home: cfg.paths.home,
                projectRoot: process.cwd(),
            }),
        );
        yield* executeStatementsWith(db, statements, { chunkSize: 500, label: "claudeConfig" });
        return {
            discovered: records.length,
            written: records.length,
        };
    });

export class ClaudeConfigStats extends BaseStageStats.extend<ClaudeConfigStats>("ClaudeConfigStats")({
    artifactsDiscovered: Schema.Number,
    artifactsWritten: Schema.Number,
}) {}

export const claudeConfigStage: StageDef<
    ClaudeConfigStats,
    SurrealClient | AxConfig | FileSystem.FileSystem | Path.Path
> = {
    meta: StageMeta.make({ key: "claude-config", deps: ["skills", "commands", "agent-def"], tags: ["ingest"] }),
    run: (_ctx: IngestContext) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const result = yield* ingestClaudeConfigArtifacts();
            return ClaudeConfigStats.make({
                durationMs: Date.now() - t0,
                summary: `ingested ${result.written} guidance/config artifacts`,
                artifactsDiscovered: result.discovered,
                artifactsWritten: result.written,
            });
        }),
};
