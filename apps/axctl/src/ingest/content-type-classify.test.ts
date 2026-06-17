import { describe, expect, test } from "bun:test";
import { classifyContentType } from "./content-type-classify.ts";

describe("classifyContentType", () => {
  test("extension wins: .ts -> code, conf 0.95", () => {
    const r = classifyContentType({ filePath: "/a/b.ts", output: "const x = 1;" });
    expect(r.category).toBe("code");
    expect(r.method).toBe("extension");
    expect(r.confidence).toBe(0.95);
    expect(r.fineLabel).toBe("ts");
  });

  test(".json -> json", () => {
    expect(classifyContentType({ filePath: "x.json", output: "{}" }).category).toBe("json");
  });

  test("empty output -> empty regardless of path", () => {
    expect(classifyContentType({ filePath: "x.ts", output: "   \n" }).category).toBe("empty");
  });

  test("no path, JSON-ish body -> json by sniff, conf 0.6", () => {
    const r = classifyContentType({ filePath: null, output: '  [{"a":1}]' });
    expect(r.category).toBe("json");
    expect(r.method).toBe("sniff");
    expect(r.confidence).toBe(0.6);
  });

  test("no path, diff markers -> diff", () => {
    const r = classifyContentType({ filePath: null, output: "diff --git a/x b/x\n@@ -1 +1 @@" });
    expect(r.category).toBe("diff");
  });

  test("grep-style hits -> filelist", () => {
    const out = "src/a.ts:12: foo\nsrc/b.ts:4: bar\nsrc/c.ts:9: baz";
    expect(classifyContentType({ filePath: null, output: out, toolName: "Grep" }).category).toBe("filelist");
  });

  test("plain prose -> text fallback, conf 0.4", () => {
    const r = classifyContentType({ filePath: null, output: "the quick brown fox jumps" });
    expect(r.category).toBe("text");
    expect(r.method).toBe("fallback");
    expect(r.confidence).toBe(0.4);
  });

  test(".png -> binary", () => {
    expect(classifyContentType({ filePath: "x.png", output: "..." }).category).toBe("binary");
  });

  test("dotfile path -> config, fineLabel dotfile", () => {
    const r = classifyContentType({ filePath: "/x/.gitignore", output: "node_modules" });
    expect(r.category).toBe("config");
    expect(r.fineLabel).toBe("dotfile");
  });

  test("shebang sniff, no path -> code by sniff", () => {
    const r = classifyContentType({ filePath: null, output: "#!/bin/bash\necho hi" });
    expect(r.category).toBe("code");
    expect(r.method).toBe("sniff");
  });
});
