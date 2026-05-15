# Agent Wrapped Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local `/wrapped` dashboard page that turns the `ax` graph into an evidence-backed agent personality profile with a public-safe story-deck preview.

**Architecture:** Add a focused query/fetch layer that computes a `WrappedProfile` from existing graph tables, then render it in the dashboard through the established API route pattern. Keep public sanitization separate from internal scoring so future static/R2 publishing can reuse the sanitized profile without database access.

**Tech Stack:** Bun, TypeScript strict mode, Effect v4 beta, SurrealDB, React 19, TanStack Router, TanStack Query.

---

## File Structure

- Create `src/queries/wrapped.ts`: SurrealQL strings for usage overview, skills, tools, friction, verification, repositories, and sessions.
- Create `src/dashboard/wrapped.ts`: deterministic scoring, fact generation, sanitizer, and `fetchWrapped`.
- Create `src/dashboard/wrapped.test.ts`: unit tests for scoring and public sanitization.
- Modify `src/lib/shared/dashboard-types.ts`: add `WrappedProfile`, archetype, fact, evidence, usage, and public preview types.
- Modify `src/dashboard/server.ts`: add `GET /api/wrapped` and `GET /api/wrapped/public-preview`.
- Modify `src/dashboard/web/src/api.ts`: add `wrapped()` and `wrappedPublicPreview()`.
- Create `src/dashboard/web/src/routes/wrapped.tsx`: internal report plus public deck preview.
- Modify `src/dashboard/web/src/router.tsx`: register `/wrapped`.
- Modify `src/dashboard/web/src/Shell.tsx`: add `Wrapped` tab and prefetch.
- Modify `src/dashboard/web/src/styles.css`: route-specific styles for metric tiles, heatmap, archetype cards, and public preview.

R2 publishing and export-to-disk stay out of this first implementation plan. The v1 route should expose the profile and sanitized preview; a later plan can add `POST /api/wrapped/export`.

---

### Task 1: Shared Wrapped Types

**Files:**
- Modify: `src/lib/shared/dashboard-types.ts`

- [ ] **Step 1: Add shared wire types**

Append these types near the other dashboard response types:

```ts
// ---------------------------------------------------------------------------
// Agent Wrapped: personality-led usage recap
// ---------------------------------------------------------------------------

export type WrappedConfidence = "low" | "medium" | "high";
export type WrappedSensitivity = "public" | "aggregate" | "sensitive";

export interface WrappedPeriod {
    readonly label: string;
    readonly startedAt: string;
    readonly endedAt: string;
}

export interface WrappedEvidence {
    readonly kind: "session" | "tool" | "skill" | "project" | "query" | "insight";
    readonly label: string;
    readonly href?: string;
    readonly count?: number;
    readonly sensitive?: boolean;
}

export interface WrappedArchetype {
    readonly id: string;
    readonly label: string;
    readonly score: number;
    readonly confidence: WrappedConfidence;
    readonly publicLine: string;
    readonly internalExplanation: string;
    readonly evidence: ReadonlyArray<WrappedEvidence>;
}

export interface WrappedFact {
    readonly id: string;
    readonly title: string;
    readonly publicText: string;
    readonly internalText: string;
    readonly sensitivity: WrappedSensitivity;
    readonly evidence: ReadonlyArray<WrappedEvidence>;
}

export interface WrappedUsageDay {
    readonly date: string;
    readonly sessions: number;
    readonly turns: number;
    readonly tokens: number | null;
}

export interface WrappedUsageOverview {
    readonly sessions: number;
    readonly messages: number;
    readonly totalTokens: number | null;
    readonly activeDays: number;
    readonly currentStreakDays: number;
    readonly longestStreakDays: number;
    readonly peakHour: number | null;
    readonly favoriteModel: string | null;
    readonly tokenComparison: string | null;
    readonly days: ReadonlyArray<WrappedUsageDay>;
}

export interface WrappedMetrics {
    readonly toolCalls: number;
    readonly toolFailures: number;
    readonly distinctTools: number;
    readonly distinctSkills: number;
    readonly repositories: number;
    readonly verificationCalls: number;
    readonly spawnedAgents: number;
}

export interface WrappedPrivacySummary {
    readonly publicSafe: boolean;
    readonly redactedFields: ReadonlyArray<string>;
}

export interface WrappedProfile {
    readonly generatedAt: string;
    readonly period: WrappedPeriod;
    readonly usage: WrappedUsageOverview;
    readonly primaryArchetype: WrappedArchetype;
    readonly secondaryArchetypes: ReadonlyArray<WrappedArchetype>;
    readonly facts: ReadonlyArray<WrappedFact>;
    readonly metrics: WrappedMetrics;
    readonly privacy: WrappedPrivacySummary;
}
```

