// PROTOTYPE - throwaway logic for testing whether user-task memories are useful.
// Question: can real transcript task messages produce relevant, evidence-backed
// guidance for a current coding-agent task before we build production memory?

import { classifyTurnIntent, type TurnIntentKind } from "../../apps/axctl/src/ingest/intent-kind.ts";

export interface TaskTurn {
    readonly id: string;
    readonly session: string;
    readonly seq: number;
    readonly ts: string;
    readonly source: string | null;
    readonly cwd: string | null;
    readonly intent_kind?: IntentKind | null;
    readonly text: string;
    readonly text_excerpt: string | null;
}

export interface SessionEvidence {
    readonly id: string;
    readonly source: string | null;
    readonly cwd: string | null;
    readonly commits: readonly {
        readonly sha: string | null;
        readonly message: string | null;
        readonly touched: readonly { readonly path: string | null }[];
    }[];
}

export interface MatchedTurn extends TaskTurn {
    readonly score: number;
    readonly why: readonly string[];
    readonly intentKind: IntentKind;
}

export type IntentKind = TurnIntentKind;

export type Topic =
    | "transcript_ingest"
    | "graph_query"
    | "memory_injection"
    | "dashboard_ui"
    | "frontend_style"
    | "docs";

export interface MemoryDecision {
    readonly id: string;
    readonly title: string;
    readonly guidance: string;
    readonly topics: readonly Topic[];
    readonly status: "inject" | "reject";
    readonly confidence: number;
    readonly why: readonly string[];
    readonly rejectedBecause: readonly string[];
    readonly evidenceTurns: readonly MatchedTurn[];
}

const STOP = new Set([
    "the", "and", "for", "that", "this", "with", "you", "can", "are", "was", "were", "have", "has", "but", "not",
    "from", "into", "there", "what", "how", "why", "does", "did", "would", "should", "could", "lets", "let", "we",
    "my", "me", "it", "its", "is", "in", "on", "as", "of", "or", "be", "so", "do", "to", "a", "an",
]);

