import { describe, expect, test } from "bun:test";
import { extractPatchPaths } from "./patch-paths.ts";

const PATCH = `*** Begin Patch
*** Update File: src/a.ts
@@
-old
+new
*** Add File: docs/new.md
+hello
*** Delete File: old.txt
*** End Patch`;

describe("extractPatchPaths", () => {
  test("update/add/delete paths extracted", () => {
    expect(extractPatchPaths(PATCH)).toEqual(["src/a.ts", "docs/new.md", "old.txt"]);
  });
  test("non-patch input -> empty", () => {
    expect(extractPatchPaths("echo hi")).toEqual([]);
  });
});
