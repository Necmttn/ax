import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, FileSystem, Layer, Path } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import {
    buildGuidanceConfigStatements,
    claudeConfigStage,
    discoverClaudeConfigArtifacts,
    parseClaudeConfigArtifact,
    parseClaudeSettingsArtifact,
} from "./claude-config.ts";

const FsLayer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

const runFs = <A, E>(
    effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(FsLayer)));

const tempDirs: string[] = [];

const makeTempDir = async () => {
    const dir = await mkdtemp(join(tmpdir(), "ax-claude-config-"));
    tempDirs.push(dir);
    return dir;
};

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const write = async (root: string, relPath: string, content: string) => {
    const abs = join(root, relPath);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, content);
    return abs;
};

describe("parseClaudeSettingsArtifact", () => {
    test("extracts safe settings metadata without raw secrets or commands", () => {
        const record = parseClaudeSettingsArtifact({
            scope: "user",
            path: "/Users/alice/.claude/settings.json",
            home: "/Users/alice",
            text: JSON.stringify({
                model: "claude-opus-4-20250514",
                effortLevel: "high",
                outputStyle: "concise",
                env: {
                    ANTHROPIC_API_KEY: "sk-secret",
                    SAFE_FLAG: "true",
                },
                permissions: {
                    allow: ["Bash(git status:*)", "Read(/Users/alice/private.txt)"],
                    ask: ["Edit(/tmp/foo)"],
                    deny: ["Bash(rm -rf:*)"],
                },
                hooks: {
                    PreToolUse: [
                        {
                            matcher: "Bash",
                            hooks: [
                                {
                                    type: "command",
                                    command: "curl https://example.invalid/?token=secret-token",
                                },
                            ],
                        },
                        {
                            matcher: { tools: ["Write", "Edit"] },
                            hooks: [{ type: "command", command: "echo other-secret" }],
                        },
                    ],
                    Stop: [{ hooks: [{ type: "command", command: "notify-send done" }] }],
                },
                mcpServers: {
                    github: {
                        command: "npx",
                        env: { GITHUB_TOKEN: "ghp_secret" },
                    },
                    "local-db": {
                        url: "http://127.0.0.1:9999",
                    },
                },
                enabledTools: ["Read", "Write", "Bash"],
            }),
        });

        expect(record.provider).toBe("claude");
        expect(record.kind).toBe("settings_config");
        expect(record.scope).toBe("user");
        expect(record.safePath).toBe("~/.claude/settings.json");
        expect(record.parseStatus).toBe("ok");
        expect(record.model).toBe("claude-opus-4-20250514");
        expect(record.reasoningEffort).toBe("high");
        expect(record.outputStyle).toBe("concise");
        expect(record.permissionAllowCount).toBe(2);
        expect(record.permissionAskCount).toBe(1);
        expect(record.permissionDenyCount).toBe(1);
        expect(record.hookEventNames).toEqual(["PreToolUse", "Stop"]);
        expect(record.matcherCount).toBe(2);
        expect(record.commandHashes).toHaveLength(3);
        expect(record.commandHashes.every((hash) => /^[0-9a-f]{64}$/.test(hash))).toBe(true);
        expect(record.envKeys).toEqual(["ANTHROPIC_API_KEY", "SAFE_FLAG"]);
        expect(record.mcpServerNames).toEqual(["github", "local-db"]);
        expect(record.enabledToolCount).toBe(3);

        const serialized = JSON.stringify(record);
        expect(serialized).not.toContain("sk-secret");
        expect(serialized).not.toContain("secret-token");
        expect(serialized).not.toContain("echo other-secret");
        expect(serialized).not.toContain("Bash(git status");
        expect(serialized).not.toContain("/Users/alice/private.txt");
        expect(serialized).not.toContain("ghp_secret");
        expect(serialized).not.toContain("/Users/alice/.claude/settings.json");
    });

    test("invalid JSON records parse failure metadata without throwing", () => {
        const record = parseClaudeSettingsArtifact({
            scope: "project",
            path: "/repo/.claude/settings.json",
            projectRoot: "/repo",
            text: "{ nope",
        });

        expect(record.parseStatus).toBe("invalid_json");
        expect(record.model).toBeNull();
        expect(record.permissionAllowCount).toBe(0);
        expect(record.hookEventNames).toEqual([]);
        expect(record.mcpServerNames).toEqual([]);
        expect(record.commandHashes).toEqual([]);
    });
});

describe("parseClaudeConfigArtifact", () => {
    test("classifies generic guidance artifacts with hashes and size estimates only", () => {
        const record = parseClaudeConfigArtifact({
            kind: "guidance_doc",
            scope: "project",
            path: "/repo/AGENTS.md",
            projectRoot: "/repo",
            text: "# Private workflow\nDo not store this body.",
        });

        expect(record.provider).toBe("claude");
        expect(record.kind).toBe("guidance_doc");
        expect(record.safePath).toBe("$PROJECT/AGENTS.md");
        expect(record.parseStatus).toBe("ok");
        expect(record.contentHash).toMatch(/^[0-9a-f]{64}$/);
        expect(record.pathHash).toMatch(/^[0-9a-f]{64}$/);
        expect(record.bytes).toBeGreaterThan(0);
        expect(record.tokenEstimate).toBeGreaterThan(0);
        expect(JSON.stringify(record)).not.toContain("Do not store this body");
    });
});

