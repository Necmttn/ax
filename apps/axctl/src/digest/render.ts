import { renderDigestJson, type DigestItemJson } from "@ax/lib/digest-shared";
import type { DigestItem } from "./model.ts";

/** One-line-per-item digest block. Empty string when no items (callers must
 *  emit nothing rather than a bare header). Shared by the hook and the CLI.
 *  Format is owned by renderDigestJson in @ax/lib/digest-shared - one source. */
export const renderDigest = (items: ReadonlyArray<DigestItem>): string =>
  renderDigestJson(
    items.map((it): DigestItemJson => {
      const base: DigestItemJson = {
        id: it.id,
        kind: it.kind,
        salience: it.salience,
        text: it.text,
        action: it.action,
        computed_at: it.computed_at.toISOString(),
      };
      if (it.evidence !== undefined) base.evidence = it.evidence;
      return base;
    }),
  );
