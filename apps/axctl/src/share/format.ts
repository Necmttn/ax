import type { AxSessionShare } from "./artifact.ts";
import { type GistRef, shareUrlForGist } from "./gist.ts";

export function formatSharePreview(
    artifact: AxSessionShare,
    options: { readonly public?: boolean } = {},
): string {
    const lines = [
        `Session ${artifact.session.id}`,
        `source: ${artifact.session.source}`,
    ];

    if (artifact.session.model !== undefined) {
        lines.push(`model: ${artifact.session.model}`);
    }

    if (artifact.session.project !== undefined) {
        lines.push(`project: ${artifact.session.project}`);
    }

    lines.push(
        `stats: turns: ${artifact.stats.turns}, tool_calls: ${artifact.stats.tool_calls}, files_changed: ${artifact.stats.files_changed}, skills_used: ${artifact.stats.skills_used}, failures: ${artifact.stats.failures}`,
    );

    lines.push(
        artifact.redactions.applied
            ? `redactions: applied (${artifact.redactions.rules.length} rules)`
            : "redactions: none",
        `publish target: ${options.public === true ? "public" : "secret/unlisted"} Gist`,
    );

    return lines.join("\n");
}

export function formatShareSuccess(ref: GistRef): string {
    return [
        "Published session share:",
        shareUrlForGist(ref),
    ].join("\n");
}
