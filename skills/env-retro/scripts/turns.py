#!/usr/bin/env python3 -I
"""Compact ledger of one Claude Code session log (JSONL).

Usage: turns.py <session.jsonl> [--full]

Prints one line per tool call with its outcome, then a summary. Flags:
  ERR    tool_result marked is_error
  DENY   a PreToolUse hook denied the call
  RETRY  identical command/input re-sent after an ERR or DENY
  AGENT  subagent dispatch
Tokens are read from message.usage (input + cache_read + cache_create / output).
"""
import json, sys, collections

path = sys.argv[1]
full = "--full" in sys.argv
calls = {}            # tool_use id -> record
order = []
turn = 0
usage_in = usage_out = 0
user_msgs = 0
prev_inputs = {}      # (tool, input-json) -> last status

def head(s, n=100):
    s = " ".join(str(s).split())
    return s if len(s) <= n else s[: n - 1] + "…"

with open(path, encoding="utf-8", errors="replace") as f:
    for line in f:
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        msg = rec.get("message") or {}
        role = msg.get("role")
        content = msg.get("content")
        if rec.get("type") == "user" and isinstance(content, str):
            user_msgs += 1
            turn += 1
            order.append(("USER", turn, head(content, 90)))
            continue
        if not isinstance(content, list):
            continue
        if role == "assistant":
            u = msg.get("usage") or {}
            usage_in += u.get("input_tokens", 0) + u.get("cache_read_input_tokens", 0) + u.get("cache_creation_input_tokens", 0)
            usage_out += u.get("output_tokens", 0)
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "tool_use":
                inp = block.get("input") or {}
                name = block.get("name", "?")
                if name == "Bash":
                    label = inp.get("description") or head(inp.get("command", ""))
                    key = inp.get("command", "")
                elif name in ("Read", "Edit", "Write"):
                    label = inp.get("file_path", "")
                    key = json.dumps(inp, sort_keys=True)
                elif name == "Agent":
                    label = inp.get("description", "")
                    key = json.dumps(inp, sort_keys=True)
                else:
                    label = head(json.dumps(inp), 80)
                    key = json.dumps(inp, sort_keys=True)
                r = {"turn": turn, "tool": name, "label": head(label, 90), "flags": [], "key": (name, key), "cmd": inp.get("command", "")}
                if name == "Agent":
                    r["flags"].append("AGENT")
                if prev_inputs.get(r["key"]) in ("ERR", "DENY"):
                    r["flags"].append("RETRY")
                calls[block.get("id")] = r
                order.append(("CALL", r))
            elif block.get("type") == "tool_result":
                r = calls.get(block.get("tool_use_id"))
                if not r:
                    continue
                body = block.get("content")
                if isinstance(body, list):
                    body = " ".join(b.get("text", "") for b in body if isinstance(b, dict))
                body = str(body or "")
                status = "OK"
                if "hook error" in body[:200] or "permissionDecision" in body[:300] and "deny" in body[:300]:
                    status = "DENY"
                elif block.get("is_error"):
                    status = "ERR"
                if status != "OK":
                    r["flags"].append(status)
                    r["why"] = head(body, 140)
                prev_inputs[r["key"]] = status
                r["out_bytes"] = len(body)

by_tool = collections.Counter()
flagged = collections.Counter()
for item in order:
    if item[0] == "USER":
        _, t, text = item
        print(f"\n--- turn {t}: {text}")
        continue
    r = item[1]
    by_tool[r["tool"]] += 1
    for fl in r["flags"]:
        flagged[fl] += 1
    fl = " ".join(r["flags"])
    size = r.get("out_bytes", 0)
    big = " BIG" if size > 8000 else ""
    print(f"  {r['tool']:<8} {r['label']}{('  [' + fl + ']') if fl else ''}{big}")
    if fl and ("ERR" in fl or "DENY" in fl):
        print(f"           -> {r.get('why','')}")
    if full and r["cmd"]:
        print(f"           $ {head(r['cmd'], 200)}")

print("\n=== summary")
print(f"user turns: {user_msgs}   tool calls: {sum(by_tool.values())}   tokens in/out: {usage_in:,} / {usage_out:,}")
print("by tool:  " + ", ".join(f"{k} {v}" for k, v in by_tool.most_common()))
print("flags:    " + (", ".join(f"{k} {v}" for k, v in flagged.most_common()) or "none"))
print("BIG = tool result over 8 KB (candidate for Tool economy)")