- [ ] **Step 2: Run typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS, or only pre-existing unrelated failures. No new references exist yet, so this should normally pass.

- [ ] **Step 3: Commit**

```bash
git add src/lib/shared/dashboard-types.ts
git commit -m "feat(wrapped): add shared profile types"
```

---

### Task 2: Wrapped Query Module

**Files:**
- Create: `src/queries/wrapped.ts`

- [ ] **Step 1: Create query constants**

Create `src/queries/wrapped.ts`:

```ts
const DAYS = 365;
export const WRAPPED_DAYS_LOOKBACK = DAYS;

export const WRAPPED_USAGE_SQL = `
SELECT
    count() AS sessions,
    math::sum(array::len((SELECT id FROM turn WHERE session = $parent.id))) AS messages,
    array::len(array::distinct(time::format(started_at, "%Y-%m-%d"))) AS active_days
FROM session
WHERE started_at > time::now() - ${DAYS}d;`;

export const WRAPPED_DAILY_ACTIVITY_SQL = `
SELECT
    time::format(started_at, "%Y-%m-%d") AS date,
    count() AS sessions,
    math::sum(array::len((SELECT id FROM turn WHERE session = $parent.id))) AS turns
FROM session
WHERE started_at > time::now() - ${DAYS}d
  AND started_at IS NOT NONE
GROUP BY date
ORDER BY date ASC;`;

export const WRAPPED_PEAK_HOUR_SQL = `
SELECT
    time::format(started_at, "%H") AS hour,
    count() AS count
FROM session
WHERE started_at > time::now() - ${DAYS}d
  AND started_at IS NOT NONE
GROUP BY hour
ORDER BY count DESC
LIMIT 1;`;

export const WRAPPED_MODEL_SQL = `
SELECT model, count() AS count
FROM session
WHERE started_at > time::now() - ${DAYS}d
  AND model IS NOT NONE
GROUP BY model
ORDER BY count DESC
LIMIT 1;`;

export const WRAPPED_SKILLS_SQL = `
SELECT out.name AS skill, count() AS count
FROM invoked
WHERE ts > time::now() - ${DAYS}d
  AND out.name IS NOT NONE
GROUP BY skill
ORDER BY count DESC
LIMIT 50;`;

export const WRAPPED_TOOLS_SQL = `
SELECT
    (command_norm ?? name) AS tool,
    count() AS count,
    math::sum(IF has_error = true THEN 1 ELSE 0 END) AS failures
FROM tool_call
WHERE ts > time::now() - ${DAYS}d
  AND (command_norm ?? name) IS NOT NONE
GROUP BY tool
ORDER BY count DESC
LIMIT 50;`;

export const WRAPPED_REPOSITORY_SQL = `
SELECT repository, count() AS count
FROM session
WHERE started_at > time::now() - ${DAYS}d
  AND repository IS NOT NONE
GROUP BY repository
ORDER BY count DESC
LIMIT 50;`;

export const WRAPPED_SPAWNED_SQL = `
SELECT count() AS count
FROM spawned
WHERE ts > time::now() - ${DAYS}d;`;
```

- [ ] **Step 2: Run typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/queries/wrapped.ts
git commit -m "feat(wrapped): add profile queries"
```

---

### Task 3: Scoring and Sanitizer Tests

**Files:**
- Create: `src/dashboard/wrapped.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/dashboard/wrapped.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { WrappedProfile } from "../lib/shared/dashboard-types.ts";
import {
    choosePrimaryArchetype,
    computeStreaks,
    makeInterestingFacts,
    sanitizeWrappedProfile,
} from "./wrapped.ts";

describe("computeStreaks", () => {
    test("computes current and longest day streaks", () => {
        const result = computeStreaks(
            ["2026-05-10", "2026-05-11", "2026-05-13", "2026-05-14", "2026-05-15"],
            new Date("2026-05-15T12:00:00Z"),
        );
        expect(result).toEqual({ currentStreakDays: 3, longestStreakDays: 3 });
    });
});

describe("choosePrimaryArchetype", () => {
    test("chooses The Verifier when verification calls dominate", () => {
        const result = choosePrimaryArchetype({
            verificationCalls: 42,
            toolFailures: 4,
            recoveredFailures: 0,
            distinctSkills: 8,
            distinctTools: 7,
            repositories: 2,
            spawnedAgents: 0,
            contextCalls: 3,
            refactorSignals: 1,
        });
        expect(result.primary.id).toBe("verifier");
        expect(result.primary.confidence).toBe("high");
    });
});

