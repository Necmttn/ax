"use client";
import { useEffect, useRef, useState } from "react";
import { PROVIDERS } from "./supports-strip";

/* ------------------------------------------------------------------ *
 * Terminal emulator that streams ax in action - a different use case
 * per tab, cycling forever, across every harness it watches.
 * - fixed-height viewport, auto-scrolls its own content (no page scroll)
 * - real brand logos in the banner (not ascii)
 * - animated ingest bar; loops infinitely
 * - emits a window event per action so the pipeline can react later
 * ------------------------------------------------------------------ */

type LineKind =
  | "sys"
  | "cmd"
  | "out"
  | "ok"
  | "err"
  | "say"
  | "user"
  | "add"
  | "ingest"
  | "hook"
  | "inject";

type ScriptLine = {
  kind: LineKind;
  text: string;
  delay: number;
  pulse?: string;
  done?: string; // completion text for an "ingest" line
};
type RenderLine = { id: number; kind: LineKind; text: string };

type Scene = {
  key: string; // tab label suffix / use case
  tab: string; // full tab label
  harness: string; // PROVIDERS key for the logo
  accent: string; // css color suffix
  name: string;
  meta: string;
  pixel?: string[]; // optional pixel-art mark (Claude Code) instead of an svg
  script: ScriptLine[];
};

const LOGO: Record<string, React.ReactNode> = Object.fromEntries(
  PROVIDERS.map((p) => [p.key, p.svg])
);

// Official Claude Code mark (Downloads/claudecode-color.svg), keyed to
// currentColor so it picks up the tile accent.
function ClaudeMascot() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        clipRule="evenodd"
        fillRule="evenodd"
        fill="currentColor"
        d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z"
      />
    </svg>
  );
}

