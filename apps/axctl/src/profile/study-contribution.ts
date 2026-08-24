/** One content-stripped, self-reported study from the fixed Dojo spar protocol. */
import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";
import { prettyPrint } from "@ax/lib/json";
import { withAxAttribution } from "@ax/lib/shared/attribution";
import { scoreSpar, type SparBrief, type SparMetrics, type SparScore } from "../dojo/spar.ts";
import { GitHubApiError, GitHubEnv } from "./github-env.ts";
import { REGISTRY_REPO } from "./pattern-contribution.ts";

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

type Metric<T> = { readonly baseline: T; readonly variant: T; readonly delta: number | null };

export interface CommunityStudy {
    readonly schema_version: 1;
    readonly kind: "self-reported-community-study";
    readonly protocol: { readonly id: "verification-churn"; readonly version: 1 };
    readonly evidence_class: "self_reported";
    readonly outcome: "improved" | "regressed" | "mixed";
    readonly privacy: "closed_fields_content_stripped";
    readonly source: {
        readonly spar_id_sha256: string;
        readonly brief_sha256: string;
        readonly score_sha256: string;
        readonly intervention_sha256: string;
    };
    readonly metrics: {
        readonly cost_usd: Metric<number | null>;
        readonly turns: Metric<number | null>;
        readonly wall_ms: Metric<number | null>;
        readonly repair_lines: Metric<number>;
        readonly episodes: Metric<number>;
        readonly landed: { readonly baseline: boolean; readonly variant: boolean };
    };
    readonly limitations: readonly ["single_spar_comparison", "self_reported"];
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const metric = <T>(baseline: T, variant: T, delta: number | null): Metric<T> => ({ baseline, variant, delta });

export function buildCommunityStudy(input: {
    readonly brief: SparBrief;
    readonly score: SparScore;
    readonly briefBytes: string;
    readonly scoreBytes: string;
}): CommunityStudy {
    if (input.brief.id !== input.score.id) throw new Error("spar score id does not match the brief id");
    if (input.brief.delta.trim() === "") throw new Error("spar brief has no intervention in the Delta section");
    if (input.brief.baselineIsSubagent) throw new Error("a subagent baseline cannot become a community study");
    if (!same(input.brief.baseline, input.score.baseline)) throw new Error("spar score baseline does not match the frozen brief");

    const calculated = scoreSpar(input.score.baseline, input.score.variant);
    if (!same(calculated.deltas, input.score.deltas) || calculated.verdict !== input.score.verdict) {
        throw new Error("spar score does not match the fixed protocol calculation");
    }

    const baseline: SparMetrics = input.score.baseline;
    const variant: SparMetrics = input.score.variant;
    const deltas = input.score.deltas;
    return {
        schema_version: 1,
        kind: "self-reported-community-study",
        protocol: { id: "verification-churn", version: 1 },
        evidence_class: "self_reported",
        outcome: input.score.verdict === "win" ? "improved" : input.score.verdict === "regression" ? "regressed" : "mixed",
        privacy: "closed_fields_content_stripped",
        source: {
            spar_id_sha256: sha256(input.brief.id),
            brief_sha256: sha256(input.briefBytes),
            score_sha256: sha256(input.scoreBytes),
            intervention_sha256: sha256(input.brief.delta.trim()),
        },
        metrics: {
            cost_usd: metric(baseline.costUsd, variant.costUsd, deltas.costUsd),
            turns: metric(baseline.turns, variant.turns, deltas.turns),
            wall_ms: metric(baseline.wallMs, variant.wallMs, deltas.wallMs),
            repair_lines: metric(baseline.repairLines, variant.repairLines, deltas.repairLines),
            episodes: metric(baseline.episodes, variant.episodes, deltas.episodes),
            landed: { baseline: baseline.landed, variant: variant.landed },
        },
        limitations: ["single_spar_comparison", "self_reported"],
    };
}

export const studyFilePath = (study: CommunityStudy): string =>
    `community/research/studies/verification-churn/${study.source.score_sha256.slice(0, 32)}.json`;

const studyBranchName = (study: CommunityStudy): string =>
    `ax-study-verification-churn-${study.source.score_sha256.slice(0, 12)}`;

export class StudyContributionError extends Schema.TaggedErrorClass<StudyContributionError>(
    "StudyContributionError",
)("StudyContributionError", { message: Schema.String }) {}

const asRecord = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null ? value as Record<string, unknown> : {};

export const openStudyContribution = Effect.fn("profile.openStudyContribution")(
    function* (input: { readonly study: CommunityStudy; readonly login?: string }) {
        const gh = yield* GitHubEnv;
        const login = input.login ?? (yield* gh.login());
        if (login === null || login.trim() === "") {
            return yield* new StudyContributionError({ message: "GitHub login unavailable; run `gh auth login` and retry." });
        }

        const path = studyFilePath(input.study);
        const branch = studyBranchName(input.study);
        const exists = yield* gh.api("GET", `/repos/${REGISTRY_REPO}/contents/${path}`).pipe(
            Effect.map(() => true),
            Effect.catchTag("GitHubApiError", (error: GitHubApiError) =>
                error.status === 404 ? Effect.succeed(false) : Effect.fail(error)),
        );
        if (exists) return yield* new StudyContributionError({ message: `${path} already exists.` });

        const fork = asRecord(yield* gh.api("POST", `/repos/${REGISTRY_REPO}/forks`, {}));
        const forkFullName = typeof fork.full_name === "string" ? fork.full_name : `${login}/ax`;
        const baseRef = asRecord(yield* gh.api("GET", `/repos/${REGISTRY_REPO}/git/ref/heads/main`));
        const baseSha = String(asRecord(baseRef.object).sha ?? "");
        const baseCommit = asRecord(yield* gh.api("GET", `/repos/${REGISTRY_REPO}/git/commits/${baseSha}`));
        const baseTreeSha = String(asRecord(baseCommit.tree).sha ?? "");
        const blob = asRecord(yield* gh.api("POST", `/repos/${forkFullName}/git/blobs`, {
            content: `${prettyPrint(input.study)}\n`, encoding: "utf-8",
        }));
        const tree = asRecord(yield* gh.api("POST", `/repos/${forkFullName}/git/trees`, {
            base_tree: baseTreeSha,
            tree: [{ path, mode: "100644", type: "blob", sha: blob.sha }],
        }));
        const commit = asRecord(yield* gh.api("POST", `/repos/${forkFullName}/git/commits`, {
            message: `community: contribute verification churn study`, tree: tree.sha, parents: [baseSha],
        }));
        yield* gh.api("POST", `/repos/${forkFullName}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
        const body = withAxAttribution([
            "Contributes one content-stripped study from the fixed verification churn protocol.",
            "The evidence is self-reported and contains one spar comparison.",
            "This PR does not claim general efficacy.",
            `File: \`${path}\``,
            "Opened by `ax contribute study`.",
        ].join("\n\n"));
        const pr = asRecord(yield* gh.api("POST", `/repos/${REGISTRY_REPO}/pulls`, {
            title: "community: contribute verification churn study",
            head: `${login}:${branch}`,
            base: "main",
            body,
        }));
        return { status: "pr-opened" as const, prUrl: String(pr.html_url ?? ""), path };
    },
);
