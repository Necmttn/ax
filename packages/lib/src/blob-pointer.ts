/**
 * How a row points at a blob on disk: `"<bucket>:/<path>"`.
 *
 * A plain string format with no engine in it - `session.raw_file` holds one
 * of these regardless of which store wrote it. It lives here, not beside any
 * DB client, so comparing two pointer strings never requires importing a
 * database SDK.
 *
 * The BRAND (#891, v3 Phase 4): `session.raw_file` legitimately holds either
 * a pointer OR an absolute filesystem path (claude subagents persist the
 * source path; codex falls back to it when the snapshot is skipped), and the
 * two must never be confused - `fs.exists(<pointer>)` is a silent no-op, and
 * `filePointer(bucket, <absolute path>)` mints a pointer no GC reference set
 * can match. So a pointer is a BRANDED string: `filePointer` mints it,
 * `isBlobPointer` narrows to it, and `blobPointerPath` is the ONE sanctioned
 * pointer -> filesystem-path conversion. A function taking a filesystem path
 * cannot receive a `BlobPointer` (or vice versa) without one of those three
 * in the trace.
 */
import { posixPath } from "./shared/path.ts";

declare const BlobPointerBrand: unique symbol;

/** A `"<bucket>:/<name>"` blob pointer. See the module doc for why this is
 *  branded rather than a plain string. */
export type BlobPointer = string & { readonly [BlobPointerBrand]: "BlobPointer" };

export const filePointer = (bucket: string, path: string): BlobPointer =>
    `${bucket}:/${path}` as BlobPointer;

/**
 * Does this string have the shape {@link filePointer} produces?
 *
 * Deliberately structural and not a bucket allowlist: GC uses it to answer "is
 * this reference set made of pointers at all", and a pointer into a bucket GC
 * does not scan is still evidence the producer is writing pointers. An absolute
 * filesystem path (`/Users/...`) fails it, which is the case that matters -
 * that is what a parser writes when it stores the source path instead.
 */
export const isBlobPointer = (value: string): value is BlobPointer =>
    /^[A-Za-z0-9_-]+:\/[^/]/.test(value);

/** The bucket segment of a pointer (`"transcripts:/a.jsonl"` -> `"transcripts"`). */
export const blobPointerBucket = (pointer: BlobPointer): string =>
    pointer.slice(0, pointer.indexOf(":/"));

/**
 * The ONE sanctioned pointer -> filesystem-path conversion: where this
 * pointer's blob lives under a buckets directory. Pure string math - callers
 * still have to check the file exists (a pointer can outlive its blob when
 * GC or the user removed it).
 */
export const blobPointerPath = (bucketsDir: string, pointer: BlobPointer): string => {
    const sep = pointer.indexOf(":/");
    return posixPath.join(bucketsDir, pointer.slice(0, sep), pointer.slice(sep + 2));
};
