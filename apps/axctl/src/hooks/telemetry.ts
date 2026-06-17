import { Effect } from "effect";
import { RecordId } from "surrealdb";
import { SurrealClient } from "@ax/lib/db";
import {
    deterministicId,
    writeTelemetryRow,
    type TelemetryBaseRow,
    type TelemetryHarness,
} from "@ax/lib/telemetry-base";
import type { FileContextHookInput, FileContextHookDecision } from "./file-context-hook.ts";
import type {
    FileMemoryCommit,
    FileMemoryCorrection,
    PriorFileSession,
} from "../context/file-evidence.ts";

export interface HookFireRow extends TelemetryBaseRow {
    readonly kind: "hook_fire";
    readonly event: FileContextHookInput["event"];
    readonly inject: boolean;
    readonly reason: string;
    readonly prior_sessions_considered: number;
    readonly task_excerpt: string;
    readonly top_prior_sessions: readonly RecordId[];
    readonly injected_titles: readonly string[];
}

const TASK_EXCERPT_MAX = 240;
const TOP_PRIOR_SESSIONS = 3;
const TITLE_EXCERPT_MAX = 160;

const clipExcerpt = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

function parseSessionRid(value: string | undefined): RecordId | null {
    if (!value) return null;
    const idx = value.indexOf(":");
    if (idx < 0) return null;
    const table = value.slice(0, idx);
    const id = value.slice(idx + 1).replace(/^⟨|⟩$/g, "");
    if (!table || !id) return null;
    return new RecordId(table, id);
}

export interface RecordHookFireParams {
    readonly input: FileContextHookInput;
    readonly decision: FileContextHookDecision;
    readonly priorSessions: readonly PriorFileSession[];
    readonly corrections?: readonly FileMemoryCorrection[];
    readonly commits?: readonly FileMemoryCommit[];
    readonly harness: TelemetryHarness;
    readonly latencyMs: number;
    readonly now?: Date;
}

export const recordHookFire = (params: RecordHookFireParams): Effect.Effect<void, never, SurrealClient> =>
    Effect.gen(function* () {
        if (params.input.files.length === 0) return;
        const ts = params.now ?? new Date();
        const tsMs = String(ts.getTime());
        const topPriors = params.priorSessions.slice(0, TOP_PRIOR_SESSIONS);
        const topPriorRids = topPriors
            .map((s) => parseSessionRid(s.session))
            .filter((rid): rid is RecordId => rid !== null);
        // injected_titles is the at-a-glance summary surfaced by `axctl hook
        // log`. Prefer the highest-precision signals so reviewers see WHY a
        // fire injected, not just "some prior session existed."
        const injectedTitles: string[] = [];
        if (params.decision.inject) {
            const clip = (s: string) => clipExcerpt(s.replace(/\s+/g, " ").trim(), TITLE_EXCERPT_MAX);
            for (const c of (params.corrections ?? []).slice(0, 2)) {
                injectedTitles.push(`correction: "${clip(c.text)}"`);
            }
            for (const c of (params.commits ?? []).slice(0, 1)) {
                const sha = (c.sha ?? c.commit_id).slice(0, 10);
                injectedTitles.push(`commit ${sha}: ${clip(c.message ?? "")}`);
            }
            if (injectedTitles.length === 0) {
                for (const s of topPriors) {
                    injectedTitles.push(clip(s.title ?? s.project ?? s.session) || s.session);
                }
            }
        }

        for (const filePath of params.input.files) {
            const id = deterministicId([
                params.harness,
                params.input.sessionId ?? "-",
                filePath,
                tsMs,
                params.input.event,
            ]);
            const row: HookFireRow = {
                id,
                ts,
                kind: "hook_fire",
                session: params.input.sessionId,
                file: undefined,
                file_path: filePath,
                harness: params.harness,
                ok: true,
                latency_ms: params.latencyMs,
                event: params.input.event,
                inject: params.decision.inject,
                reason: params.decision.reason,
                prior_sessions_considered: params.priorSessions.length,
                task_excerpt: clipExcerpt(params.input.task, TASK_EXCERPT_MAX),
                top_prior_sessions: topPriorRids,
                injected_titles: injectedTitles,
            };
            yield* writeTelemetryRow("hook_fire", row);
        }
    }).pipe(
        Effect.catch((err) =>
            Effect.sync(() => {
                console.error("axctl hook telemetry write failed:", err);
            }),
        ),
    );
