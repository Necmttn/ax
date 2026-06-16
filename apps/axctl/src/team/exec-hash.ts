import { createHash } from "node:crypto";

/** Full hex sha256 of text. Security-grade content pin for executable trust
 *  (a non-cryptographic hash like Bun.hash would be insufficient here - a
 *  collision is a trust-bypass, not just a missed change). */
export const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");

/** sha256 of a file's content; sha256("") for a missing/unreadable file. */
export async function sha256OfFile(abs: string): Promise<string> {
  const f = Bun.file(abs);
  return (await f.exists()) ? sha256Hex(await f.text()) : sha256Hex("");
}
