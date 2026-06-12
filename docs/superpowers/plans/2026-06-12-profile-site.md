# Profile Site Routes (Plan 4 of 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ax.necmttn.com/u/<login>` renders any registered user's live profile (from their gist), and `/leaders` renders the nightly-compiled multi-board leaderboard + trending-skills board.

**Architecture:** Two new file-based routes in the TanStack Start SPA (`apps/site/app/routes/`). Both are client-fetch pages (params/dynamic data → SPA fallback, like the existing `/s/$owner/$gistId` share viewer): a small typed fetch/validate lib (`app/lib/community.ts`, manual validation in the `session-share.ts` style - the site does NOT depend on effect, so no ProfileV1 Schema import) pulls `community/users/<login>.json` + the gist's `ax-profile.json` (per-user page) and `community/leaderboard.json` + `skill-stats.json` (leaders page) from raw.githubusercontent / gist raw URLs. Manual loading/error/404 states (no tanstack-query in the stack). `/patterns` is DEFERRED - `community/patterns/` doesn't exist until `ax contribute pattern` ships.

**Tech Stack:** TanStack Start (file routes, `createFileRoute`, `notFound()`), React 19, Tailwind v4 + CSS-variable theme (`app/styles/globals.css` vars: `--ink --page --panel --line --muted --green --blue --mono`), bun:test for the lib.

**Conventions that bite:**
- Site typecheck needs a prior build (`routeTree.gen` codegen): run `cd apps/site && bun run build` before `bun run typecheck` in that workspace.
- Param routes are NOT prerendered - they ride the SPA fallback via `public/_redirects` (`/* /index.html 200`); no `_redirects` change needed.
- No tanstack-query: use the `useEffect` + manual state pattern; model after `routes/s.$owner.$gistId.tsx` for a param route and `app/lib/session-share.ts:126-169` for defensive validation.
- New nav links go in `app/components/landing-sections/site-header.tsx` `<nav className="top-nav">`.
- All gist/compiled-JSON strings are untrusted: render as text only (React escapes by default - just never use dangerouslySetInnerHTML), and validate shapes before use.
- Raw data URLs: registration `https://raw.githubusercontent.com/Necmttn/ax/main/community/users/<login>.json`; profile `https://gist.githubusercontent.com/<owner>/<gistId>/raw/ax-profile.json`; compiled `https://raw.githubusercontent.com/Necmttn/ax/main/community/{leaderboard,skill-stats}.json`. All CORS-safe.

**File structure:**

```
apps/site/app/lib/community.ts          # types + validateProfileV1/validateLeaderboard + fetchers
apps/site/app/lib/community.test.ts
apps/site/app/routes/u.$login.tsx       # per-user profile page
apps/site/app/routes/leaders.tsx        # leaderboard (tabs incl. trending skills)
apps/site/app/components/landing-sections/site-header.tsx   # + Leaders nav link
```

---

### Task 1: Community data lib

**Files:**
- Create: `apps/site/app/lib/community.ts`
- Test: `apps/site/app/lib/community.test.ts`

- [ ] **Step 1: Read the validation exemplar** - `apps/site/app/lib/session-share.ts:120-170` (isRecord helper + throw-on-invalid style).

- [ ] **Step 2: Write the failing test**