const SCENES: Scene[] = [
  {
    key: "retro",
    tab: "retro · claude",
    harness: "claude",
    accent: "claude",
    name: "Claude Code",
    meta: "Opus 4.7 · ~/Projects/ax",
    script: [
      { kind: "ok", text: "✓ webhook retries shipped - 6 tests green", delay: 320 },
      { kind: "say", text: "before I close this out, let me retro the session - catch anything I keep repeating.", delay: 840 },
      { kind: "cmd", text: "⏺ Bash(ax retro emit --session=4129)", delay: 620, pulse: "claude" },
      { kind: "ingest", text: "ingesting transcript", delay: 240, pulse: "git" },
      { kind: "out", text: "⎿ tried=8 · worked=6 · failed=3 · next=2", delay: 360 },
      { kind: "cmd", text: "⏺ Bash(ax retro reflect --since=7d)", delay: 760, pulse: "subagent" },
      { kind: "out", text: "⎿ 3 proposals ranked:", delay: 340 },
      { kind: "out", text: "   1. feature → fix chains   ×26  → post-feature-verify    hi", delay: 150 },
      { kind: "out", text: "   2. main-branch edits      ×7   → main-branch-guardrail  lo", delay: 150 },
      { kind: "out", text: "   3. ingest regressions     ×3   → ingest-regression      hi", delay: 150 },
      { kind: "say", text: "you keep shipping a fix right after a feature in the same file - 26× this week. I'd add post-feature-verify. want it?", delay: 940 },
      { kind: "user", text: "❯ yeah, do it", delay: 900 },
      { kind: "cmd", text: "⏺ Bash(ax improve accept post-feature-verify --with-agent)", delay: 680, pulse: "subagent" },
      { kind: "add", text: "   + trigger: feature commits followed by overlapping fixes", delay: 150 },
      { kind: "ok", text: "⎿ marker landed · verdict pending at +30 sessions", delay: 360, pulse: "claude" },
      { kind: "say", text: "done - your next session opens with that checkpoint.", delay: 740 },
    ],
  },
  {
    key: "replay",
    tab: "replay · codex",
    harness: "codex",
    accent: "codex",
    name: "OpenAI Codex",
    meta: "gpt-5-codex · ~/Projects/ax",
    script: [
      { kind: "user", text: "❯ the live-traces work last week went really smoothly. can you make it repeatable?", delay: 340 },
      { kind: "say", text: "on it - pulling that session out of the graph.", delay: 780 },
      { kind: "cmd", text: "$ ax recall --session=0e9c5a1 --top=5", delay: 640, pulse: "codex" },
      { kind: "ingest", text: "ingesting transcript", delay: 240, pulse: "git" },
      { kind: "out", text: "› closure: feature_only · 38 turns · 0 corrections", delay: 360 },
      { kind: "out", text: "› plan-mode first · TDD per module · verify-before-commit ×8", delay: 180 },
      { kind: "cmd", text: "$ ax skills pairs --since=session=0e9c5a1", delay: 720, pulse: "subagent" },
      { kind: "out", text: "› writing-plans → tdd → verify → narrow-pr  (3 strong pairs)", delay: 360 },
      { kind: "say", text: "that path shipped clean, zero rollbacks. I can synth it into a workflow you run before the next refactor.", delay: 960 },
      { kind: "user", text: "❯ perfect - call it clean-feature-ship", delay: 980 },
      { kind: "cmd", text: "$ ax workflow synth --from=0e9c5a1 --name=clean-feature-ship", delay: 700, pulse: "subagent" },
      { kind: "add", text: "   + phases: plan → tdd → verify-commit → narrow-pr", delay: 150 },
      { kind: "ok", text: "› synthesized · /workflow clean-feature-ship", delay: 360, pulse: "claude" },
      { kind: "say", text: "done. replay it any time.", delay: 720 },
    ],
  },
  {
    key: "recall",
    tab: "recall · cursor",
    harness: "cursor",
    accent: "cursor",
    name: "Cursor",
    meta: "composer · ~/Projects/ax",
    script: [
      { kind: "user", text: "❯ ok, back on the webhook retries from yesterday - where were we?", delay: 340 },
      { kind: "say", text: "let me re-run the webhook tests to see where it stands.", delay: 760 },
      { kind: "cmd", text: "▸ Bash(pnpm test webhooks)", delay: 640, pulse: "cursor" },
      { kind: "err", text: "✗ FAIL · TypeError: cannot read properties of undefined (reading 'sig')", delay: 460 },
      { kind: "hook", text: "● ax hook · post_tool_use fired on the failed call", delay: 540, pulse: "git" },
      {
        kind: "ingest",
        text: "matching error signature",
        delay: 220,
        pulse: "subagent",
        done: "matched · session 1c4f (9d ago) · fixed in 1 commit",
      },
      { kind: "inject", text: "↪ injected: express.json() ate the raw body - verify_signature needs it", delay: 400 },
      { kind: "inject", text: "↪ fix: mount express.raw({ type: 'application/json' }) on the webhook route", delay: 240 },
      { kind: "say", text: "ah - you hit this exact error 9 days ago. it's the body parser. applying the same fix.", delay: 900 },
      { kind: "cmd", text: "▸ Edit(src/routes/webhooks.ts)", delay: 680, pulse: "claude" },
      { kind: "add", text: "+ app.post(\"/webhooks\", express.raw({ type: \"application/json\" }), handler)", delay: 160 },
      { kind: "cmd", text: "▸ Bash(pnpm test webhooks)", delay: 700, pulse: "cursor" },
      { kind: "ok", text: "✓ PASS · 6 passed in 1.2s", delay: 460, pulse: "claude" },
      { kind: "say", text: "fixed first try - ax recalled it the moment the call failed. no rabbit hole.", delay: 800 },
    ],
  },
  {
    key: "doctor",
    tab: "doctor · opencode",
    harness: "opencode",
    accent: "opencode",
    name: "OpenCode",
    meta: "local model · ~/Projects/ax",
    script: [
      { kind: "user", text: "❯ how's my setup doing? anything worth cleaning up?", delay: 340 },
      { kind: "say", text: "let me grade the harness.", delay: 720 },
      { kind: "cmd", text: "⏺ Bash(ax doctor)", delay: 640, pulse: "opencode" },
      { kind: "ingest", text: "scanning harness", delay: 240, pulse: "git", done: "scanned · 20 skills · 8 hooks · 14 days" },
      { kind: "out", text: "└ harness score: 72 / 100 · needs work", delay: 380 },
      { kind: "out", text: "└ flags:", delay: 240 },
      { kind: "err", text: "   ✗ 9 of 20 skills unused this week", delay: 160 },
      { kind: "err", text: "   ✗ 2 accepted hooks missing recovery_path", delay: 150 },
      { kind: "ok", text: "   ✓ safety contract: 100%", delay: 150 },
      { kind: "cmd", text: "⏺ Bash(ax improve recommend --top=3)", delay: 720, pulse: "subagent" },
      { kind: "out", text: "└ 1. drop 9 stale skills → less context bloat       hi", delay: 160 },
      { kind: "out", text: "   2. add recovery_path to pre_commit hook          hi", delay: 150 },
      { kind: "out", text: "   3. promote recall skill (used 26×, untagged)     md", delay: 150 },
      { kind: "say", text: "biggest wins: drop the 9 stale skills and add recovery_path to your commit hook. apply both?", delay: 860 },
      { kind: "user", text: "❯ go for it", delay: 880 },
      { kind: "ok", text: "└ applied · projected score → 84", delay: 380, pulse: "claude" },
      { kind: "say", text: "done. re-checks at the next sync.", delay: 720 },
    ],
  },
  {
    key: "classify",
    tab: "classify · claude",
    harness: "claude",
    accent: "claude",
    name: "Claude Code",
    meta: "Opus 4.7 · ~/Projects/ax",
    script: [
      { kind: "user", text: "❯ I've got a pile of skills with no roles - can you sort out what each one does?", delay: 360 },
      { kind: "say", text: "I'll have ax draft a brief per skill, then work them in parallel.", delay: 840 },
      { kind: "cmd", text: "⏺ Bash(ax skills classify)", delay: 640, pulse: "claude" },
      { kind: "ingest", text: "drafting task briefs", delay: 240, pulse: "subagent", done: "wrote 7 briefs to .ax/tasks/" },
      { kind: "out", text: "⎿ .ax/tasks/classify-recall.md", delay: 200 },
      { kind: "out", text: "   .ax/tasks/classify-verify-before-completion.md", delay: 130 },
      { kind: "out", text: "   .ax/tasks/classify-narrow-pr-scope.md   … +4 more", delay: 130 },
      { kind: "say", text: "now a subagent per brief - each reads its skill + recent invocations and fills in the role.", delay: 900 },
      { kind: "cmd", text: "⏺ Task(classify-skill) ×7  · parallel", delay: 700, pulse: "subagent" },
      { kind: "out", text: "⎿ subagents working the briefs…", delay: 460 },
      { kind: "add", text: "   recall → role: retrieval · 0.92", delay: 180 },
      { kind: "add", text: "   verify-before-completion → role: gate · 0.95", delay: 150 },
      { kind: "add", text: "   narrow-pr-scope → role: scope · 0.81", delay: 150 },
      { kind: "cmd", text: "⏺ Bash(ax skills lint --task-dir=.ax/tasks)", delay: 700, pulse: "claude" },
      { kind: "ok", text: "⎿ reconciled · 7 plays_role edges written to the graph", delay: 420, pulse: "claude" },
      { kind: "say", text: "done - every skill's tagged now, so weighted ranking and doctor can actually use them.", delay: 820 },
    ],
  },
];

