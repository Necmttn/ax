/**
 * Handlers for the skills group of the Insights Surface Contract.
 * Thin delegations to the existing triage/skill-source effects; parity:
 *   - decide/decide-bulk reflect decisions onto disk exactly as the legacy
 *     rows did (archive disables, keep/review restores, clear restores),
 *   - bulk decide keeps the legacy empty-names 400 message,
 *   - reason strings normalize trim-or-null like the legacy decoder.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { AxApi, BadRequestError } from "@ax/lib/shared/api-contract";
import { fetchSkillDetail } from "../../queries/skill-detail.ts";
import {
    applySkillDecisionToDisk,
    openSkillTarget,
    readSkillSource,
} from "../skill-source.ts";
import {
    clearSkillDecision,
    fetchSkillTriage,
    listSkillDecisions,
    setSkillDecision,
    setSkillDecisionsBulk,
} from "../triage.ts";
import { orInternal } from "./common.ts";

const normalizeReason = (raw: string | null | undefined): string | null =>
    typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;

export const SkillsGroupLive = HttpApiBuilder.group(AxApi, "skills", (handlers) =>
    handlers
        .handle("decisions", () =>
            orInternal(listSkillDecisions().pipe(Effect.map((notes) => ({ decisions: notes })))))
        .handle("skills", () => orInternal(fetchSkillTriage()))
        .handle("skillDecideBulk", ({ payload }) => {
            const names = payload.names.filter((n) => n.length > 0);
            if (names.length === 0) {
                return Effect.fail(
                    new BadRequestError({ error: "names must be a non-empty array of skill names" }),
                );
            }
            return orInternal(Effect.gen(function* () {
                const saved = yield* setSkillDecisionsBulk(names, payload.decision, normalizeReason(payload.reason));
                // Reflect the decision onto disk for every editable skill.
                for (const skillName of names) {
                    yield* applySkillDecisionToDisk(skillName, payload.decision);
                }
                return { notes: saved };
            }));
        })
        .handle("skillDecide", ({ params, payload }) =>
            orInternal(Effect.gen(function* () {
                const saved = yield* setSkillDecision(params.name, payload.decision, normalizeReason(payload.reason));
                // `archive` disables the skill on disk; `keep`/`review` restores it.
                yield* applySkillDecisionToDisk(params.name, payload.decision);
                return saved;
            })))
        .handle("skillDecideClear", ({ params }) =>
            orInternal(Effect.gen(function* () {
                yield* clearSkillDecision(params.name);
                // Clearing a decision restores the skill on disk.
                yield* applySkillDecisionToDisk(params.name, null);
                return { cleared: true, skill_name: params.name };
            })))
        .handle("skillDetail", ({ params }) => orInternal(fetchSkillDetail(params.name)))
        .handle("skillSource", ({ params }) => orInternal(readSkillSource(params.name)))
        .handle("skillOpen", ({ params, payload }) =>
            orInternal(openSkillTarget(params.name, payload.target))));