describe("buildGuidanceConfigStatements", () => {
    test("emits metadata-only statements without raw private values", () => {
        const record = parseClaudeSettingsArtifact({
            scope: "user",
            path: "/Users/alice/.claude/settings.json",
            home: "/Users/alice",
            text: JSON.stringify({
                env: { SECRET_ENV: "env-secret" },
                permissions: { allow: ["Bash(cat ~/.ssh/id_rsa:*)"] },
                hooks: {
                    PreToolUse: [
                        {
                            matcher: "Bash",
                            hooks: [{ type: "command", command: "cat ~/.ssh/id_rsa" }],
                        },
                    ],
                },
                mcpServers: { secretServer: { env: { TOKEN: "mcp-secret" } } },
            }),
        });

        const [statement] = buildGuidanceConfigStatements([record]);

        expect(statement).toContain("UPSERT guidance_config_artifact:");
        expect(statement).toContain("provider: \"claude\"");
        expect(statement).toContain("kind: \"settings_config\"");
        expect(statement).toContain("safe_path: \"~/.claude/settings.json\"");
        expect(statement).toContain("permission_allow_count: 1");
        expect(statement).toContain("SECRET_ENV");
        expect(statement).toContain("PreToolUse");
        expect(statement).toContain("secretServer");
        expect(statement).not.toContain("env-secret");
        expect(statement).not.toContain("mcp-secret");
        expect(statement).not.toContain("cat ~/.ssh/id_rsa");
        expect(statement).not.toContain("Bash(cat");
        expect(statement).not.toContain("/Users/alice");
    });
});

describe("discoverClaudeConfigArtifacts", () => {
    test("discovers configured Claude guidance and config files with safe paths", async () => {
        const home = await makeTempDir();
        const projectRoot = await makeTempDir();

        await write(home, ".claude/settings.json", JSON.stringify({ model: "fable" }));
        await write(home, ".claude/CLAUDE.md", "private user memory");
        await write(home, ".claude/output-styles/brief.md", "# brief");
        await write(home, ".claude/agents/reviewer.md", "---\nname: reviewer\n---\nbody");
        await write(home, ".claude/skills/review/SKILL.md", "---\nname: review\n---\nbody");
        await write(home, ".claude/plugins/cache/market/plugin-a/1.0.0/plugin.json", "{}");
        await write(projectRoot, "AGENTS.md", "# project agents");
        await write(projectRoot, "CLAUDE.md", "# project claude");
        await write(projectRoot, ".claude/settings.json", JSON.stringify({ outputStyle: "minimal" }));
        await write(projectRoot, ".claude/settings.local.json", JSON.stringify({ env: { SECRET: "nope" } }));
        await write(projectRoot, ".claude/rules/no-secrets.md", "# rule");
        await write(projectRoot, ".claude/commands/review.md", "# workflow");
        await write(projectRoot, ".claude/agents/project-agent.md", "---\nname: project-agent\n---\nbody");
        await write(projectRoot, ".mcp.json", JSON.stringify({ mcpServers: { github: {} } }));
        await write(projectRoot, ".worktreeinclude", "src/**");

        const records = await runFs(discoverClaudeConfigArtifacts({ home, projectRoot }));
        const signatures = records.map((record) => `${record.scope}:${record.kind}:${record.safePath}`).sort();

        expect(signatures).toContain("user:settings_config:~/.claude/settings.json");
        expect(signatures).toContain("user:memory:~/.claude/CLAUDE.md");
        expect(signatures).toContain("user:output_style:~/.claude/output-styles/brief.md");
        expect(signatures).toContain("user:agent_definition:~/.claude/agents/reviewer.md");
        expect(signatures).toContain("user:skill:~/.claude/skills/review/SKILL.md");
        expect(signatures).toContain("plugin:plugin:~/.claude/plugins/cache/market/plugin-a/1.0.0/plugin.json");
        expect(signatures).toContain("project:guidance_doc:$PROJECT/AGENTS.md");
        expect(signatures).toContain("project:guidance_doc:$PROJECT/CLAUDE.md");
        expect(signatures).toContain("project:settings_config:$PROJECT/.claude/settings.json");
        expect(signatures).toContain("local:settings_config:$PROJECT/.claude/settings.local.json");
        expect(signatures).toContain("project:rule:$PROJECT/.claude/rules/no-secrets.md");
        expect(signatures).toContain("project:workflow:$PROJECT/.claude/commands/review.md");
        expect(signatures).toContain("project:agent_definition:$PROJECT/.claude/agents/project-agent.md");
        expect(signatures).toContain("project:mcp_server:$PROJECT/.mcp.json");
        expect(signatures).toContain("project:worktreeinclude:$PROJECT/.worktreeinclude");

        expect(records.every((record) => record.pathHash.length === 64)).toBe(true);
        expect(records.every((record) => record.safePath.startsWith(home) === false)).toBe(true);
        expect(records.every((record) => record.safePath.startsWith(projectRoot) === false)).toBe(true);
        expect(JSON.stringify(records)).not.toContain("private user memory");
        expect(JSON.stringify(records)).not.toContain("nope");
    });
});

describe("claudeConfigStage", () => {
    test("is an ingest stage after catalog stages", () => {
        expect(claudeConfigStage.meta.key).toBe("claude-config");
        expect(claudeConfigStage.meta.deps).toEqual(["skills", "commands", "agent-def"]);
        expect(claudeConfigStage.meta.tags).toEqual(["ingest"]);
    });
});