function ingestBar(label: string, pct: number) {
  const cells = 14;
  const filled = Math.round((pct / 100) * cells);
  const bar = "█".repeat(filled) + "░".repeat(cells - filled);
  return `   ${label} ▕${bar}▏ ${String(pct).padStart(3, " ")}%`;
}
const INGEST_DONE = "   ingested · 4,773 sessions · 369k turns indexed";

function pulse(src: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("ax:pipeline-pulse", { detail: { src } }));
}

export function RetroTerminal() {
  const rootRef = useRef<HTMLElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const startRef = useRef(0);
  const pausedRef = useRef(false);
  const [lines, setLines] = useState<RenderLine[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const [seq, setSeq] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    let counter = 0;
    const uid = () => ++counter;
    const sleep = (ms: number) =>
      new Promise<void>((res) => timers.push(setTimeout(res, ms)));
    const scrollDown = () =>
      requestAnimationFrame(() => {
        const v = bodyRef.current;
        if (v) v.scrollTop = v.scrollHeight;
      });
    const waitWhilePaused = async () => {
      while (pausedRef.current && !cancelled) await sleep(120);
    };

    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    async function streamScene(idx: number) {
      setActiveIdx(idx);
      setLines([]);
      scrollDown();
      await sleep(420);
      if (cancelled) return false;

      const scene = SCENES[idx]!;

      if (reduced) {
        setLines(
          scene.script.map((s) => ({
            id: uid(),
            kind: s.kind === "ingest" ? "ok" : s.kind,
            text: s.kind === "ingest" ? (s.done ?? INGEST_DONE) : s.text,
          }))
        );
        scrollDown();
        return false;
      }

      for (const ln of scene.script) {
        await waitWhilePaused();
        if (cancelled) return false;
        await sleep(ln.delay);
        if (cancelled) return false;
        if (ln.pulse) pulse(ln.pulse);

        if (ln.kind === "ingest") {
          const id = uid();
          const label = ln.text;
          const done = ln.done ?? INGEST_DONE;
          setLines((p) => [...p, { id, kind: "ingest", text: ingestBar(label, 0) }]);
          scrollDown();
          for (let pct = 12; pct <= 100; pct += 12) {
            await sleep(52);
            if (cancelled) return false;
            const v = Math.min(100, pct);
            setLines((p) => p.map((l) => (l.id === id ? { ...l, text: ingestBar(label, v) } : l)));
          }
          await sleep(160);
          setLines((p) =>
            p.map((l) => (l.id === id ? { ...l, kind: "ok", text: done } : l))
          );
          scrollDown();
        } else {
          setLines((p) => [...p, { id: uid(), kind: ln.kind, text: ln.text }]);
          scrollDown();
        }
      }
      await sleep(3300);
      await waitWhilePaused();
      return true;
    }

    async function loop() {
      let i = startRef.current;
      while (!cancelled) {
        const keepGoing = await streamScene(i % SCENES.length);
        if (!keepGoing) break;
        i++;
      }
    }

    let io: IntersectionObserver | null = null;
    if (reduced) {
      loop();
    } else if (typeof IntersectionObserver !== "undefined" && rootRef.current) {
      io = new IntersectionObserver(
        (entries) => {
          entries.forEach((e) => {
            if (e.isIntersecting) {
              io?.disconnect();
              io = null;
              loop();
            }
          });
        },
        { threshold: 0.25 }
      );
      io.observe(rootRef.current);
    } else {
      loop();
    }

    return () => {
      cancelled = true;
      timers.forEach((t) => clearTimeout(t));
      io?.disconnect();
    };
  }, [seq]);

  const active = SCENES[activeIdx]!;

  return (
    <section className="demo retro-demo" ref={rootRef}>
      <div className="demo-intro">
        <span className="eyebrow">the loop, in your terminal</span>
        <h2>Your sessions, working for the next one.</h2>
        <p>
          Every session lands in one local graph your agent can reach back into
          &mdash; to catch a repeat mistake, replay a clean run, recover the
          moment a test fails, or grade the harness itself. Same loop, whatever
          you run it in.
        </p>
      </div>

      <div
        className={`rt rt--${active.accent}`}
        onMouseEnter={() => {
          pausedRef.current = true;
          setPaused(true);
        }}
        onMouseLeave={() => {
          pausedRef.current = false;
          setPaused(false);
        }}
      >
        <div className="rt-chrome">
          <span className="rt-dots">
            <span className="rt-dot" />
            <span className="rt-dot" />
            <span className="rt-dot" />
          </span>
          <div className="rt-tabs" role="tablist">
            {SCENES.map((s, i) => (
              <button
                key={s.key}
                type="button"
                role="tab"
                aria-selected={i === activeIdx}
                aria-label={`${s.key} · ${s.name}`}
                className={`rt-tab${i === activeIdx ? " is-active" : ""}`}
                onClick={() => {
                  startRef.current = i;
                  setSeq((n) => n + 1);
                }}
              >
                <span className="rt-tab-logo" aria-hidden="true">
                  {s.harness === "claude" ? <ClaudeMascot /> : LOGO[s.harness]}
                </span>
                {s.key}
              </button>
            ))}
          </div>
          <span
            className={`rt-pill${paused ? " is-paused" : ""}`}
            aria-hidden="true"
          >
            {paused ? "● paused" : "● live"}
          </span>
        </div>

        <div className="rt-banner">
          <span className="rt-logo" aria-hidden="true">
            {active.harness === "claude" ? <ClaudeMascot /> : LOGO[active.harness]}
          </span>
          <span className="rt-banner-text">
            <span className="rt-name">{active.name}</span>
            <span className="rt-meta">{active.meta}</span>
          </span>
        </div>

        <div className="rt-viewport" ref={bodyRef} aria-live="polite">
          <div className="rt-feed">
            {lines.map((l) => (
              <div key={l.id} className={`rt-line rt-line--${l.kind}`}>
                {l.text}
              </div>
            ))}
            <div className="rt-cursor" aria-hidden="true">
              <span className="rt-caret" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
