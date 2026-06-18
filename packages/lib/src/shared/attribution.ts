/**
 * attribution: the shared "Generated with ax" marketing watermark appended to
 * SHAREABLE artifacts ax produces on the user's behalf - artifacts meant to
 * leave the machine (dojo morning reports, staged upstream issue/PR drafts).
 *
 * This is the human-visible counterpart to the structured attribution already
 * carried by the JSON share/profile surfaces (`ax_version` in the share
 * manifest, the studio "recorded with ax" viewer footer). Internal, agent-only
 * artifacts (`.ax/tasks` classify/improve briefs) deliberately do NOT get this
 * footer - a plug on a file the agent consumes and the user never shares is
 * just noise.
 *
 * One source of truth so the wording, URL, and spacing never drift across
 * surfaces. Always on by design (no opt-out) - the marketing reach is the point.
 *
 * NOTE: distinct from `watermark.ts`, which is the ingest file-state
 * idempotency fingerprint - same English word, unrelated concept.
 */

/** The canonical project URL the attribution links to. */
export const AX_URL = "https://github.com/Necmttn/ax";

/** One-line plain-text attribution (for contexts where markdown links render literally). */
export const AX_ATTRIBUTION_TEXT = `Generated with ax - ${AX_URL}`;

/** Markdown attribution line: "_Generated with [ax](url)._" */
export const AX_ATTRIBUTION_MD = `_Generated with [ax](${AX_URL})._`;

/**
 * Append the markdown attribution footer to a generated document.
 *
 * Idempotent: a body that already ends with the attribution is returned
 * unchanged, so re-rendering / double-application never stacks footers. The
 * footer is a `---` rule then the attribution line, with the body's trailing
 * whitespace normalized to a single newline before it.
 */
export const withAxAttribution = (body: string): string => {
    const trimmed = body.replace(/\s+$/, "");
    if (trimmed.endsWith(AX_ATTRIBUTION_MD)) return `${trimmed}\n`;
    return `${trimmed}\n\n---\n\n${AX_ATTRIBUTION_MD}\n`;
};
