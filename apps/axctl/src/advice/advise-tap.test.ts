import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const tempDirs: string[] = [];
const makeTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "ax-advise-tap-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tap = fileURLToPath(new URL("./advise-tap.ts", import.meta.url));

describe("advise tap", () => {
  test("preserves target output and blocking exit when the ledger write fails", async () => {
    const home = makeTempDir();
    const target = join(home, "blocking-hook.ts");
    writeFileSync(target, 'process.stderr.write("BLOCKED by target\\n"); process.exit(2);\n');

    const proc = Bun.spawn(["bun", tap, target], {
      env: { ...process.env, HOME: home },
      stdin: Buffer.from(JSON.stringify({ session_id: "s", tool_name: "Agent" })),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect({ exitCode, stdout, stderr }).toEqual({
      exitCode: 2,
      stdout: "",
      stderr: "BLOCKED by target\n",
    });
  });

  test("rotates a full ledger before it appends to the live file", async () => {
    const home = makeTempDir();
    const hooksDir = join(home, ".ax", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    const log = join(hooksDir, "advise-log.jsonl");
    const fullSize = 10 * 1024 * 1024;
    writeFileSync(log, "x".repeat(fullSize));
    const target = join(home, "allow-hook.ts");
    writeFileSync(target, "process.exit(0);\n");

    const proc = Bun.spawn(["bun", tap, target], {
      env: { ...process.env, HOME: home },
      stdin: Buffer.from(JSON.stringify({ session_id: "s", tool_name: "Agent" })),
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(0);

    const segments = readdirSync(hooksDir).filter((name) => /^advise-log\..+\.jsonl$/.test(name));
    expect(segments).toHaveLength(1);
    expect(statSync(join(hooksDir, segments[0]!)).size).toBe(fullSize);
    expect(statSync(log).size).toBeLessThan(fullSize);
    expect(JSON.parse(readFileSync(log, "utf8"))).toMatchObject({ session_id: "s" });
  });
});
