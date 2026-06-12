import { Effect, Option, Schema } from "effect";
import type { TriageDecision } from "@ax/lib/shared/dashboard-types";
import { fetchSkillDetail } from "../../../queries/skill-detail.ts";
import {
    clearSkillDecision,
    listSkillDecisions,
    setSkillDecision,
    setSkillDecisionsBulk,
} from "../../triage.ts";
import {
    applySkillDecisionToDisk,
    openSkillTarget,
    readSkillSource,
} from "../../skill-source.ts";
import { fetchSkillTriageCached, invalidateSkillCaches } from "../../read-caches.ts";
import {
    decodeFail,
    decodeOk,
    jsonRoute,
    type AnyRoute,
    type BodyResult,
    type Decoded,
    type RouteInput,
} from "../router.ts";

/** Field-level Schema decode: single source of truth for the triage enum. */
const decodeTriageDecision = Schema.decodeUnknownOption(
    Schema.Literals(["keep", "archive", "review"]),
);
const decodeOpenTarget = Schema.decodeUnknownOption(
    Schema.Literals(["finder", "editor"]),
);

const bodyRecord = (body: BodyResult): Record<string, unknown> | null => {
    if (body.kind !== "json") return null;
    return typeof body.value === "object" && body.value !== null
        ? (body.value as Record<string, unknown>)
        : {};
};

const normalizeReason = (raw: unknown): string | null =>
    typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;

const requiredName = (path: Readonly<Record<string, string>>): Decoded<string> => {
    const name = path.name ?? "";
    return name ? decodeOk(name) : decodeFail("missing skill name", 400);
};

const legacyGetRoute = <P, A>(
    def: Omit<Parameters<typeof jsonRoute<P, A>>[0], "method" | "fallthroughOnMethodMismatch">,
): AnyRoute =>
    jsonRoute({
        ...def,
        method: "GET",
        fallthroughOnMethodMismatch: true,
    });

export interface SkillDecisionParams {
    readonly name: string;
    readonly decision: TriageDecision;
    readonly reason: string | null;
}

export const decodeSkillDecisionParams = ({ path, body }: RouteInput): Decoded<SkillDecisionParams> => {
    const name = requiredName(path);
    if (!name.ok) return name;
    const record = bodyRecord(body);
    if (record === null) return decodeFail("invalid_json", 400);
    const decision = Option.getOrNull(decodeTriageDecision(record.decision));
    if (decision === null) return decodeFail("decision must be one of keep|archive|review", 400);
    return decodeOk({ name: name.value, decision, reason: normalizeReason(record.reason) });
};

export interface BulkDecisionParams {
    readonly names: ReadonlyArray<string>;
    readonly decision: TriageDecision;
    readonly reason: string | null;
}

export const decodeBulkDecisionParams = ({ body }: RouteInput): Decoded<BulkDecisionParams> => {
    const record = bodyRecord(body);
    if (record === null) return decodeFail("invalid_json", 400);
    if (!Array.isArray(record.names) || record.names.length === 0) {
        return decodeFail("names must be a non-empty array of skill names", 400);
    }
    const names = record.names.filter((n): n is string => typeof n === "string" && n.length > 0);
    if (names.length === 0) return decodeFail("no valid skill names provided", 400);
    const decision = Option.getOrNull(decodeTriageDecision(record.decision));
    if (decision === null) return decodeFail("decision must be one of keep|archive|review", 400);
    return decodeOk({ names, decision, reason: normalizeReason(record.reason) });
};

export interface SkillOpenParams {
    readonly name: string;
    readonly target: "finder" | "editor";
}

export const decodeSkillOpenParams = ({ path, body }: RouteInput): Decoded<SkillOpenParams> => {
    const name = requiredName(path);
    if (!name.ok) return name;
    const record = bodyRecord(body);
    if (record === null) return decodeFail("invalid_json", 400);
    const target = Option.getOrNull(decodeOpenTarget(record.target));
    if (target === null) return decodeFail("target must be 'finder' or 'editor'", 400);
    return decodeOk({ name: name.value, target });
};

export const skillRoutes: ReadonlyArray<AnyRoute> = [
    legacyGetRoute({
        path: "/api/decisions",
        decode: () => decodeOk(undefined),
        handler: () => listSkillDecisions().pipe(Effect.map((notes) => ({ decisions: notes }))),
    }),
    legacyGetRoute({
        path: "/api/skills",
        decode: () => decodeOk(undefined),
        handler: () => fetchSkillTriageCached(),
    }),
    // Static before param routes within the family.
    jsonRoute({
        method: "POST",
        path: "/api/skills/decide-bulk",
        readsBody: true,
        decode: decodeBulkDecisionParams,
        handler: ({ names, decision, reason }) => Effect.gen(function* () {
            const saved = yield* setSkillDecisionsBulk(names, decision, reason);
            // Reflect the decision onto disk for every editable skill.
            for (const skillName of names) {
                yield* applySkillDecisionToDisk(skillName, decision);
            }
            yield* invalidateSkillCaches();
            return { notes: saved };
        }),
    }),
    jsonRoute({
        method: "POST",
        path: "/api/skills/:name+/decide",
        readsBody: true,
        decode: decodeSkillDecisionParams,
        handler: ({ name, decision, reason }) => Effect.gen(function* () {
            const saved = yield* setSkillDecision(name, decision, reason);
            // `archive` disables the skill on disk; `keep`/`review` restores it.
            yield* applySkillDecisionToDisk(name, decision);
            yield* invalidateSkillCaches();
            return saved;
        }),
    }),
    jsonRoute({
        method: "DELETE",
        path: "/api/skills/:name+/decide",
        decode: ({ path }) => requiredName(path),
        handler: (name) => Effect.gen(function* () {
            yield* clearSkillDecision(name);
            // Clearing a decision restores the skill on disk.
            yield* applySkillDecisionToDisk(name, null);
            yield* invalidateSkillCaches();
            return { cleared: true, skill_name: name };
        }),
    }),
    jsonRoute({
        method: "GET",
        path: "/api/skills/:name+/detail",
        decode: ({ path }) => requiredName(path),
        handler: (name) => fetchSkillDetail(name),
    }),
    jsonRoute({
        method: "GET",
        path: "/api/skills/:name+/source",
        decode: ({ path }) => requiredName(path),
        handler: (name) => readSkillSource(name),
    }),
    jsonRoute({
        method: "POST",
        path: "/api/skills/:name+/open",
        readsBody: true,
        decode: decodeSkillOpenParams,
        handler: ({ name, target }) => openSkillTarget(name, target),
    }),
];
