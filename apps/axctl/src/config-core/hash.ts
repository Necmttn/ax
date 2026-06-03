import { createHash } from "node:crypto";

/**
 * Content hash shared by skill/command/agent source codecs: first 16 hex chars
 * of sha256. (Distinct from `@ax/lib/ids` `stableDigest`, which is Bun.hash for
 * record ids; this is a plain content fingerprint.)
 */
export const sha16 = (text: string): string =>
    createHash("sha256").update(text).digest("hex").slice(0, 16);
