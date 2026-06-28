/**
 * `ax contribute pattern` - promote one of your local profile taste patterns,
 * or author one through structured prompts, into community/patterns/ via the
 * same fork+PR rails used by profile registration.
 */
import { Effect, Schema } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { prettyPrint } from "@ax/lib/json";
import { buildProfile } from "../../profile/render.ts";
import { openPatternContribution, patternFilePath } from "../../profile/pattern-contribution.ts";
import { PATTERN_CATEGORIES, TastePattern, type PatternCategory, type ProfileV1 } from "../../profile/schema.ts";
import { slugify } from "../../profile/taste.ts";
import { GitHubEnvLive } from "../../profile/github-env.ts";
import { gatherEnv } from "./profile.ts";
import type { RuntimeManifest } from "./manifest.ts";
import { fail, optionValue, parseCsvFlag } from "./shared.ts";

type ProseCategory = Exclude<PatternCategory, "stack-choice">;

export interface FreshPatternInput {
    readonly category?: string;
    readonly name?: string;
    readonly summary?: string;
    readonly slot?: string;
    readonly over?: string;
    readonly context?: string;
    readonly sessions?: number;
    readonly confidence?: number;
}

const isPatternCategory = (value: string): value is PatternCategory =>
    (PATTERN_CATEGORIES as readonly string[]).includes(value);

const promptText = (label: string, fallback = ""): string => {
    const suffix = fallback === "" ? "" : ` [${fallback}]`;
    const answer = globalThis.prompt?.(`${label}${suffix}:`);
    const text = (answer ?? "").trim();
    return text === "" ? fallback : text;
};

const numberFromPrompt = (label: string, fallback: number): number => {
    const text = promptText(label, String(fallback));
    const n = Number(text);
    if (!Number.isFinite(n)) throw new Error(`${label} must be a number`);
    return n;
};

const evidence = (sessions: number | undefined, confidence: number | undefined) => {
    const s = sessions ?? 1;
    const c = confidence ?? 0.5;
    if (!Number.isInteger(s) || s <= 0) throw new Error("sessions must be a positive integer");
    if (!Number.isFinite(c) || c < 0 || c > 1) throw new Error("confidence must be a number from 0 to 1");
    return { sessions: s, confidence: c };
};

export function buildFreshPattern(input: FreshPatternInput): TastePattern {
    const category = input.category?.trim() ?? "";
    if (!isPatternCategory(category)) {
        throw new Error(`category must be one of: ${PATTERN_CATEGORIES.join(", ")}`);
    }
    const name = slugify(input.name ?? "");
    if (name === "") throw new Error("name is required");
    const ev = evidence(input.sessions, input.confidence);
    const summary = input.summary?.trim() ?? "";
    const slot = slugify(input.slot ?? "");
    if (category === "stack-choice" && slot === "") throw new Error("slot is required for stack-choice patterns");
    if (category !== "stack-choice" && summary === "") throw new Error("summary is required for prose patterns");

    const raw = category === "stack-choice"
        ? {
            category,
            name,
            slot,
            ...(parseCsvFlag(input.over).length > 0 ? { over: parseCsvFlag(input.over) } : {}),
            ...(input.context?.trim() ? { context: input.context.trim() } : {}),
            evidence: ev,
        }
        : {
            category: category as ProseCategory,
            name,
            summary,
            evidence: ev,
        };

    try {
        return Schema.decodeUnknownSync(TastePattern)(raw);
    } catch (e) {
        throw new Error(`invalid fresh pattern: ${e instanceof Error ? e.message : String(e)}`);
    }
}

export function patternChoiceLabel(pattern: TastePattern, index: number): string {
    const label = pattern.category === "stack-choice"
        ? `${pattern.category}/${pattern.slot}/${pattern.name}`
        : `${pattern.category}/${pattern.name}`;
    return `${index + 1}. ${label} - ${pattern.evidence.sessions} sessions, confidence ${pattern.evidence.confidence}`;
}

export function selectProfilePattern(patterns: readonly TastePattern[], selector: string): TastePattern {
    const trimmed = selector.trim();
    const index = Number(trimmed);
    if (Number.isInteger(index) && index >= 1 && index <= patterns.length) return patterns[index - 1]!;

    const matches = patterns.filter((pattern) =>
        `${pattern.category}/${pattern.name}` === trimmed || pattern.name === trimmed
    );
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) throw new Error(`pattern selector "${selector}" is ambiguous; use category/name`);
    throw new Error(`no taste pattern matched "${selector}"`);
}

const promptFreshPattern = (seed: FreshPatternInput): TastePattern => {
    console.log(`categories: ${PATTERN_CATEGORIES.join(", ")}`);
    const category = seed.category ?? promptText("category", "workflow");
    const name = seed.name ?? promptText("name");
    const sessions = seed.sessions ?? numberFromPrompt("evidence sessions", 1);
    const confidence = seed.confidence ?? numberFromPrompt("evidence confidence (0-1)", 0.5);
    if (category === "stack-choice") {
        return buildFreshPattern({
            ...seed,
            category,
            name,
            sessions,
            confidence,
            slot: seed.slot ?? promptText("slot"),
            over: seed.over ?? promptText("preferred over (comma-separated)", ""),
            context: seed.context ?? promptText("context", ""),
        });
    }
    return buildFreshPattern({
        ...seed,
        category,
        name,
        sessions,
        confidence,
        summary: seed.summary ?? promptText("summary"),
    });
};

