#!/usr/bin/env bun
// advise-tap: a transparent observer for PreToolUse hooks.
//
// CC discards a hook's `additionalContext` after injecting it (never written to
// the transcript), and the OTLP hook span carries no payload - so ax, which only
// reads transcripts + OTLP, never sees the advice. Yet CC HANDS the hook
// `session_id` on stdin: the advice IS linkable, nobody persists it.
//
// This wrapper sits in front of the real hook: it reads the CC payload, runs the
// hook, captures its stdout (the injected additionalContext), appends one JSONL
// row keyed by session_id, then passes the hook's stdout through UNCHANGED so the
// model still gets advised. Result: ~/.ax/hooks/advise-log.jsonl is a ledger of
// every injection - what was injected, into which session, on which dispatch.
//
// Wire it by pointing the hook command at this file with the real hook as arg:
//   bun ~/.ax/hooks/advise-tap.ts ~/.ax/hooks/route-dispatch.js
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG = join(homedir(), ".ax/hooks/advise-log.jsonl");
const target = process.argv[2];
if (!target) {
  process.stderr.write("advise-tap: missing target hook path (argv[2])\n");
  process.exit(0); // fail open
}

const stdin = await Bun.stdin.text();

// Run the real hook, feeding it the exact payload CC sent us.
const proc = Bun.spawn(["bun", target], { stdin: Buffer.from(stdin), stdout: "pipe", stderr: "pipe" });
const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
const exitCode = await proc.exited;

// Pull the link key + the injected advice out of the I/O.
let sessionId: string | null = null;
let toolName: string | null = null;
let toolInput: unknown = null;
let advice: string | null = null;
try {
  const payload = JSON.parse(stdin);
  sessionId = payload.session_id ?? null;
  toolName = payload.tool_name ?? null;
  toolInput = payload.tool_input ?? null;
} catch {}
try {
  advice = JSON.parse(out)?.hookSpecificOutput?.additionalContext ?? null;
} catch {}

// One ledger row per fire. `ts` stamped by the OS (hooks may run in cron).
appendFileSync(
  LOG,
  JSON.stringify({
    ts: new Date().toISOString(),
    session_id: sessionId,
    tool: toolName,
    description: (toolInput as { description?: string })?.description ?? null,
    injected: advice, // the additionalContext the model received (null = allow)
    verdict: advice ? "advise" : "allow",
    raw_stdout: out.trim() || null,
  }) + "\n",
);

// Transparent pass-through: the model still gets exactly what the hook emitted.
if (err) process.stderr.write(err);
if (out) process.stdout.write(out);
process.exit(exitCode === 2 ? 2 : 0);
