/**
 * Brand banner shown by `axctl version`, `axctl install`, and other
 * first-touch surfaces. Restraint is on-brand - typography, not ASCII art.
 *
 * See docs/brand.md for the wordmark + tag rules.
 */

const HRULE = "━".repeat(50);

export const BANNER = `
  ax  agent experience layer
  ${HRULE}
  observability + memory for AI coding agents
`;

export const BANNER_COMPACT = `  ax · agent experience layer`;