describe("makeInterestingFacts", () => {
    test("emits Token Maxxing for high token totals", () => {
        const facts = makeInterestingFacts({
            totalTokens: 2_000_000,
            peakHour: 19,
            favoriteModel: "Opus 4.7",
            verificationCalls: 10,
            distinctSkills: 12,
            spawnedAgents: 0,
            repositories: 2,
        });
        expect(facts.map((f) => f.id)).toContain("token-maxxing");
    });
});

describe("sanitizeWrappedProfile", () => {
    test("removes sensitive evidence labels from public profile", () => {
        const profile: WrappedProfile = {
            generatedAt: "2026-05-15T00:00:00.000Z",
            period: {
                label: "Last 365 days",
                startedAt: "2025-05-15T00:00:00.000Z",
                endedAt: "2026-05-15T00:00:00.000Z",
            },
            usage: {
                sessions: 1,
                messages: 2,
                totalTokens: 1000,
                activeDays: 1,
                currentStreakDays: 1,
                longestStreakDays: 1,
                peakHour: 19,
                favoriteModel: "Opus 4.7",
                tokenComparison: "You've used ~16x more tokens than The Great Gatsby.",
                days: [{ date: "2026-05-15", sessions: 1, turns: 2, tokens: null }],
            },
            primaryArchetype: {
                id: "context-curator",
                label: "The Context Curator",
                score: 9,
                confidence: "medium",
                publicLine: "You ground the agent before making it move.",
                internalExplanation: "Sensitive project /Users/necmttn/Projects/ax appeared often.",
                evidence: [
                    { kind: "project", label: "/Users/necmttn/Projects/ax", sensitive: true },
                    { kind: "query", label: "12 context calls", count: 12 },
                ],
            },
            secondaryArchetypes: [],
            facts: [],
            metrics: {
                toolCalls: 2,
                toolFailures: 0,
                distinctTools: 1,
                distinctSkills: 1,
                repositories: 1,
                verificationCalls: 0,
                spawnedAgents: 0,
            },
            privacy: { publicSafe: false, redactedFields: [] },
        };

        const publicProfile = sanitizeWrappedProfile(profile);
        expect(publicProfile.primaryArchetype.internalExplanation).toBe("");
        expect(publicProfile.primaryArchetype.evidence).toEqual([
            { kind: "query", label: "12 context calls", count: 12 },
        ]);
        expect(publicProfile.privacy.publicSafe).toBe(true);
        expect(publicProfile.privacy.redactedFields).toContain("sensitive evidence");
    });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
bun test src/dashboard/wrapped.test.ts
```

Expected: FAIL because `src/dashboard/wrapped.ts` does not exist.

- [ ] **Step 3: Commit tests**

Do not commit failing tests alone unless the team accepts red commits. If following strict green commits, skip commit here and commit with Task 4.

---

### Task 4: Wrapped Scoring Module

**Files:**
- Create: `src/dashboard/wrapped.ts`
- Test: `src/dashboard/wrapped.test.ts`

- [ ] **Step 1: Implement deterministic helpers**

Create `src/dashboard/wrapped.ts` with the exported helpers required by the tests:

```ts
import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";
import type {
    WrappedArchetype,
    WrappedFact,
    WrappedProfile,
} from "../lib/shared/dashboard-types.ts";
import {
    WRAPPED_DAILY_ACTIVITY_SQL,
    WRAPPED_MODEL_SQL,
    WRAPPED_PEAK_HOUR_SQL,
    WRAPPED_REPOSITORY_SQL,
    WRAPPED_SKILLS_SQL,
    WRAPPED_SPAWNED_SQL,
    WRAPPED_TOOLS_SQL,
    WRAPPED_USAGE_SQL,
} from "../queries/wrapped.ts";

export interface ArchetypeSignals {
    readonly verificationCalls: number;
    readonly toolFailures: number;
    readonly recoveredFailures: number;
    readonly distinctSkills: number;
    readonly distinctTools: number;
    readonly repositories: number;
    readonly spawnedAgents: number;
    readonly contextCalls: number;
    readonly refactorSignals: number;
}

const toNumber = (value: unknown): number => {
    const n = Number(value ?? 0);
    return Number.isFinite(n) ? n : 0;
};

const toString = (value: unknown): string | null =>
    typeof value === "string" && value.length > 0 ? value : null;

const confidence = (score: number): "low" | "medium" | "high" =>
    score >= 20 ? "high" : score >= 8 ? "medium" : "low";

export function computeStreaks(
    dates: ReadonlyArray<string>,
    now = new Date(),
): { currentStreakDays: number; longestStreakDays: number } {
    const unique = Array.from(new Set(dates)).sort();
    let longest = 0;
    let run = 0;
    let prev: Date | null = null;
    for (const date of unique) {
        const current = new Date(`${date}T00:00:00Z`);
        const diff =
            prev === null
                ? 1
                : Math.round((current.getTime() - prev.getTime()) / 86_400_000);
        run = diff === 1 ? run + 1 : 1;
        longest = Math.max(longest, run);
        prev = current;
    }

    let currentStreakDays = 0;
    const set = new Set(unique);
    const cursor = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
    ));
    while (set.has(cursor.toISOString().slice(0, 10))) {
        currentStreakDays += 1;
        cursor.setUTCDate(cursor.getUTCDate() - 1);
    }
    return { currentStreakDays, longestStreakDays: longest };
}