const patternFromProfile = (profile: ProfileV1, selector: string | undefined): TastePattern | "fresh" => {
    const patterns = profile.taste?.patterns ?? [];
    if (patterns.length === 0) {
        throw new Error("profile has no taste patterns; rerun with --fresh to author one through prompts");
    }
    if (selector !== undefined && selector.trim() !== "") return selectProfilePattern(patterns, selector);

    console.log("Taste patterns:");
    for (let i = 0; i < patterns.length; i++) console.log(`  ${patternChoiceLabel(patterns[i]!, i)}`);
    const answer = promptText("Choose a number/category/name, or type new", "1");
    if (answer.toLowerCase() === "new" || answer.toLowerCase() === "fresh") return "fresh";
    return selectProfilePattern(patterns, answer);
};

export const cmdContributePattern = (input: {
    readonly window: number;
    readonly patternSelector?: string;
    readonly fresh: boolean;
    readonly freshInput: FreshPatternInput;
    readonly yes: boolean;
}) =>
    Effect.gen(function* () {
        if (!Number.isInteger(input.window) || input.window <= 0) {
            fail(`ax contribute pattern: --window must be a positive integer (got "${input.window}")`);
        }

        let pattern: TastePattern;
        if (input.fresh) {
            pattern = promptFreshPattern(input.freshInput);
        } else {
            const env = yield* gatherEnv();
            const profile = yield* buildProfile({ windowDays: input.window, includeCost: false, env });
            const picked = patternFromProfile(profile, input.patternSelector);
            pattern = picked === "fresh" ? promptFreshPattern(input.freshInput) : picked;
        }

        const path = patternFilePath(pattern);
        console.log(prettyPrint(pattern));
        console.log(`\nThis pattern will be proposed as ${path}.`);
        if (!input.yes) {
            const ans = promptText("Open PR? [y/N]").toLowerCase();
            if (ans !== "y" && ans !== "yes") {
                console.log("Aborted. No PR was opened.");
                return;
            }
        }

        const result = yield* openPatternContribution({ pattern });
        console.log(`pattern PR: ${result.prUrl}`);
        console.log(`file:       ${result.path}`);
    }).pipe(Effect.provide(GitHubEnvLive));

const contributePatternCommand = Command.make(
    "pattern",
    {
        window: Flag.integer("window").pipe(Flag.withDefault(30)),
        pattern: Flag.string("pattern").pipe(Flag.optional),
        fresh: Flag.boolean("fresh").pipe(Flag.withDefault(false)),
        category: Flag.choice("category", PATTERN_CATEGORIES).pipe(Flag.optional),
        name: Flag.string("name").pipe(Flag.optional),
        summary: Flag.string("summary").pipe(Flag.optional),
        slot: Flag.string("slot").pipe(Flag.optional),
        over: Flag.string("over").pipe(Flag.optional),
        context: Flag.string("context").pipe(Flag.optional),
        sessions: Flag.integer("sessions").pipe(Flag.optional),
        confidence: Flag.float("confidence").pipe(Flag.optional),
        yes: Flag.boolean("yes").pipe(Flag.withDefault(false)),
    },
    ({ window, pattern, fresh, category, name, summary, slot, over, context, sessions, confidence, yes }) => {
        const categoryValue = optionValue(category);
        const nameValue = optionValue(name);
        const summaryValue = optionValue(summary);
        const slotValue = optionValue(slot);
        const overValue = optionValue(over);
        const contextValue = optionValue(context);
        const sessionsValue = optionValue(sessions);
        const confidenceValue = optionValue(confidence);
        const patternSelector = optionValue(pattern);
        const freshInput: FreshPatternInput = {
            ...(categoryValue !== undefined ? { category: categoryValue } : {}),
            ...(nameValue !== undefined ? { name: nameValue } : {}),
            ...(summaryValue !== undefined ? { summary: summaryValue } : {}),
            ...(slotValue !== undefined ? { slot: slotValue } : {}),
            ...(overValue !== undefined ? { over: overValue } : {}),
            ...(contextValue !== undefined ? { context: contextValue } : {}),
            ...(sessionsValue !== undefined ? { sessions: sessionsValue } : {}),
            ...(confidenceValue !== undefined ? { confidence: confidenceValue } : {}),
        };
        return cmdContributePattern({
            window,
            ...(patternSelector !== undefined ? { patternSelector } : {}),
            fresh,
            freshInput,
            yes,
        });
    },
).pipe(
    Command.withDescription(
        "Promote a profile taste pattern, or author one with structured prompts, into community/patterns/ via a draftable PR. " +
        "--pattern=<index|category/name|name>  --fresh  --category=... --name=... --summary=... --sessions=N --confidence=N --yes",
    ),
);

export const contributeCommand = Command.make("contribute").pipe(
    Command.withDescription("Contribute ax community artifacts through fork+PR rails"),
    Command.withSubcommands([contributePatternCommand]),
);

export const contributeRuntime: RuntimeManifest = {
    contribute: {
        kind: "db-conditional",
        fallback: "none",
        subcommands: {
            pattern: (args) => args.includes("--fresh") ? "none" : "db",
        },
    },
};
