import type { DigestItem } from "./model.ts";

/** One-line-per-item digest block. Empty string when no items (callers must
 *  emit nothing rather than a bare header). Shared by the hook and the CLI. */
export const renderDigest = (items: ReadonlyArray<DigestItem>): string => {
  if (items.length === 0) return "";
  const lines = items.map((it) => `  • ${it.text} → ${it.action}`);
  return ["[ax] since last session:", ...lines, "run `ax` for the full board."].join("\n");
};