function archetype(
    id: string,
    label: string,
    score: number,
    publicLine: string,
    internalExplanation: string,
): WrappedArchetype {
    return {
        id,
        label,
        score,
        confidence: confidence(score),
        publicLine,
        internalExplanation,
        evidence: [{ kind: "query", label: `${Math.round(score)} signal score`, count: Math.round(score) }],
    };
}

export function choosePrimaryArchetype(signals: ArchetypeSignals): {
    primary: WrappedArchetype;
    secondary: ReadonlyArray<WrappedArchetype>;
} {
    const candidates = [
        archetype(
            "verifier",
            "The Verifier",
            signals.verificationCalls * 2,
            "You test before declaring victory.",
            "High verification and check activity before completion.",
        ),
        archetype(
            "debugger",
            "The Debugger",
            signals.toolFailures + signals.recoveredFailures * 2,
            "You turn failures into solved patterns.",
            "Tool failures and recovery evidence dominate the graph.",
        ),
        archetype(
            "orchestrator",
            "The Orchestrator",
            signals.spawnedAgents * 2 + signals.distinctTools,
            "You coordinate work across tools and agents.",
            "Subagent and tool-diversity signals are high.",
        ),
        archetype(
            "skill-collector",
            "The Skill Collector",
            signals.distinctSkills * 1.5,
            "You build by stacking specialized skills.",
            "Skill invocation diversity is the strongest signal.",
        ),
        archetype(
            "context-curator",
            "The Context Curator",
            signals.contextCalls * 2,
            "You ground the agent before making it move.",
            "Context, recall, and file-reading activity are high.",
        ),
        archetype(
            "repo-hopper",
            "The Repo Hopper",
            signals.repositories * 2,
            "You spread agent work across many codebases.",
            "Repository breadth is the strongest signal.",
        ),
    ].sort((a, b) => b.score - a.score);
    return {
        primary: candidates[0] ?? archetype("observer", "The Observer", 0, "Your graph is still warming up.", "Not enough activity yet."),
        secondary: candidates.slice(1, 4),
    };
}

export function makeInterestingFacts(input: {
    readonly totalTokens: number | null;
    readonly peakHour: number | null;
    readonly favoriteModel: string | null;
    readonly verificationCalls: number;
    readonly distinctSkills: number;
    readonly spawnedAgents: number;
    readonly repositories: number;
}): WrappedFact[] {
    const facts: WrappedFact[] = [];
    if ((input.totalTokens ?? 0) >= 1_000_000) {
        facts.push({
            id: "token-maxxing",
            title: "Token Maxxing",
            publicText: "You crossed the million-token mark.",
            internalText: `Total token estimate: ${input.totalTokens}.`,
            sensitivity: "aggregate",
            evidence: [{ kind: "query", label: "token total", count: input.totalTokens ?? 0 }],
        });
    }
    if (input.peakHour !== null) {
        facts.push({
            id: "peak-hour-agent",
            title: "Peak Hour Agent",
            publicText: `Your strongest agent hour was ${input.peakHour}:00.`,
            internalText: `Most sessions started during hour ${input.peakHour}.`,
            sensitivity: "aggregate",
            evidence: [{ kind: "query", label: "peak hour", count: input.peakHour }],
        });
    }
    if (input.verificationCalls >= 10) {
        facts.push({
            id: "verifycel",
            title: "Verifycel",
            publicText: "You kept asking the machine to prove it.",
            internalText: `${input.verificationCalls} verification-like commands were detected.`,
            sensitivity: "aggregate",
            evidence: [{ kind: "tool", label: "verification calls", count: input.verificationCalls }],
        });
    }
    if (input.distinctSkills >= 10) {
        facts.push({
            id: "skill-stacker",
            title: "Skill Stacker",
            publicText: "You built with a wide skill stack.",
            internalText: `${input.distinctSkills} distinct skills were invoked.`,
            sensitivity: "aggregate",
            evidence: [{ kind: "skill", label: "distinct skills", count: input.distinctSkills }],
        });
    }
    return facts;
}

