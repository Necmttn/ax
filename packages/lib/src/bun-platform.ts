/**
 * Re-export of the Bun-backed `@effect/platform` layers.
 *
 * Root-level scripts/tests (outside any workspace package) cannot resolve the
 * bare `@effect/platform-bun` specifier - it is only hoisted under workspace
 * packages. Re-exporting through `@ax/lib` (a workspace dependency that *does*
 * carry `@effect/platform-bun`) gives those callers a resolvable handle on the
 * real Bun `FileSystem`/`Path` layers without weakening to an in-memory mock.
 */
export { BunFileSystem, BunPath } from "@effect/platform-bun";