export function tokens(text: string): string[] {
    return text
        .toLowerCase()
        .replace(/`[^`]+`/g, " ")
        .replace(/https?:\/\/\S+/g, " ")
        .split(/[^a-z0-9_'-]+/)
        .map((token) => token.replace(/^['-]+|['-]+$/g, ""))
        .filter((token) => token.length >= 2 && !STOP.has(token));
}

const hasAny = (text: string, needles: readonly RegExp[]): boolean => needles.some((needle) => needle.test(text));

export function classifyTopics(text: string): Topic[] {
    const lower = text.toLowerCase();
    const topics: Topic[] = [];
    if (/\b(transcripts?|ingest|reingest|claude|codex|user messages?|turn\.text)\b/.test(lower)) topics.push("transcript_ingest");
    if (/\b(graph query|surreal|surrealdb|record references?|native references?|files touched|produced commits?|session messages?)\b/.test(lower)) {
        topics.push("graph_query");
    }
    if (/\b(memory|working memory|context injection|inject|current task|active memories?|system message|just in time|just-in-time)\b/.test(lower)) {
        topics.push("memory_injection");
    }
    if (/\b(dashboard|view|review|candidate|confidence|accept|reject|activate|evidence drilldown)\b/.test(lower)) topics.push("dashboard_ui");
    if (/\b(react|button|style|css|navbar|cta|hover|color|landing page)\b/.test(lower)) topics.push("frontend_style");
    if (/\b(readme|badge|package description|docs?|documentation|changelog)\b/.test(lower)) topics.push("docs");
    return Array.from(new Set(topics));
}

const organicEvidence = (turn: MatchedTurn): boolean =>
    turn.intentKind === "organic_task" || turn.intentKind === "correction" || turn.intentKind === "preference";

export function scoreTurns(query: string, turns: readonly TaskTurn[], cwd: string): MatchedTurn[] {
    const qTokens = Array.from(new Set(tokens(query)));
    const cwdProject = cwd.split("/").filter(Boolean).at(-1)?.toLowerCase() ?? "";

    return turns
        .map((turn) => {
            const lower = turn.text.toLowerCase();
            const turnTokens = new Set(tokens(turn.text));
            let score = 0;
            const why: string[] = [];

            const overlaps = qTokens.filter((token) => turnTokens.has(token));
            if (overlaps.length > 0) {
                score += overlaps.length * 2;
                why.push(`token overlap: ${overlaps.slice(0, 8).join(", ")}`);
            }

            for (const phrase of ["real transcripts", "graph query", "record references", "working memory", "context", "ingest"]) {
                if (query.toLowerCase().includes(phrase) && lower.includes(phrase)) {
                    score += 8;
                    why.push(`phrase: ${phrase}`);
                }
            }

            if (cwdProject && turn.cwd?.toLowerCase().includes(cwdProject)) {
                score += 3;
                why.push(`same cwd project: ${cwdProject}`);
            }

            if (hasAny(lower, [/did you test|test against real|real transcripts|trace.*real|verify|typecheck|bun test/])) {
                score += query.match(/test|verify|transcript|ingest/i) ? 5 : 1;
                why.push("verification language");
            }

            if (hasAny(lower, [/graph query|record references|files touched|sessions?.*message|native references|surreal/i])) {
                score += query.match(/graph|surreal|reference|session|message/i) ? 5 : 1;
                why.push("graph/provenance language");
            }

            return {
                ...turn,
                score,
                why,
                intentKind: turn.intent_kind ?? classifyTurnIntent({ role: "user", messageKind: "task", source: turn.source ?? null, text: turn.text }),
            };
        })
        .filter((turn) => turn.score > 0 && !turn.text.trim().startsWith("⏺"))
        .sort((a, b) => b.score - a.score || b.ts.localeCompare(a.ts))
        .slice(0, 20);
}

export function decideMemories(query: string, matches: readonly MatchedTurn[]): MemoryDecision[] {
    const queryTopics = classifyTopics(query);
    const buckets: {
        readonly id: string;
        readonly title: string;
        readonly guidance: string;
        readonly topics: readonly Topic[];
        readonly tests: readonly RegExp[];
    }[] = [
        {
            id: "real-transcript-verification",
            title: "Real transcript verification",
            guidance: "When changing transcript ingest, test against real Claude and Codex transcripts and show the rows or query output that prove the data shape.",
            topics: ["transcript_ingest"],
            tests: [/did you test|test against real|real transcripts|ingest 1 session|trace.*transcript|transcript ingest/i],
        },
        {
            id: "graph-first-evidence",
            title: "Graph-first evidence",
            guidance: "For graph/storage changes, return a SurrealQL query that links the user message, session, files touched, and commits so the user can inspect the graph directly.",
            topics: ["graph_query"],
            tests: [/graph query|files touched|sessions?.*message|record references|native references|surrealdb record/i],
        },
        {
            id: "explain-activation-mechanics",
            title: "Explain activation mechanics",
            guidance: "When proposing automatic memory or context injection, explain exactly how the current task is detected, what becomes active, and where the injected text appears.",
            topics: ["memory_injection"],
            tests: [/current task|become active|agent receives|working memory|just.?in.?time|injection|system message/i],
        },
    ];

    return buckets
        .map((bucket) => {
            const topicOverlap = bucket.topics.filter((topic) => queryTopics.includes(topic));
            const rejectedBecause: string[] = [];
            if (topicOverlap.length === 0) {
                rejectedBecause.push(`topic mismatch: query topics [${queryTopics.join(", ") || "none"}], memory topics [${bucket.topics.join(", ")}]`);
            }
            const evidence = matches
                .filter((match) => organicEvidence(match))
                .filter((match) => hasAny(match.text, bucket.tests))
                .slice(0, 8);
            if (evidence.length === 0) rejectedBecause.push("no organic correction/preference evidence matched");
            const sessions = new Set(evidence.map((turn) => turn.session));
            const confidence = Math.min(0.95, 0.25 + topicOverlap.length * 0.25 + evidence.length * 0.08 + sessions.size * 0.07);
            if (confidence < 0.55) rejectedBecause.push(`below threshold: ${confidence.toFixed(2)} < 0.55`);
            const status: MemoryDecision["status"] = rejectedBecause.length === 0 ? "inject" : "reject";
            return {
                id: bucket.id,
                title: bucket.title,
                guidance: bucket.guidance,
                topics: bucket.topics,
                status,
                confidence,
                why: [
                    `query topics: ${queryTopics.join(", ") || "none"}`,
                    `topic overlap: ${topicOverlap.join(", ") || "none"}`,
                    `${evidence.length} organic evidence turns`,
                    `${sessions.size} sessions`,
                ],
                rejectedBecause,
                evidenceTurns: evidence,
            };
        })
        .sort((a, b) => {
            if (a.status !== b.status) return a.status === "inject" ? -1 : 1;
            return b.confidence - a.confidence;
        });
}

export const injectedMemories = (decisions: readonly MemoryDecision[]): MemoryDecision[] =>
    decisions.filter((decision) => decision.status === "inject");

export function renderContextBlock(decisions: readonly MemoryDecision[], sessions: readonly SessionEvidence[]): string {
    const lines: string[] = ["## Ax Local Memory Prototype", ""];
    const injected = injectedMemories(decisions);
    if (injected.length === 0) {
        lines.push("No active memory matched above threshold.");
        lines.push("");
        lines.push("## Rejected Memories");
        for (const decision of decisions) {
            lines.push(`- ${decision.title}: ${decision.rejectedBecause.join("; ")}`);
        }
        return lines.join("\n");
    }

    for (const candidate of injected.slice(0, 3)) {
        lines.push(`- ${candidate.guidance}`);
        lines.push(`  Evidence: ${candidate.why.join(", ")}. Confidence: ${candidate.confidence.toFixed(2)}.`);
    }

    const files = Array.from(
        new Set(
            sessions.flatMap((session) =>
                session.commits.flatMap((commit) => commit.touched.map((file) => file.path).filter((path): path is string => !!path)),
            ),
        ),
    ).slice(0, 12);
    if (files.length > 0) {
        lines.push("", "## Linked Files From Evidence Sessions", ...files.map((file) => `- ${file}`));
    }

    return lines.join("\n");
}