export function sanitizeWrappedProfile(profile: WrappedProfile): WrappedProfile {
    const cleanEvidence = (evidence: WrappedArchetype["evidence"]) =>
        evidence
            .filter((item) => item.sensitive !== true)
            .map(({ sensitive: _sensitive, href: _href, ...item }) => item);
    return {
        ...profile,
        primaryArchetype: {
            ...profile.primaryArchetype,
            internalExplanation: "",
            evidence: cleanEvidence(profile.primaryArchetype.evidence),
        },
        secondaryArchetypes: profile.secondaryArchetypes.map((a) => ({
            ...a,
            internalExplanation: "",
            evidence: cleanEvidence(a.evidence),
        })),
        facts: profile.facts
            .filter((fact) => fact.sensitivity !== "sensitive")
            .map((fact) => ({
                ...fact,
                internalText: "",
                evidence: cleanEvidence(fact.evidence),
            })),
        privacy: {
            publicSafe: true,
            redactedFields: ["sensitive evidence", "internal explanations", "internal fact text", "evidence links"],
        },
    };
}

export function fetchWrapped(): Effect.Effect<WrappedProfile, DbError> {
    return Effect.gen(function* () {
        const db = yield* SurrealClient;
        const [
            usageRows,
            dailyRows,
            peakHourRows,
            modelRows,
            skillRows,
            toolRows,
            repositoryRows,
            spawnedRows,
        ] = yield* db.query<[
            Array<Record<string, unknown>>,
            Array<Record<string, unknown>>,
            Array<Record<string, unknown>>,
            Array<Record<string, unknown>>,
            Array<Record<string, unknown>>,
            Array<Record<string, unknown>>,
            Array<Record<string, unknown>>,
            Array<Record<string, unknown>>,
        ]>([
            WRAPPED_USAGE_SQL,
            WRAPPED_DAILY_ACTIVITY_SQL,
            WRAPPED_PEAK_HOUR_SQL,
            WRAPPED_MODEL_SQL,
            WRAPPED_SKILLS_SQL,
            WRAPPED_TOOLS_SQL,
            WRAPPED_REPOSITORY_SQL,
            WRAPPED_SPAWNED_SQL,
        ].join("\n"));

        const usage = usageRows[0] ?? {};
        const days = dailyRows.map((row) => ({
            date: toString(row.date) ?? "unknown",
            sessions: toNumber(row.sessions),
            turns: toNumber(row.turns),
            tokens: null,
        })).filter((day) => day.date !== "unknown");
        const streaks = computeStreaks(days.map((day) => day.date));
        const peakHour = peakHourRows[0] ? Number(toString(peakHourRows[0].hour)) : null;
        const tools = toolRows;
        const verificationCalls = tools
            .filter((row) => /test|check|verify|lint|typecheck/i.test(toString(row.tool) ?? ""))
            .reduce((sum, row) => sum + toNumber(row.count), 0);
        const metrics = {
            toolCalls: tools.reduce((sum, row) => sum + toNumber(row.count), 0),
            toolFailures: tools.reduce((sum, row) => sum + toNumber(row.failures), 0),
            distinctTools: tools.length,
            distinctSkills: skillRows.length,
            repositories: repositoryRows.length,
            verificationCalls,
            spawnedAgents: toNumber(spawnedRows[0]?.count),
        };
        const archetypes = choosePrimaryArchetype({
            verificationCalls,
            toolFailures: metrics.toolFailures,
            recoveredFailures: 0,
            distinctSkills: metrics.distinctSkills,
            distinctTools: metrics.distinctTools,
            repositories: metrics.repositories,
            spawnedAgents: metrics.spawnedAgents,
            contextCalls: tools
                .filter((row) => /recall|context|rg|sed|cat|find/i.test(toString(row.tool) ?? ""))
                .reduce((sum, row) => sum + toNumber(row.count), 0),
            refactorSignals: 0,
        });
        const totalTokens = null;
        const facts = makeInterestingFacts({
            totalTokens,
            peakHour,
            favoriteModel: toString(modelRows[0]?.model),
            verificationCalls,
            distinctSkills: metrics.distinctSkills,
            spawnedAgents: metrics.spawnedAgents,
            repositories: metrics.repositories,
        });
        return {
            generatedAt: new Date().toISOString(),
            period: {
                label: "Last 365 days",
                startedAt: new Date(Date.now() - 365 * 86_400_000).toISOString(),
                endedAt: new Date().toISOString(),
            },
            usage: {
                sessions: toNumber(usage.sessions),
                messages: toNumber(usage.messages),
                totalTokens,
                activeDays: toNumber(usage.active_days),
                ...streaks,
                peakHour,
                favoriteModel: toString(modelRows[0]?.model),
                tokenComparison: null,
                days,
            },
            primaryArchetype: archetypes.primary,
            secondaryArchetypes: archetypes.secondary,
            facts,
            metrics,
            privacy: { publicSafe: false, redactedFields: [] },
        };
    });
}
```

- [ ] **Step 2: Run focused tests**

Run:

```bash
bun test src/dashboard/wrapped.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/dashboard/wrapped.ts src/dashboard/wrapped.test.ts
git commit -m "feat(wrapped): score local agent profile"
```

---

### Task 5: Dashboard API Routes

**Files:**
- Modify: `src/dashboard/server.ts`
- Test: existing typecheck

- [ ] **Step 1: Import wrapped fetchers**

Add near the other dashboard imports:

```ts
import { fetchWrapped, sanitizeWrappedProfile } from "./wrapped.ts";
```

- [ ] **Step 2: Add API routes**

Inside `handleDashboardRequest`, before `/api/workflow`, add:

```ts
    if (url.pathname === "/api/wrapped" && req.method === "GET") {
        try {
            const payload = await Effect.runPromise(
                fetchWrapped().pipe(
                    Effect.provide(AppLayer),
                    Effect.scoped,
                ) as Effect.Effect<unknown>,
            );
            return jsonResponse(payload);
        } catch (err) {
            return jsonResponse(
                { error: err instanceof Error ? err.message : String(err) },
                500,
            );
        }
    }
    if (url.pathname === "/api/wrapped/public-preview" && req.method === "GET") {
        try {
            const payload = await Effect.runPromise(
                fetchWrapped().pipe(
                    Effect.map(sanitizeWrappedProfile),
                    Effect.provide(AppLayer),
                    Effect.scoped,
                ) as Effect.Effect<unknown>,
            );
            return jsonResponse(payload);
        } catch (err) {
            return jsonResponse(
                { error: err instanceof Error ? err.message : String(err) },
                500,
            );
        }
    }