```ts
// apps/site/app/lib/community.test.ts
import { describe, expect, test } from "bun:test";
import {
    profileGistRawUrl,
    registrationRawUrl,
    validateLeaderboard,
    validateProfileV1,
    validateRegistration,
} from "./community";

const validProfile = {
    v: 1,
    github: "necmttn",
    generated_at: "2026-06-12T19:00:00Z",
    window_days: 30,
    stats: {
        sessions: 142, active_days: 26, streak_days: 12,
        tokens: { prompt: 31, completion: 7, total: 38 },
        cost_usd: 214.3,
        models: [{ name: "fable", share: 0.58, cost_usd: 124 }],
        harnesses: ["claude", "codex"],
    },
    rig: {
        skills: [{ name: "tdd", source: "superpowers", runs: 88 }],
        hooks: ["enforce-worktree"],
        routing_table: true,
        rules: { count: 14 },
    },
    taste: {
        patterns: [{
            category: "failure-mode", name: "edit-loop-thrash",
            summary: "stop and re-read",
            evidence: { sessions: 12, confidence: 0.8, trend: "rising" },
        }],
    },
};

describe("validateProfileV1", () => {
    test("accepts a valid profile (cost + taste optional both ways)", () => {
        expect(validateProfileV1(validProfile).github).toBe("necmttn");
        const { taste: _t, ...rest } = validProfile;
        const stats = { ...validProfile.stats };
        delete (stats as Record<string, unknown>).cost_usd;
        expect(validateProfileV1({ ...rest, stats }).taste).toBeUndefined();
    });
    test("rejects wrong version / missing stats / non-object", () => {
        expect(() => validateProfileV1({ ...validProfile, v: 2 })).toThrow();
        expect(() => validateProfileV1({ v: 1 })).toThrow();
        expect(() => validateProfileV1("nope")).toThrow();
    });
});

describe("validateRegistration", () => {
    test("accepts {github, gist_id, joined}; rejects junk", () => {
        expect(validateRegistration({ github: "a", gist_id: "f00", joined: "2026-06-12" }).gist_id).toBe("f00");
        expect(() => validateRegistration({ github: "a" })).toThrow();
    });
});

describe("validateLeaderboard", () => {
    test("accepts boards shape; rejects rows without login/value", () => {
        const lb = {
            compiled_at: "2026-06-12T03:00:00Z",
            window_days: 30,
            boards: {
                tokens: [{ login: "a", value: 2 }],
                sessions: [], streak: [], cost: [],
            },
        };
        expect(validateLeaderboard(lb).boards.tokens[0]!.login).toBe("a");
        expect(() => validateLeaderboard({ boards: { tokens: [{ nope: 1 }] } })).toThrow();
    });
});

describe("urls", () => {
    test("registration + gist raw urls", () => {
        expect(registrationRawUrl("Necmttn")).toBe(
            "https://raw.githubusercontent.com/Necmttn/ax/main/community/users/necmttn.json",
        );
        expect(profileGistRawUrl("necmttn", "abc123")).toBe(
            "https://gist.githubusercontent.com/necmttn/abc123/raw/ax-profile.json",
        );
    });
    test("login is sanitized before url interpolation", () => {
        expect(() => registrationRawUrl("../evil")).toThrow();
    });
});
```

- [ ] **Step 3: Run (`cd apps/site && bun test app/lib/community.test.ts`), verify FAIL**

- [ ] **Step 4: Implement** `apps/site/app/lib/community.ts` - mirror session-share.ts style:

```ts
/**
 * Community data: typed fetch + validation for profile gists and the
 * nightly-compiled leaderboard. Validation is intentionally manual (the
 * site does not depend on effect/Schema); throw-on-invalid mirrors
 * session-share.ts. Everything fetched here is untrusted user data -
 * validate shapes, render as text only.
 */

const REPO_RAW = "https://raw.githubusercontent.com/Necmttn/ax/main";
const LOGIN_RE = /^[A-Za-z0-9-]{1,39}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

const num = (v: unknown, what: string): number => {
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`invalid ${what}`);
    return v;
};
const str = (v: unknown, what: string): string => {
    if (typeof v !== "string") throw new Error(`invalid ${what}`);
    return v;
};

// --- profile -----------------------------------------------------------------

export interface ProfileModel {
    readonly name: string;
    readonly share: number;
    readonly cost_usd?: number;
}
export interface ProfileSkill {
    readonly name: string;
    readonly source: string;
    readonly runs: number;
}
export interface TastePattern {
    readonly category: string;
    readonly name: string;
    readonly summary?: string;
    readonly slot?: string;
    readonly over?: readonly string[];
    readonly context?: string;
    readonly evidence: { readonly sessions: number; readonly confidence: number; readonly last_reinforced?: string; readonly trend?: string };
}
export interface ProfileV1 {
    readonly v: 1;
    readonly github: string;
    readonly generated_at: string;
    readonly window_days: number;
    readonly stats: {
        readonly sessions: number;
        readonly active_days: number;
        readonly streak_days: number;
        readonly tokens: { readonly prompt: number; readonly completion: number; readonly total: number };
        readonly cost_usd?: number;
        readonly models: readonly ProfileModel[];
        readonly harnesses: readonly string[];
    };
    readonly rig: {
        readonly skills: readonly ProfileSkill[];
        readonly hooks: readonly string[];
        readonly routing_table: boolean;
        readonly rules?: { readonly count: number };
    };
    readonly taste?: { readonly patterns: readonly TastePattern[] };
}

export function validateProfileV1(value: unknown): ProfileV1 {
    if (!isRecord(value) || value.v !== 1) throw new Error("not a v1 ax profile");
    const stats = value.stats;
    const rig = value.rig;
    if (!isRecord(stats) || !isRecord(rig)) throw new Error("profile missing stats/rig");
    const tokens = stats.tokens;
    if (!isRecord(tokens)) throw new Error("profile missing tokens");
    num(stats.sessions, "sessions");
    num(tokens.total, "tokens.total");
    str(value.github, "github");
    if (!Array.isArray(stats.models) || !Array.isArray(stats.harnesses)) throw new Error("invalid stats arrays");
    if (!Array.isArray(rig.skills) || !Array.isArray(rig.hooks)) throw new Error("invalid rig arrays");
    for (const m of stats.models) {
        if (!isRecord(m)) throw new Error("invalid model row");
        str(m.name, "model.name");
        num(m.share, "model.share");
    }
    for (const s of rig.skills) {
        if (!isRecord(s)) throw new Error("invalid skill row");
        str(s.name, "skill.name");
        num(s.runs, "skill.runs");
    }
    if (value.taste !== undefined) {
        if (!isRecord(value.taste) || !Array.isArray(value.taste.patterns)) throw new Error("invalid taste");
        for (const p of value.taste.patterns) {
            if (!isRecord(p) || !isRecord(p.evidence)) throw new Error("invalid pattern");
            str(p.category, "pattern.category");
            str(p.name, "pattern.name");
        }
    }
    return value as unknown as ProfileV1;
}

// --- registration --------------------------------------------------------------

export interface Registration {
    readonly github: string;
    readonly gist_id: string;
    readonly joined: string;
}

export function validateRegistration(value: unknown): Registration {
    if (!isRecord(value)) throw new Error("invalid registration");
    return {
        github: str(value.github, "github"),
        gist_id: str(value.gist_id, "gist_id"),
        joined: str(value.joined, "joined"),
    };
}

// --- leaderboard ----------------------------------------------------------------

export interface BoardRow {
    readonly login: string;
    readonly value: number;
}
export interface Leaderboard {
    readonly compiled_at: string;
    readonly window_days: number;
    readonly boards: {
        readonly tokens: readonly BoardRow[];
        readonly sessions: readonly BoardRow[];
        readonly streak: readonly BoardRow[];
        readonly cost: readonly BoardRow[];
    };
}

export function validateLeaderboard(value: unknown): Leaderboard {
    if (!isRecord(value) || !isRecord(value.boards)) throw new Error("invalid leaderboard");
    const boards: Record<string, BoardRow[]> = {};
    for (const key of ["tokens", "sessions", "streak", "cost"] as const) {
        const rows = (value.boards as Record<string, unknown>)[key];
        if (!Array.isArray(rows)) throw new Error(`invalid board ${key}`);
        boards[key] = rows.map((r) => {
            if (!isRecord(r)) throw new Error(`invalid row in ${key}`);
            return { login: str(r.login, "login"), value: num(r.value, "value") };
        });
    }
    return {
        compiled_at: typeof value.compiled_at === "string" ? value.compiled_at : "",
        window_days: typeof value.window_days === "number" ? value.window_days : 30,
        boards: boards as Leaderboard["boards"],
    };
}

export type SkillStats = Record<string, { readonly users: number; readonly runs: number }>;

export function validateSkillStats(value: unknown): SkillStats {
    if (!isRecord(value)) throw new Error("invalid skill stats");
    const out: Record<string, { users: number; runs: number }> = {};
    for (const [k, v] of Object.entries(value)) {
        if (!isRecord(v)) continue;
        if (typeof v.users === "number" && typeof v.runs === "number") {
            out[k] = { users: v.users, runs: v.runs };
        }
    }
    return out;
}

// --- urls + fetchers --------------------------------------------------------------

export function registrationRawUrl(login: string): string {
    if (!LOGIN_RE.test(login)) throw new Error("invalid login");
    return `${REPO_RAW}/community/users/${login.toLowerCase()}.json`;
}

export function profileGistRawUrl(owner: string, gistId: string): string {
    if (!LOGIN_RE.test(owner) || !/^[a-f0-9]+$/i.test(gistId)) throw new Error("invalid gist ref");
    return `https://gist.githubusercontent.com/${owner}/${gistId}/raw/ax-profile.json`;
}

