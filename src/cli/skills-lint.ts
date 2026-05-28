/**
 * `ax skills lint` - read filled classify briefs from `.ax/tasks/classify-*.md`
 * and write `plays_role` edges with `source="brief"`. Mirrors the
 * `axctl improve accept` → `axctl improve lint` reconciliation pattern.
 *
 * A brief is "filled" when its YAML frontmatter contains a non-empty
 * `primary_role: <string>`. Otherwise it is pending; leave it alone.
 */
import { Effect } from "effect";
import { join } from "node:path";
import { readdir, readFile, unlink } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { RecordId, SurrealClient, type SurrealClientShape } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parsed frontmatter from a classify brief. */
interface BriefFrontmatter {
    readonly ax_classify: string;
    readonly primary_role: string;
    readonly secondary: string[];
    readonly confidence: number;
    readonly rationale: string | undefined;
}

export interface LintBriefResult {
    readonly file: string;
    /** "applied" = edges written + file removed; "pending" = no primary_role; "error" = something went wrong */
    readonly action: "applied" | "pending" | "error";
    /** The skill name from ax_classify, when present */
    readonly skill?: string;
    /** Number of edges written (primary + secondary deduplicated) */
    readonly edgesWritten?: number;
    /** Human-readable error message for action="error" */
    readonly error?: string;
}

export interface LintReport {
    readonly briefs: LintBriefResult[];
    readonly applied: number;
    readonly pending: number;
    readonly errors: number;
    readonly dryRun: boolean;
}

export interface SkillsLintOptions {
    readonly taskDir: string;
    readonly dryRun: boolean;
    readonly json: boolean;
}

// ---------------------------------------------------------------------------
// YAML frontmatter extraction
// ---------------------------------------------------------------------------

/**
 * Extract YAML frontmatter from a markdown file. Returns the raw YAML string
 * between the first `---` delimiters, or null if none found.
 */
function extractFrontmatter(content: string): string | null {
    // Match `---\n...\n---` at the start (optional leading BOM/whitespace)
    const match = content.match(/^(?:﻿)?\s*---\n([\s\S]*?)\n---/);
    return match ? match[1]! : null;
}

/**
 * Parse and validate a classify brief file.
 * Returns null when the brief is pending (no primary_role) so the caller can
 * skip it silently.
 * Throws a descriptive string error when the brief is malformed.
 */
function parseBrief(
    content: string,
    filePath: string,
): BriefFrontmatter | null | { error: string } {
    const raw = extractFrontmatter(content);
    if (!raw) {
        return { error: `no YAML frontmatter found in ${filePath}` };
    }

    let parsed: unknown;
    try {
        parsed = parseYaml(raw);
    } catch (e) {
        return { error: `YAML parse error in ${filePath}: ${e instanceof Error ? e.message : String(e)}` };
    }

    if (typeof parsed !== "object" || parsed === null) {
        return { error: `frontmatter is not an object in ${filePath}` };
    }

    const fm = parsed as Record<string, unknown>;

    // ax_classify is REQUIRED
    const ax_classify = typeof fm["ax_classify"] === "string" ? fm["ax_classify"].trim() : "";
    if (!ax_classify) {
        return { error: `missing or empty ax_classify in ${filePath}` };
    }

    // primary_role is REQUIRED to be filled - if absent/empty this is pending
    const primary_role = typeof fm["primary_role"] === "string" ? fm["primary_role"].trim() : "";
    if (!primary_role) {
        // Pending brief - not an error, just not ready yet
        return null;
    }

    // secondary is optional; coerce to string[]
    let secondary: string[] = [];
    if (Array.isArray(fm["secondary"])) {
        secondary = fm["secondary"]
            .filter((s): s is string => typeof s === "string")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
    } else if (typeof fm["secondary"] === "string" && fm["secondary"].trim()) {
        secondary = [fm["secondary"].trim()];
    }

    // confidence is optional float [0,1], default 1.0
    let confidence = 1.0;
    if (typeof fm["confidence"] === "number" && isFinite(fm["confidence"])) {
        confidence = Math.max(0, Math.min(1, fm["confidence"]));
    }

    // rationale is optional free-form string
    const rationale =
        typeof fm["rationale"] === "string" && fm["rationale"].trim()
            ? fm["rationale"].trim()
            : undefined;

    return { ax_classify, primary_role, secondary, confidence, rationale };
}

// ---------------------------------------------------------------------------
// Skill lookup
// ---------------------------------------------------------------------------

/**
 * Resolve a skill's record key (id part only) by its name.
 * Returns null when not found.
 */
const lookupSkillKey = (
    db: SurrealClientShape,
    skillName: string,
): Effect.Effect<string | null, DbError> =>
    Effect.gen(function* () {
        const result = yield* db.query<[Array<{ id: unknown }>]>(
            "SELECT id FROM skill WHERE name = $name LIMIT 1;",
            { name: skillName },
        );
        const rows = result?.[0] ?? [];
        if (rows.length === 0) return null;
        const id = rows[0]!.id;
        if (typeof id === "string") {
            const colon = id.indexOf(":");
            return colon >= 0 ? id.slice(colon + 1) : id;
        }
        if (id !== null && typeof id === "object" && "id" in id) {
            return String((id as { id: unknown }).id);
        }
        return null;
    });

// ---------------------------------------------------------------------------
// Core brief-application logic
// ---------------------------------------------------------------------------

/**
 * Apply one filled brief: upsert role nodes, sweep old brief edges, write
 * new edges. If ALL writes succeed, remove the file.
 *
 * Returns a LintBriefResult describing what happened.
 */