```

- [ ] **Step 3: Run typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/dashboard/server.ts
git commit -m "feat(wrapped): expose dashboard api"
```

---

### Task 6: Web API Client and Router

**Files:**
- Modify: `src/dashboard/web/src/api.ts`
- Modify: `src/dashboard/web/src/router.tsx`
- Modify: `src/dashboard/web/src/Shell.tsx`
- Create: `src/dashboard/web/src/routes/wrapped.tsx`

- [ ] **Step 1: Add API client methods**

In `src/dashboard/web/src/api.ts`, import `WrappedProfile` from shared types and add:

```ts
    wrapped: (): Promise<WrappedProfile> => jsonFetch("/api/wrapped"),
    wrappedPublicPreview: (): Promise<WrappedProfile> =>
        jsonFetch("/api/wrapped/public-preview"),
```

- [ ] **Step 2: Create a minimal route component**

Create `src/dashboard/web/src/routes/wrapped.tsx`:

```tsx
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api.ts";
import type { WrappedProfile, WrappedUsageDay } from "@shared/dashboard-types.ts";
import { fmtCount, fmtTs } from "@shared/formatters.ts";

const hourLabel = (hour: number | null): string =>
    hour === null ? "n/a" : `${hour % 12 === 0 ? 12 : hour % 12} ${hour < 12 ? "AM" : "PM"}`;

const heat = (day: WrappedUsageDay, max: number): string => {
    if (max <= 0 || day.sessions <= 0) return "rgba(66, 104, 174, 0.12)";
    const ratio = Math.min(1, day.sessions / max);
    return `rgba(66, 104, 174, ${(0.22 + ratio * 0.68).toFixed(3)})`;
};

export function WrappedRoute() {
    const wrappedQuery = useQuery({
        queryKey: ["wrapped"],
        queryFn: () => api.wrapped(),
    });
    const publicQuery = useQuery({
        queryKey: ["wrapped-public-preview"],
        queryFn: () => api.wrappedPublicPreview(),
    });
    const data = wrappedQuery.data ?? null;
    const publicData = publicQuery.data ?? null;
    const error = wrappedQuery.error ? String(wrappedQuery.error) : null;
    const maxSessions = useMemo(
        () => Math.max(0, ...(data?.usage.days ?? []).map((day) => day.sessions)),
        [data],
    );

    return (
        <section className="panel wrapped">
            <header>
                <h2>Agent Wrapped</h2>
                <span className="meta">
                    {data ? `${data.period.label} · generated ${fmtTs(data.generatedAt)}` : ""}
                </span>
            </header>

            {error ? <div className="error">Error: {error}</div> : null}
            {wrappedQuery.isLoading && !data ? <div className="loading">Loading…</div> : null}

            {data ? (
                <>
                    <div className="wrapped-hero">
                        <div>
                            <span className="wrapped-kicker">Primary archetype</span>
                            <h3>{data.primaryArchetype.label}</h3>
                            <p>{data.primaryArchetype.publicLine}</p>
                            <small>{data.primaryArchetype.internalExplanation}</small>
                        </div>
                        <div className="wrapped-score">
                            <strong>{Math.round(data.primaryArchetype.score)}</strong>
                            <span>{data.primaryArchetype.confidence} confidence</span>
                        </div>
                    </div>

                    <div className="wrapped-metrics">
                        <Metric label="Sessions" value={fmtCount(data.usage.sessions)} />
                        <Metric label="Messages" value={fmtCount(data.usage.messages)} />
                        <Metric label="Total tokens" value={data.usage.totalTokens === null ? "n/a" : fmtCount(data.usage.totalTokens)} />
                        <Metric label="Active days" value={fmtCount(data.usage.activeDays)} />
                        <Metric label="Current streak" value={`${data.usage.currentStreakDays}d`} />
                        <Metric label="Longest streak" value={`${data.usage.longestStreakDays}d`} />
                        <Metric label="Peak hour" value={hourLabel(data.usage.peakHour)} />
                        <Metric label="Favorite model" value={data.usage.favoriteModel ?? "n/a"} />
                    </div>

                    <div className="wrapped-heatmap" aria-label="Daily activity heatmap">
                        {data.usage.days.map((day) => (
                            <span
                                key={day.date}
                                title={`${day.date}: ${day.sessions} sessions, ${day.turns} turns`}
                                style={{ backgroundColor: heat(day, maxSessions) }}
                            />
                        ))}
                    </div>

                    <h3 className="workflow-h3">Interesting facts</h3>
                    <div className="wrapped-facts">
                        {data.facts.map((fact) => (
                            <article key={fact.id}>
                                <h4>{fact.title}</h4>
                                <p>{fact.publicText}</p>
                                <small>{fact.internalText}</small>
                            </article>
                        ))}
                    </div>

                    <h3 className="workflow-h3">Public preview</h3>
                    {publicData ? <PublicPreview profile={publicData} /> : <div className="loading">Loading public preview…</div>}
                </>
            ) : null}
        </section>
    );
}

function Metric({ label, value }: { label: string; value: string }) {
    return (
        <div className="wrapped-metric">
            <span>{label}</span>
            <strong>{value}</strong>
        </div>
    );
}

function PublicPreview({ profile }: { profile: WrappedProfile }) {
    return (
        <div className="wrapped-public-preview">
            <article>
                <span>AX WRAPPED</span>
                <h4>{profile.primaryArchetype.label}</h4>
                <p>{profile.primaryArchetype.publicLine}</p>
                <small>{profile.privacy.redactedFields.length} sensitive field groups redacted</small>
            </article>
            {profile.facts.slice(0, 3).map((fact) => (
                <article key={fact.id}>
                    <span>{fact.id}</span>
                    <h4>{fact.title}</h4>
                    <p>{fact.publicText}</p>
                </article>
            ))}
        </div>
    );
}
```