export const leaderboardUrl = `${REPO_RAW}/community/leaderboard.json`;
export const skillStatsUrl = `${REPO_RAW}/community/skill-stats.json`;

async function fetchJson(url: string): Promise<unknown> {
    const res = await fetch(url);
    if (res.status === 404) throw Object.assign(new Error("not found"), { notFound: true });
    if (!res.ok) throw new Error(`fetch failed (${res.status})`);
    return res.json();
}

/** registration -> gist -> validated profile. Throws {notFound:true} when unregistered. */
export async function fetchProfile(login: string): Promise<ProfileV1> {
    const reg = validateRegistration(await fetchJson(registrationRawUrl(login)));
    return validateProfileV1(await fetchJson(profileGistRawUrl(reg.github, reg.gist_id)));
}

export async function fetchLeaderboard(): Promise<Leaderboard> {
    return validateLeaderboard(await fetchJson(leaderboardUrl));
}

export async function fetchSkillStats(): Promise<SkillStats> {
    return validateSkillStats(await fetchJson(skillStatsUrl));
}
```

- [ ] **Step 5: Run tests, verify PASS (6 tests). Commit**

```bash
git add apps/site/app/lib/community.ts apps/site/app/lib/community.test.ts
git commit -m "feat(site): community data lib - profile/leaderboard fetch + validation"
```

---

### Task 2: `/u/$login` route

**Files:**
- Create: `apps/site/app/routes/u.$login.tsx`
- Reference: `apps/site/app/routes/s.$owner.$gistId.tsx` (param route shape, head()), `routes/index.tsx` (SiteHeader/SiteFooter usage)

- [ ] **Step 1: Implement the route** - client-fetch with manual states; render-as-text everywhere; CSS-variable styling consistent with the site:

```tsx
// apps/site/app/routes/u.$login.tsx
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { SiteHeader } from "~/components/landing-sections/site-header";
import { SiteFooter } from "~/components/landing-sections/site-footer";
import { fetchProfile, type ProfileV1 } from "~/lib/community";

export const Route = createFileRoute("/u/$login")({
    head: ({ params }) => ({
        meta: [
            { title: `@${params.login} - ax profile` },
            { name: "description", content: `${params.login}'s agent profile: usage, rig, and taste from the ax graph.` },
        ],
    }),
    component: ProfilePage,
});

type State =
    | { kind: "loading" }
    | { kind: "not-found" }
    | { kind: "error"; message: string }
    | { kind: "ready"; profile: ProfileV1 };