const applyBrief = (
    db: SurrealClientShape,
    filePath: string,
    fm: BriefFrontmatter,
    dryRun: boolean,
): Effect.Effect<LintBriefResult, DbError> =>
    Effect.gen(function* () {
        const { ax_classify, primary_role, secondary, confidence, rationale } = fm;

        // Resolve skill record id by name
        const skillKey = yield* lookupSkillKey(db, ax_classify);
        if (skillKey === null) {
            return {
                file: filePath,
                action: "error" as const,
                skill: ax_classify,
                error: `skill not found: "${ax_classify}"`,
            };
        }

        // Normalise + deduplicate roles (primary first, then secondary)
        const seen = new Set<string>();
        const allRoles: string[] = [];
        for (const r of [primary_role, ...secondary]) {
            const norm = r.trim().toLowerCase();
            if (!norm || seen.has(norm)) continue;
            seen.add(norm);
            allRoles.push(norm);
        }

        if (dryRun) {
            return {
                file: filePath,
                action: "applied" as const,
                skill: ax_classify,
                edgesWritten: allRoles.length,
            };
        }

        // Inline record id literal (SDK RecordId bindings in db.query silently
        // produce empty results - see src/lib/shared/graph-query.ts:132 and
        // src/ingest/skill-role.ts:23).
        const skillLit = `skill:\`${skillKey}\``;

        // Sweep ALL prior brief-sourced edges for this skill before writing
        // the current set (handles role shrinkage atomically).
        yield* db.query(
            `DELETE plays_role WHERE in = ${skillLit} AND source = "brief";`,
        );

        // Upsert role nodes + RELATE edges
        let edgesWritten = 0;
        const rationaleSql =
            rationale !== undefined
                ? `, rationale = ${JSON.stringify(rationale)}`
                : "";
        for (const roleName of allRoles) {
            const roleId = new RecordId("role", roleName);
            yield* db.upsert(roleId, { name: roleName });

            const roleLit = `role:\`${roleName}\``;
            yield* db.query(
                `RELATE ${skillLit}->plays_role->${roleLit} SET source = "brief", confidence = ${confidence}${rationaleSql}, since = time::now();`,
            );
            edgesWritten += 1;
        }

        // Remove the brief file only after ALL writes succeed
        yield* Effect.promise(() => unlink(filePath));

        return {
            file: filePath,
            action: "applied" as const,
            skill: ax_classify,
            edgesWritten,
        };
    });

// ---------------------------------------------------------------------------
// Main exported command
// ---------------------------------------------------------------------------

export const cmdSkillsLint = (opts: SkillsLintOptions): Effect.Effect<void, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;

        // Collect all classify-*.md files from the task dir
        const files: string[] = yield* Effect.promise(async () => {
            try {
                const entries = await readdir(opts.taskDir);
                return entries
                    .filter((e) => e.startsWith("classify-") && e.endsWith(".md"))
                    .map((e) => join(opts.taskDir, e))
                    .sort();
            } catch {
                // Task dir doesn't exist yet - zero briefs is fine
                return [];
            }
        });

        const results: LintBriefResult[] = [];

        for (const filePath of files) {
            const content = yield* Effect.promise(async () => {
                try {
                    return await readFile(filePath, "utf8");
                } catch {
                    return null;
                }
            });

            if (content === null) {
                // File disappeared between readdir and readFile - skip
                continue;
            }

            const parsed = parseBrief(content, filePath);

            // Malformed brief
            if (parsed !== null && "error" in parsed) {
                results.push({
                    file: filePath,
                    action: "error",
                    error: parsed.error,
                });
                continue;
            }

            // Pending brief (no primary_role)
            if (parsed === null) {
                results.push({
                    file: filePath,
                    action: "pending",
                });
                continue;
            }

            // Filled brief - apply it (may produce an error result if skill not found)
            const result = yield* applyBrief(db, filePath, parsed, opts.dryRun).pipe(
                Effect.catchTag("DbError", (e) =>
                    Effect.succeed({
                        file: filePath,
                        action: "error" as const,
                        skill: parsed.ax_classify,
                        error: `DB error: ${e.message}`,
                    }),
                ),
            );
            results.push(result);
        }

        const applied = results.filter((r) => r.action === "applied").length;
        const pending = results.filter((r) => r.action === "pending").length;
        const errors = results.filter((r) => r.action === "error").length;

        const report: LintReport = {
            briefs: results,
            applied,
            pending,
            errors,
            dryRun: opts.dryRun,
        };

        if (opts.json) {
            console.log(JSON.stringify(report, null, 2));
            return;
        }

        // Human-readable output
        for (const r of results) {
            const fileName = r.file.split("/").pop() ?? r.file;
            if (r.action === "applied") {
                const dryTag = opts.dryRun ? " (dry-run)" : "";
                console.log(
                    `applied  ${fileName}  skill=${r.skill ?? "?"}  edges=${r.edgesWritten ?? 0}${dryTag}`,
                );
            } else if (r.action === "error") {
                console.error(`error    ${fileName}  ${r.error ?? "unknown error"}`);
            }
            // pending briefs are silently skipped (as spec'd)
        }

        if (results.length === 0) {
            console.log("no classify briefs found.");
            return;
        }

        const parts: string[] = [];
        if (applied > 0) parts.push(`${applied} applied${opts.dryRun ? " (dry-run)" : ""}`);
        if (pending > 0) parts.push(`${pending} pending`);
        if (errors > 0) parts.push(`${errors} error${errors === 1 ? "" : "s"}`);
        console.log(parts.join(", ") + ".");
    });