- [ ] **Step 3: Register route**

In `src/dashboard/web/src/router.tsx`, import:

```ts
import { WrappedRoute } from "./routes/wrapped.tsx";
```

Add:

```ts
const wrappedRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/wrapped",
    component: WrappedRoute,
});
```

Add `wrappedRoute` to `routeTree`.

- [ ] **Step 4: Add shell tab**

In `src/dashboard/web/src/Shell.tsx`, extend the `Tab["to"]` union with `"/wrapped"` and add a tab:

```ts
        {
            to: "/wrapped",
            label: "Wrapped",
            prefetch: () =>
                queryClient.prefetchQuery({
                    queryKey: ["wrapped"],
                    queryFn: () => api.wrapped(),
                }),
        },
```

- [ ] **Step 5: Run typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/web/src/api.ts src/dashboard/web/src/routes/wrapped.tsx src/dashboard/web/src/router.tsx src/dashboard/web/src/Shell.tsx
git commit -m "feat(wrapped): add dashboard route"
```

---

### Task 7: Wrapped Dashboard Styles

**Files:**
- Modify: `src/dashboard/web/src/styles.css`

- [ ] **Step 1: Add route styles**

Append:

```css
.wrapped-hero {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 18px;
    align-items: end;
    padding: 18px;
    border: 1px solid var(--border);
    background: var(--panel-2);
    margin: 14px 0 18px;
}