function ProfilePage() {
    const { login } = Route.useParams();
    const [state, setState] = useState<State>({ kind: "loading" });

    useEffect(() => {
        let alive = true;
        setState({ kind: "loading" });
        fetchProfile(login)
            .then((profile) => alive && setState({ kind: "ready", profile }))
            .catch((e: unknown) => {
                if (!alive) return;
                const notFound = typeof e === "object" && e !== null && (e as { notFound?: boolean }).notFound === true;
                setState(notFound
                    ? { kind: "not-found" }
                    : { kind: "error", message: e instanceof Error ? e.message : String(e) });
            });
        return () => { alive = false; };
    }, [login]);

    return (
        <>
            <SiteHeader />
            <main className="profile-page">
                {state.kind === "loading" && <p className="muted">loading @{login}…</p>}
                {state.kind === "not-found" && (
                    <section>
                        <h1>@{login} isn't on ax yet</h1>
                        <p>Publish your own profile: <code>ax profile publish</code></p>
                    </section>
                )}
                {state.kind === "error" && <p className="muted">couldn't load profile: {state.message}</p>}
                {state.kind === "ready" && <ProfileCard profile={state.profile} />}
            </main>
            <SiteFooter />
        </>
    );
}

const fmt = (n: number): string => Intl.NumberFormat("en-US", { notation: "compact" }).format(n);

function ProfileCard({ profile: p }: { profile: ProfileV1 }) {
    return (
        <article>
            <header>
                <h1>@{p.github}</h1>
                <p className="muted">last {p.window_days} days · updated {p.generated_at.slice(0, 10)} · powered by <Link to="/">ax</Link></p>
            </header>

            <section className="stat-row">
                <Stat label="sessions" value={fmt(p.stats.sessions)} />
                <Stat label="tokens" value={fmt(p.stats.tokens.total)} />
                {p.stats.cost_usd !== undefined && <Stat label="est. spend" value={`$${p.stats.cost_usd.toFixed(0)}`} />}
                <Stat label="streak" value={`${p.stats.streak_days}d`} />
                <Stat label="active days" value={String(p.stats.active_days)} />
            </section>

            <section>
                <h2>models</h2>
                {p.stats.models.map((m) => (
                    <div className="bar-row" key={m.name}>
                        <span className="bar-label">{m.name}</span>
                        <span className="bar-track"><span className="bar-fill" style={{ width: `${Math.min(100, m.share * 100)}%` }} /></span>
                        <span className="bar-value">{(m.share * 100).toFixed(0)}%{m.cost_usd !== undefined ? ` · $${m.cost_usd.toFixed(0)}` : ""}</span>
                    </div>
                ))}
                <p className="muted">harnesses: {p.stats.harnesses.join(", ")}</p>
            </section>

            <section>
                <h2>rig</h2>
                <p className="muted">
                    {p.rig.skills.length} skills · {p.rig.hooks.length} hooks · routing table: {p.rig.routing_table ? "yes" : "no"}
                    {p.rig.rules ? ` · ${p.rig.rules.count} rules` : ""}
                </p>
                <ul>
                    {p.rig.skills.slice(0, 15).map((s) => (
                        <li key={`${s.source}:${s.name}`}>
                            {s.name} <span className="muted">({s.source}, {fmt(s.runs)} runs)</span>
                        </li>
                    ))}
                </ul>
            </section>

            {p.taste && p.taste.patterns.length > 0 && (
                <section>
                    <h2>taste</h2>
                    <ul>
                        {p.taste.patterns.map((t) => (
                            <li key={`${t.category}/${t.name}`}>
                                <strong>{t.category === "stack-choice" && t.slot ? `${t.slot}: ${t.name}` : t.name}</strong>
                                {t.summary ? <> - {t.summary}</> : null}
                                <span className="muted"> (confidence {t.evidence.confidence}, {t.evidence.sessions} sessions{t.evidence.trend ? `, ${t.evidence.trend}` : ""})</span>
                            </li>
                        ))}
                    </ul>
                </section>
            )}
        </article>
    );
}

function Stat({ label, value }: { label: string; value: string }) {
    return (
        <div className="stat">
            <div className="stat-value">{value}</div>
            <div className="stat-label muted">{label}</div>
        </div>
    );
}
```

- [ ] **Step 2: Add minimal CSS** to `apps/site/app/styles/globals.css` (append; reuse vars):

```css
/* --- profile + leaders pages --- */
.profile-page, .leaders-page {
    max-width: var(--shell-max);
    margin: 0 auto;
    padding: 32px var(--shell-pad) 64px;
}
.stat-row { display: flex; gap: 28px; flex-wrap: wrap; margin: 20px 0; }
.stat-value { font-size: 1.6rem; font-family: var(--mono); }
.muted { color: var(--muted); }
.bar-row { display: flex; align-items: center; gap: 10px; margin: 4px 0; font-family: var(--mono); font-size: 0.85rem; }
.bar-label { width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar-track { flex: 1; height: 8px; background: var(--line); border-radius: 4px; overflow: hidden; }
.bar-fill { display: block; height: 100%; background: var(--green); }
.bar-value { width: 110px; text-align: right; }
.leaders-tabs { display: flex; gap: 8px; margin: 16px 0; flex-wrap: wrap; }
.leaders-tabs button { font: inherit; padding: 6px 14px; border: 1px solid var(--line); background: var(--panel); cursor: pointer; border-radius: 6px; }
.leaders-tabs button[aria-selected="true"] { background: var(--ink); color: var(--page); }
.leaders-table { width: 100%; border-collapse: collapse; font-family: var(--mono); font-size: 0.9rem; }
.leaders-table td, .leaders-table th { padding: 8px 10px; border-bottom: 1px solid var(--line); text-align: left; }
.leaders-table td:last-child, .leaders-table th:last-child { text-align: right; }
```

- [ ] **Step 3: Build + verify**

```bash
cd apps/site && bun run build && bun run typecheck
```
Expected: build succeeds (route appears in route tree), typecheck clean.

- [ ] **Step 4: Commit**

```bash
git add apps/site/app/routes/u.\$login.tsx apps/site/app/styles/globals.css
git commit -m "feat(site): /u/<login> profile page"
```

---

### Task 3: `/leaders` route

**Files:**
- Create: `apps/site/app/routes/leaders.tsx`

- [ ] **Step 1: Implement**

```tsx
// apps/site/app/routes/leaders.tsx
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { SiteHeader } from "~/components/landing-sections/site-header";
import { SiteFooter } from "~/components/landing-sections/site-footer";
import {
    fetchLeaderboard,
    fetchSkillStats,
    type Leaderboard,
    type SkillStats,
} from "~/lib/community";

export const Route = createFileRoute("/leaders")({
    head: () => ({
        meta: [
            { title: "ax leaders - measured agent usage" },
            { name: "description", content: "Token, session, streak, and spend leaderboards measured from real agent telemetry. Join with `ax profile publish`." },
        ],
    }),
    component: LeadersPage,
});

const BOARDS = ["tokens", "sessions", "streak", "cost", "skills"] as const;
type Board = (typeof BOARDS)[number];

const fmt = (n: number): string => Intl.NumberFormat("en-US", { notation: "compact" }).format(n);
const valueLabel: Record<Exclude<Board, "skills">, (v: number) => string> = {
    tokens: fmt,
    sessions: fmt,
    streak: (v) => `${v}d`,
    cost: (v) => `$${v.toFixed(0)}`,
};

type State =
    | { kind: "loading" }
    | { kind: "empty" }
    | { kind: "error"; message: string }
    | { kind: "ready"; lb: Leaderboard; skills: SkillStats };

function LeadersPage() {
    const [state, setState] = useState<State>({ kind: "loading" });
    const [board, setBoard] = useState<Board>("tokens");

    useEffect(() => {
        let alive = true;
        Promise.all([fetchLeaderboard(), fetchSkillStats().catch(() => ({}) as SkillStats)])
            .then(([lb, skills]) => alive && setState({ kind: "ready", lb, skills }))
            .catch((e: unknown) => {
                if (!alive) return;
                const notFound = typeof e === "object" && e !== null && (e as { notFound?: boolean }).notFound === true;
                setState(notFound ? { kind: "empty" } : { kind: "error", message: e instanceof Error ? e.message : String(e) });
            });
        return () => { alive = false; };
    }, []);

    return (
        <>
            <SiteHeader />
            <main className="leaders-page">
                <h1>leaders</h1>
                <p className="muted">
                    Measured from real agent telemetry (last 30 days), self-reported by each
                    user's local ax graph. Join: <code>ax profile publish</code>
                </p>

                {state.kind === "loading" && <p className="muted">loading…</p>}
                {state.kind === "empty" && (
                    <p>No leaderboard compiled yet - be the first: <code>ax profile publish</code></p>
                )}
                {state.kind === "error" && <p className="muted">couldn't load leaderboard: {state.message}</p>}

                {state.kind === "ready" && (
                    <>
                        <div className="leaders-tabs" role="tablist">
                            {BOARDS.map((b) => (
                                <button key={b} role="tab" aria-selected={board === b} onClick={() => setBoard(b)}>
                                    {b === "skills" ? "trending skills" : b}
                                </button>
                            ))}
                        </div>

                        {board !== "skills" ? (
                            <table className="leaders-table">
                                <thead><tr><th>#</th><th>user</th><th>{board}</th></tr></thead>
                                <tbody>
                                    {state.lb.boards[board].map((row, i) => (
                                        <tr key={row.login}>
                                            <td>{i + 1}</td>
                                            <td><Link to="/u/$login" params={{ login: row.login }}>@{row.login}</Link></td>
                                            <td>{valueLabel[board](row.value)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        ) : (
                            <table className="leaders-table">
                                <thead><tr><th>#</th><th>skill</th><th>users</th><th>runs/30d</th></tr></thead>
                                <tbody>
                                    {Object.entries(state.skills)
                                        .sort(([, a], [, b]) => b.users - a.users || b.runs - a.runs)
                                        .slice(0, 50)
                                        .map(([name, s], i) => (
                                            <tr key={name}>
                                                <td>{i + 1}</td>
                                                <td>{name}</td>
                                                <td>{s.users}</td>
                                                <td>{fmt(s.runs)}</td>
                                            </tr>
                                        ))}
                                </tbody>
                            </table>
                        )}

                        {state.lb.compiled_at !== "" && (
                            <p className="muted">compiled {state.lb.compiled_at.slice(0, 16).replace("T", " ")} UTC · refreshes nightly</p>
                        )}
                    </>
                )}
            </main>
            <SiteFooter />
        </>
    );
}
```

- [ ] **Step 2: Nav link** - in `apps/site/app/components/landing-sections/site-header.tsx`, add inside `<nav className="top-nav">` after Showcases:

```tsx
<Link to="/leaders">Leaders</Link>
```

- [ ] **Step 3: Build + typecheck + commit**

```bash
cd apps/site && bun run build && bun run typecheck
git add apps/site/app/routes/leaders.tsx apps/site/app/components/landing-sections/site-header.tsx
git commit -m "feat(site): /leaders multi-board leaderboard + trending skills"
```

---

### Task 4: Smoke + docs

- [ ] **Step 1: Local smoke** - `cd apps/site && bun run dev`, then with agent-browser or curl check:
  - `/leaders` renders the empty-state ("No leaderboard compiled yet") since community/leaderboard.json 404s on main today.
  - `/u/necmttn` renders not-found state (until a real registration lands) OR the live profile if registration exists by then.
  - No console errors beyond the expected 404 fetches.

- [ ] **Step 2: CLAUDE.md** - append to the Profile section:

```markdown
Site: `/u/<login>` renders a registered user's gist profile live;
`/leaders` renders compiled boards + trending skills (empty-state until the
first nightly compile). Both client-fetch from raw.githubusercontent /
gist raw; validation in apps/site/app/lib/community.ts (manual - the site
does not depend on effect).
```

- [ ] **Step 3: Gates + commit**

```bash
bun run check:cli-reference
git add CLAUDE.md
git commit -m "docs: profile site routes in CLAUDE.md"
```

---

## Self-review

1. **Spec coverage (Plan-4 slice):** `/u/<login>` live-gist render + 404 + powered-by link §4 → Task 2; `/leaders` tabs (tokens/sessions/streak/cost + trending skills), compile banner, self-reported note, rows → `/u/` §4 → Task 3; escaping → React text rendering + no dangerouslySetInnerHTML + validated shapes → Tasks 1-3. `/patterns` + `/skills/<name>` deferred (no community patterns dir yet; skill detail = first follow-up).
2. **Placeholder scan:** none; smoke expectations stated concretely (empty-states today).
3. **Type consistency:** site-local `ProfileV1`/`BoardRow` mirror the canonical schema field-for-field (incl. `runs` rename); `notFound` marker object used consistently between fetchJson and both routes.