.wrapped-kicker {
    display: block;
    color: var(--muted);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: .08em;
    margin-bottom: 8px;
}

.wrapped-hero h3 {
    margin: 0 0 8px;
    font-size: clamp(32px, 6vw, 64px);
    line-height: .95;
}

.wrapped-hero p {
    margin: 0 0 8px;
    font-size: 18px;
}

.wrapped-score {
    min-width: 140px;
    text-align: right;
}

.wrapped-score strong {
    display: block;
    font-size: 48px;
    line-height: 1;
}

.wrapped-score span {
    color: var(--muted);
    font-size: 12px;
    text-transform: uppercase;
}

.wrapped-metrics {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 8px;
}

.wrapped-metric {
    padding: 12px;
    border: 1px solid var(--border);
    background: var(--panel-2);
    min-height: 76px;
}

.wrapped-metric span {
    display: block;
    color: var(--muted);
    margin-bottom: 6px;
}

.wrapped-metric strong {
    display: block;
    font-size: 24px;
    line-height: 1.1;
    overflow-wrap: anywhere;
}

.wrapped-heatmap {
    display: grid;
    grid-template-columns: repeat(53, minmax(6px, 1fr));
    gap: 4px;
    margin: 16px 0 22px;
}

.wrapped-heatmap span {
    aspect-ratio: 1;
    border-radius: 3px;
}

.wrapped-facts,
.wrapped-public-preview {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
}

.wrapped-facts article,
.wrapped-public-preview article {
    border: 1px solid var(--border);
    background: var(--panel-2);
    padding: 14px;
}

.wrapped-facts h4,
.wrapped-public-preview h4 {
    margin: 0 0 8px;
    font-size: 22px;
}

.wrapped-public-preview article {
    min-height: 220px;
}

.wrapped-public-preview span {
    display: block;
    color: var(--muted);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: .08em;
    margin-bottom: 24px;
}

@media (max-width: 840px) {
    .wrapped-hero,
    .wrapped-metrics,
    .wrapped-facts,
    .wrapped-public-preview {
        grid-template-columns: 1fr;
    }

    .wrapped-score {
        text-align: left;
    }

    .wrapped-heatmap {
        grid-template-columns: repeat(18, minmax(10px, 1fr));
    }
}
```

- [ ] **Step 2: Build dashboard**

Run:

```bash
bun run dashboard:build
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/web/src/styles.css
git commit -m "feat(wrapped): style profile dashboard"
```

---

### Task 8: Verification and Manual Review

**Files:**
- No required code changes unless bugs are found.

- [ ] **Step 1: Run focused wrapped tests**

Run:

```bash
bun test src/dashboard/wrapped.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run broader relevant tests**

Run:

```bash
bun test src/dashboard/server.test.ts src/dashboard/wrapped.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 4: Build dashboard**

Run:

```bash
bun run dashboard:build
```

Expected: PASS.

- [ ] **Step 5: Start dashboard and inspect**

Run:

```bash
bun run src/cli/index.ts dashboard serve --port=1738
```

Open `http://localhost:1738/wrapped`.

Expected:

- Wrapped tab is visible.
- `/wrapped` loads without a console error.
- Metrics tiles render.
- Heatmap cells render even when sparse.
- Primary archetype appears.
- Public preview contains no repo names, file paths, command text, raw error text, or transcript snippets.

- [ ] **Step 6: Final commit if fixes were needed**

```bash
git status --short
git add <changed-files>
git commit -m "fix(wrapped): polish dashboard verification"
```

---

## Self-Review

Spec coverage:

- Internal `/wrapped` report: Tasks 5-7.
- Deterministic profile and archetypes: Tasks 3-4.
- Claude-style usage overview and heatmap: Tasks 2, 4, 6, 7.
- Interesting facts such as Token Maxxing and Verifycel: Tasks 3-4, rendered in Task 6.
- Public-safe preview and redaction: Tasks 3-6.
- Future R2 publishing: intentionally not implemented; data boundary is preserved by `sanitizeWrappedProfile`.

Placeholder scan:

- No task uses `TBD`, `TODO`, or unspecified implementation steps.
- Export-to-disk and R2 are excluded from v1 instead of left as partial tasks.

Type consistency:

- `WrappedProfile`, `WrappedArchetype`, `WrappedFact`, and `WrappedUsageOverview` are defined before use.
- API client, server routes, and React route all use the same `WrappedProfile` type.
