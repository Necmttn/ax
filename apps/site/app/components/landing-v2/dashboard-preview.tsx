"use client";
import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { HeroLogoField, PROVIDERS } from "./supports-strip";
import { RetroTerminal } from "./retro-terminal";

// ============================================================================
// Mission Control preview - a static recreation of the studio home (instrument
// HUD) for the landing. Charts are CSS-only (segbars, heat cells, LED, archetype
// sigil); numbers are representative demo data. Mirrors the real component at
// apps/studio/src/instrument/mission-control.tsx so the landing reflects the
// ramped studio. Styles: .browser--instrument .mc-* in globals.css.
// ============================================================================
const MC_MODELS = [
  { name: "opus", pct: 46, usd: "$1.9K", tone: "var(--blue)" },
  { name: "sonnet", pct: 31, usd: "$1.3K", tone: "#e0556f" },
  { name: "fable", pct: 14, usd: "$588", tone: "var(--green)" },
  { name: "haiku", pct: 6, usd: "$252", tone: "var(--violet)" },
  { name: "gpt-5", pct: 3, usd: "$126", tone: "var(--gold)" },
];

// deterministic ~21-week activity strip (5 rows × 30 cols), contribution levels 0..4
const MC_ACTIVITY: number[] = Array.from({ length: 150 }, (_, i) => {
  const x = i % 30;
  const y = Math.floor(i / 30);
  const v = Math.sin(x * 0.7 + y) * 0.5 + Math.sin(x * 0.3) * 0.4 + 0.5;
  if (v < 0.18) return 0;
  return v > 0.85 ? 4 : v > 0.6 ? 3 : v > 0.35 ? 2 : 1;
});

// archetype "ring" sigil (11×7 dot-matrix), the studio's primary-archetype glyph
const MC_SIGIL: number[] = Array.from({ length: 77 }, (_, i) => {
  const x = i % 11;
  const y = Math.floor(i / 11);
  const d = Math.hypot(x - 5, (y - 3) * 1.25);
  const v = Math.max(0, Math.min(1, 1.1 - Math.abs(d - 2.7) * 0.8));
  return v > 0.66 ? 4 : v > 0.4 ? 3 : v > 0.15 ? 2 : v > 0 ? 1 : 0;
});

const pad2 = (n: number) => String(n).padStart(2, "0");

function McLed({ tone }: { tone?: "alert" }) {
  return <span className={`mc-led${tone ? ` mc-led--${tone}` : ""}`} aria-hidden="true" />;
}

function McSeg({
  total,
  on,
  color,
  gradient,
}: { total: number; on: number; color?: string; gradient?: boolean }) {
  return (
    <div className="mc-seg" aria-hidden="true">
      {Array.from({ length: total }, (_, i) => {
        const lit = i < on;
        const style: React.CSSProperties = { animationDelay: `${0.2 + i * 0.04}s` };
        if (lit && color) {
          if (gradient) {
            const pct = Math.round(34 + 66 * (on <= 1 ? 1 : i / (on - 1)));
            style.background = `color-mix(in srgb, ${color} ${pct}%, var(--surface2))`;
          } else {
            style.background = color;
          }
        }
        return <i key={i} className={lit ? "on" : ""} style={style} />;
      })}
    </div>
  );
}

function McCells({
  levels,
  cols,
  cell = 11,
}: { levels: number[]; cols: number; cell?: number }) {
  return (
    <div
      className="mc-cells"
      aria-hidden="true"
      style={{
        gridTemplateColumns: `repeat(${cols}, ${cell}px)`,
        gridAutoRows: `${cell}px`,
      }}
    >
      {levels.map((l, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        return (
          <i
            key={i}
            className={l ? `lvl-${l}` : ""}
            style={{ animationDelay: `${0.15 + (col + row) * 0.016}s` }}
          />
        );
      })}
    </div>
  );
}

// SSR-stable placeholder until the clock mounts client-side, then it ticks live.
const MC_PLACEHOLDER = new Date(2026, 5, 16, 23, 14, 7);

function McClock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const iv = window.setInterval(() => {
      if (!document.hidden) setNow(new Date());
    }, 1000);
    return () => window.clearInterval(iv);
  }, []);
  const t = now ?? MC_PLACEHOLDER;
  const day = t.toLocaleDateString("en-US", { weekday: "long" });
  const date = t
    .toLocaleDateString("en-US", { day: "2-digit", month: "short", year: "numeric" })
    .toUpperCase();
  return (
    <section className="mc-card mc-clock">
      <div className="mc-clock-top mc-label">
        <span>local time</span>
        <span className="mc-live">
          <McLed />
          live &middot; 312 active days
        </span>
      </div>
      <div className="mc-clock-time">
        <McLed tone="alert" />
        <span className="mc-doto t">
          {pad2(t.getHours())}:{pad2(t.getMinutes())}
        </span>
        <span className="mc-doto s">{pad2(t.getSeconds())}</span>
      </div>
      <div className="mc-clock-foot">
        <div>
          <div className="mc-day">{day}</div>
          <div className="mc-label">{date} &middot; 2,847 sessions traced</div>
        </div>
        <div className="mc-clock-push">
          <div className="mc-label">archetype &middot; high</div>
          <div className="mc-label mc-strong">
            The Cartographer <span className="mc-sq" />
          </div>
        </div>
      </div>
    </section>
  );
}

const INSTALL_CMD = "curl -fsSL ax.necmttn.com/install | sh";
const DOCS_URL = "https://ax.necmttn.com/docs";

// Self-contained "give this to your agent" prompt for the landing site: unlike
// packages/lib's AGENT_ONBOARDING_PROMPT (run after ax is installed, by `ax
// setup` / install.sh), this one is pasted by someone who hasn't installed yet,
// so it opens with the install step. Kept inline so the marketing bundle stays
// free of the @ax/lib workspace dep.
const AGENT_PROMPT = `Set up ax for me, end to end. ax is a local agent-experience graph over my Claude Code + Codex history - it runs locally and I review every change.

PRIVACY (read first, so you can answer if I ask whether this is safe to run): ax is fully local. Ingest reads my transcripts, git history, and tool calls into a SurrealDB on 127.0.0.1 - nothing is uploaded, there is no account, no cloud, and no outbound call at ingest. The ONLY thing that can ever leave my machine is \`ax profile publish\`, which is opt-in and consent-gated: it shares an aggregates-only JSON (counts, day streaks, model split, skill/hook names, taste-pattern summaries) to a public gist I control - NEVER transcript content, code, project names, or file paths. \`--no-cost\` strips the dollar figures too, and \`ax profile unpublish\` deletes it. Do NOT run \`ax profile publish\` as part of this setup. If I ask about privacy or data handling, answer from these facts; it's AGPL-3.0, so you can also read the source to confirm.

1. INSTALL - run \`${INSTALL_CMD}\` to install the ax CLI. Reference: ${DOCS_URL}

2. INGEST MY HISTORY - first run \`ax ingest --dry-run\` and tell me, in plain words, how long a full backfill will take. Then start the ingest in the BACKGROUND so we can keep working: run \`ax ingest\` as a background job with AX_PROGRESS=plain, and watch its output for progress and completion. Tell me I can watch it fill live in the dashboard - run \`ax serve\` and open http://127.0.0.1:1738. When the ingest finishes, summarize what landed: total sessions, turns, and the top skills/tools I actually use. Then continue with the steps below.

3. VERIFY - run \`ax doctor\`. If anything isn't ok, diagnose and fix it, then re-run until it is.

4. LABEL what ax can't classify - run \`ax skills classify\`. It writes one \`.ax/tasks/classify-<skill>.md\` brief per skill I use but ax can't role-tag. For each brief: read the skill, decide its role(s), and fill the YAML frontmatter at the top (\`primary_role:\` is required; \`secondary\`, \`confidence\`, \`rationale\` are optional). Run \`ax roles\` to see labels already in use. Then run \`ax skills lint\` to apply them. If it says "no unclassified skills", that's fine.

5. SHOW me the result - run \`ax skills weighted\` and \`ax skills config\`. Tell me which skills you labeled and why, and flag anything ax marked orphan or out-of-scope.

6. BUILD MY PROFILE + AGENT WRAPPED - first run \`ax profile show\` for a quick text fingerprint (sessions, active days + streak, model split, top skills, installed hooks, workflow arcs, taste patterns) and read it back to me in a few sentences. THEN build my Agent Wrapped deck, because the dashboard's Wrapped tab stays BLANK until you do - ingest does not fill it. Run \`ax wrapped generate\`; it writes a brief to \`.ax/tasks/wrapped-generate-<date>.md\`. Follow that brief: mine my graph for the answers and assemble the recap cards as \`{ "cards": [{question, headline, body, sensitivity?}] }\` JSON, then publish them with \`ax wrapped publish --file=<your-cards.json>\` (or pipe the JSON on stdin). Now my Wrapped deck is populated - tell me to run \`ax serve\` and open http://127.0.0.1:1738 to see it. All of this stays LOCAL: \`ax profile show\` and \`ax wrapped publish\` write only to my own machine and upload nothing. Do NOT run \`ax profile publish\` (that is the one command that leaves my machine).

7. GATHER MY INSIGHTS IN PARALLEL - the three areas below are independent and only READ the local graph, so fan them out instead of running them one by one: dispatch one subagent per area, all at once (cap ~3 concurrent - they share one local SurrealDB). Put these GATHER subagents on a CHEAP model (claude-sonnet-4-6, or claude-haiku-4-5 for the lightest) - running fixed read-only commands and pasting back the output is mechanical, and routing it down dogfoods ax's own cost lens. Each subagent ONLY runs its commands and returns the raw output plus a short factual summary; it makes NO decisions. Keep all the JUDGMENT on yourself, the strongest model - do not delegate the thinking. The areas: (a) SPEND - \`ax cost sessions\`, \`ax cost routability\`, \`ax dispatches --candidates\`; (b) FRICTION - \`ax improve recommend\`, \`ax insights friction\`, \`ax insights tools\`; (c) HISTORY (run inside one of my git repos) - \`ax sessions here --days=30\`, \`ax recall "<a topic worth searching>"\`. When all three return, YOU synthesize: my single biggest cost driver and the largest concrete saving, the top 1-2 fixes worth accepting and why (if I say yes, run \`ax improve accept <id>\` then \`ax improve lint\`), and one genuinely useful thing from my history.

8. GIVE ME A NEXT STEP - recommend 1-2 under-used skills you'd reach for based on what you saw, then end with a concrete CTA: the exact command or prompt I should run next, and what outcome it will produce.`;

// ---- Wrapped recap charts (static recreations of the studio card-viz registry:
// apps/studio/src/instrument/card-viz.tsx). Each keys --card-accent. ----
function McBars({ data }: { data: number[] }) {
  const max = Math.max(...data, 1);
  const last = data.length - 1;
  return (
    <div className="mc-bars" aria-hidden="true">
      {data.map((b, i) => (
        <i
          key={i}
          className={i === last ? "is-now" : undefined}
          style={{ height: `${Math.max(6, (b / max) * 100)}%` }}
        />
      ))}
    </div>
  );
}

function McLine({ data }: { data: number[] }) {
  const W = 100;
  const H = 46;
  const padX = 2;
  const padT = 5;
  const padB = 5;
  const uh = H - padT - padB;
  const n = data.length;
  const max = Math.max(...data, 1);
  const xy = data.map((v, i) => [padX + (i / (n - 1)) * (W - 2 * padX), padT + (1 - v / max) * uh] as const);
  const stroke = `M ${xy.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" L ")}`;
  const area = `${stroke} L ${xy[n - 1][0].toFixed(1)} ${H - padB} L ${xy[0][0].toFixed(1)} ${H - padB} Z`;
  return (
    <svg className="mc-line" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="mcLineFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--card-accent)" stopOpacity="0.32" />
          <stop offset="100%" stopColor="var(--card-accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#mcLineFill)" />
      <path d={stroke} className="mc-line-stroke" fill="none" />
    </svg>
  );
}

function McRadar({ data }: { data: number[] }) {
  const axes = data.length;
  const cx = 23;
  const cy = 23;
  const R = 21;
  const max = Math.max(...data, 1);
  const ang = (i: number) => -Math.PI / 2 + (i / axes) * Math.PI * 2;
  const at = (i: number, r: number) => [cx + Math.cos(ang(i)) * r, cy + Math.sin(ang(i)) * r] as const;
  const rad = (v: number) => ((v / max) * 0.84 + 0.08) * R;
  const fmt = (p: readonly [number, number]) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;
  const poly = data.map((v, i) => fmt(at(i, rad(v)))).join(" ");
  return (
    <svg className="mc-radar" viewBox="0 0 46 46" aria-hidden="true">
      {[0.4, 0.7, 1].map((rr, k) => (
        <polygon key={k} className="web" points={Array.from({ length: axes }, (_, i) => fmt(at(i, rr * R))).join(" ")} />
      ))}
      <polygon className="mc-radar-fill" points={poly} />
      {data.map((v, i) => {
        const [x, y] = at(i, rad(v));
        return <circle key={i} className="mc-radar-node" cx={x.toFixed(1)} cy={y.toFixed(1)} r={1.5} />;
      })}
    </svg>
  );
}

function McRing({ pct }: { pct: number }) {
  const R = 15.5;
  const C = 2 * Math.PI * R;
  const dash = C * 0.75;
  const frac = Math.max(0.04, pct / 100);
  return (
    <div className="mc-ring" aria-hidden="true">
      <svg viewBox="0 0 40 40">
        <circle cx="20" cy="20" r={R} className="bg" strokeDasharray={`${dash} ${C}`} />
        <circle cx="20" cy="20" r={R} className="fg" strokeDasharray={`${dash} ${C}`} strokeDashoffset={dash * (1 - frac)} />
      </svg>
      <span className="mc-ring-val">{pct}</span>
    </div>
  );
}

function McWaffle({ pct }: { pct: number }) {
  const ROWS = 5;
  const COLS = 14;
  const total = ROWS * COLS;
  const on = Math.round((pct / 100) * total);
  return (
    <div className="mc-waffle" aria-hidden="true">
      {Array.from({ length: total }, (_, i) => {
        const col = i % COLS;
        const row = Math.floor(i / COLS);
        const order = col * ROWS + (ROWS - 1 - row);
        return <span key={i} className={`mc-waffle-cell${order < on ? " on" : ""}`} />;
      })}
    </div>
  );
}

function McCandles({ data }: { data: number[] }) {
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const span = Math.max(1, max - min);
  const Y = (v: number) => 4 + (1 - (v - min) / span) * 36;
  return (
    <div className="mc-candles" aria-hidden="true">
      {data.map((v, i) => {
        const prev = i === 0 ? data[0] : data[i - 1];
        const up = v >= prev;
        const oY = Y(prev);
        const cY = Y(v);
        const top = Math.min(oY, cY);
        const bodyH = Math.max(2, Math.abs(cY - oY));
        const wickTop = Math.min(top, Y(Math.max(v, prev)) - 3);
        const wickBot = Math.max(top + bodyH, Y(Math.min(v, prev)) + 3);
        return (
          <span key={i} className={`mc-candle ${up ? "up" : "dn"}`}>
            <span className="mc-candle-wick" style={{ top: `${wickTop}px`, height: `${Math.max(3, wickBot - wickTop)}px` }} />
            <span className="mc-candle-body" style={{ top: `${top}px`, height: `${bodyH}px` }} />
          </span>
        );
      })}
    </div>
  );
}

function McComet({ pct }: { pct: number }) {
  const cx = 23;
  const cy = 23;
  const rx = 19;
  const ry = 15;
  const frac = Math.max(0.02, pct / 100);
  const C = Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry)));
  const dash = C * frac;
  const ang = -Math.PI / 2 + frac * Math.PI * 2;
  const hx = cx + Math.cos(ang) * rx;
  const hy = cy + Math.sin(ang) * ry;
  return (
    <div className="mc-comet" aria-hidden="true">
      <svg viewBox="0 0 46 46">
        <ellipse className="mc-comet-orbit" cx={cx} cy={cy} rx={rx} ry={ry} />
        <ellipse
          className="mc-comet-trail"
          cx={cx}
          cy={cy}
          rx={rx}
          ry={ry}
          strokeDasharray={`${dash.toFixed(1)} ${C.toFixed(1)}`}
          transform={`rotate(-90 ${cx} ${cy})`}
        />
        <circle className="mc-comet-head" cx={hx.toFixed(1)} cy={hy.toFixed(1)} r={2.6} />
      </svg>
    </div>
  );
}

function McWave({ data }: { data: number[] }) {
  const W = 100;
  const H = 46;
  const mid = H / 2;
  const n = data.length;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const span = Math.max(1, max - min);
  const d = data
    .map((v, i) => {
      const x = (i / (n - 1)) * (W - 2) + 1;
      const y = mid + (0.5 - (v - min) / span) * (H - 10);
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg className="mc-wave" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <line className="mc-wave-grat" x1="0" y1={mid} x2={W} y2={mid} />
      <line className="mc-wave-grat dash" x1={W * 0.5} y1="2" x2={W * 0.5} y2={H - 2} />
      <path className="mc-wave-trace" d={d} fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function McBullet({ actual, target }: { actual: number; target: number }) {
  const onTrack = actual >= target;
  return (
    <div className="mc-bullet" aria-hidden="true">
      <div className="mc-bullet-track">
        <span className="mc-bullet-fill" style={{ width: `${actual}%` }} />
        <span className={`mc-bullet-tick${onTrack ? " ok" : ""}`} style={{ left: `${target}%` }} />
      </div>
      <div className="mc-bullet-foot">
        <span className="mc-bullet-val">{actual}</span>
        <span className="mc-bullet-goal">/ {target} goal</span>
      </div>
    </div>
  );
}

function McSignal({ on, bars = 6 }: { on: number; bars?: number }) {
  return (
    <div className="mc-signal" aria-hidden="true">
      {Array.from({ length: bars }, (_, i) => (
        <span
          key={i}
          className={`mc-signal-bar${i < on ? " on" : ""}`}
          style={{ height: `${28 + (i / (bars - 1)) * 70}%` }}
        />
      ))}
    </div>
  );
}

function McScatter({ data }: { data: number[] }) {
  const n = data.length;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const span = Math.max(1, max - min);
  const mean = data.reduce((a, b) => a + b, 0) / n;
  const meanY = 4 + (1 - (mean - min) / span) * 38;
  return (
    <div className="mc-scatter" aria-hidden="true">
      <svg className="mc-scatter-svg" viewBox="0 0 100 46" preserveAspectRatio="none">
        <line className="mc-scatter-mean" x1="0" y1={meanY.toFixed(1)} x2="100" y2={meanY.toFixed(1)} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="mc-scatter-dots">
        {data.map((v, i) => {
          const x = (i / (n - 1)) * 100;
          const y = 4 + (1 - (v - min) / span) * 38;
          return <span key={i} className={`mc-scatter-dot${v >= mean ? " hot" : ""}`} style={{ left: `${x}%`, top: `${y}px` }} />;
        })}
      </div>
    </div>
  );
}

function McDelta({ data }: { data: number[] }) {
  const last = data[data.length - 1];
  const first = data[0];
  const diff = last - first;
  const up = diff >= 0;
  const n = data.length;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const span = Math.max(1, max - min);
  const spark = data.map((v, i) => `${(i / (n - 1)) * 100},${(14 - ((v - min) / span) * 12).toFixed(1)}`).join(" ");
  return (
    <div className={`mc-delta ${up ? "up" : "dn"}`} aria-hidden="true">
      <div className="mc-delta-num">
        <span className="mc-delta-val">{Math.round(last)}</span>
        <span className="mc-delta-trend">
          <i>{up ? "▲" : "▼"}</i>
          {Math.abs(Math.round(diff))}
        </span>
      </div>
      <svg className="mc-delta-spark" viewBox="0 0 100 14" preserveAspectRatio="none">
        <polyline points={spark} fill="none" stroke="var(--card-accent)" strokeWidth="1.25" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

// The 12 wrapped readouts the floating popups cycle through - each keys a channel
// accent and carries one chart + a one-line caption. (Recreated from the studio
// card-viz registry: apps/studio/src/instrument/card-viz.tsx.)
const POP_CHARTS: ReadonlyArray<{
  key: string;
  accent: string;
  q: string;
  h: string;
  viz: React.ReactNode;
}> = [
  { key: "bars", accent: "acc-green", q: "when you ship", h: "Tuesday nights", viz: <McBars data={[22, 31, 28, 44, 39, 58, 47, 63, 71, 55, 82, 90, 74, 61, 88, 96]} /> },
  { key: "ring", accent: "acc-gold", q: "fixes stick", h: "82% hold", viz: <McRing pct={82} /> },
  { key: "line", accent: "acc-blue", q: "tokens / year", h: "1.4B", viz: <McLine data={[18, 24, 21, 33, 40, 38, 52, 60, 57, 71, 80, 78, 92, 100]} /> },
  { key: "radar", accent: "acc-violet", q: "skill profile", h: "systems mind", viz: <McRadar data={[82, 64, 91, 48, 73]} /> },
  { key: "waffle", accent: "acc-green", q: "paths covered", h: "73%", viz: <McWaffle pct={73} /> },
  { key: "candles", accent: "acc-rose", q: "session swings", h: "big nights", viz: <McCandles data={[40, 60, 55, 75, 70, 50, 62, 80, 72, 88]} /> },
  { key: "comet", accent: "acc-blue", q: "quota burn", h: "61%", viz: <McComet pct={61} /> },
  { key: "wave", accent: "acc-violet", q: "latency", h: "steady", viz: <McWave data={[50, 80, 20, 60, 35, 70, 45, 66, 30, 72]} /> },
  { key: "scatter", accent: "acc-rose", q: "cost vs reward", h: "lands cheap", viz: <McScatter data={[30, 50, 45, 70, 60, 85, 55, 40, 66, 52]} /> },
  { key: "bullet", accent: "acc-gold", q: "ship goal", h: "82 / 70", viz: <McBullet actual={82} target={70} /> },
  { key: "signal", accent: "acc-green", q: "harness health", h: "5 / 6", viz: <McSignal on={5} /> },
  { key: "delta", accent: "acc-blue", q: "weekly tokens", h: "+18", viz: <McDelta data={[40, 55, 48, 62, 70, 66, 78, 84]} /> },
];

// chart kinds that render small/fixed-size (center them in the popup viz row);
// the rest are full-width and stretch.
const POP_CENTERED = new Set(["ring", "radar", "comet", "waffle"]);
// 3 popup slots, each offset into the 12-chart ring so they always show
// different findings; advancing `popTick` cycles every chart through every slot.
const POP_SLOTS = [
  { off: 0, place: "mc-pop--tr" },
  { off: 4, place: "mc-pop--bl" },
  { off: 8, place: "mc-pop--br" },
];

export function DashboardPreview() {
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [hovered, setHovered] = useState(false);
  // Scroll-driven: the wrapped popups parallax (each at a different rate, for
  // depth) and cycle through all 12 charts as the section moves up the viewport.
  const mcStageRef = useRef<HTMLDivElement>(null);
  const [popTick, setPopTick] = useState(0);
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const stage = mcStageRef.current;
    if (!stage) return;
    const pops = Array.from(stage.querySelectorAll<HTMLElement>(".mc-pop"));
    const FACTORS = [1, -0.85, 0.5]; // per-slot parallax rate (tr, bl, br)
    const AMP = 46; // px of parallax drift
    const STEP = 120; // px of scroll per chart advance
    let scheduled = false;
    const update = () => {
      scheduled = false;
      const rect = stage.getBoundingClientRect();
      const vh = window.innerHeight || 1;
      const raw = ((vh - rect.top) / (vh + rect.height) - 0.5) * 2;
      const centered = Math.max(-1, Math.min(1, raw)); // clamp to -1..1

      pops.forEach((el, i) => {
        el.style.setProperty("--py", `${(centered * AMP * (FACTORS[i] ?? 0)).toFixed(1)}px`);
      });
      const scrolled = Math.max(0, vh - rect.top);
      const tick = Math.floor(scrolled / STEP);
      setPopTick((prev) => (prev === tick ? prev : tick));
    };
    const onScroll = () => {
      if (!scheduled) {
        scheduled = true;
        requestAnimationFrame(update);
      }
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  function onCopyPrompt() {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    navigator.clipboard.writeText(AGENT_PROMPT).then(() => {
      setCopiedPrompt(true);
      setTimeout(() => setCopiedPrompt(false), 2200);
    });
  }

  return (
    <>
      {/* ============= hero ============= */}
      <section className="hero">
        <HeroLogoField />
        <span className="eyebrow">a feedback loop for your coding agent</span>
        <h1>
          Turn every agent session<br />
          into a better <em>next run</em>.
        </h1>
        <p className="hero-human">
          Built because we got tired of guessing what actually works.
        </p>
        <p className="lede">
          ax watches every session your coding harness runs, spots the mistakes
          it repeats, and turns them into small, repo-specific fixes you review
          and apply &mdash; one at a time.
        </p>

        <div className="install-wrap">
          <span className="install-label">install in 30 seconds</span>

          <div className="cta-row">
            <button
              type="button"
              className="prompt-pill"
              onClick={onCopyPrompt}
              onMouseEnter={() => setHovered(true)}
              onMouseLeave={() => setHovered(false)}
              onFocus={() => setHovered(true)}
              onBlur={() => setHovered(false)}
              aria-label="copy agent setup prompt"
            >
              <span className="prompt-pill__icons" aria-hidden="true">
                {PROVIDERS.map((p) => (
                  <span
                    key={p.key}
                    className={`prompt-pill__icon prompt-pill__icon--${p.key}`}
                  >
                    {p.svg}
                  </span>
                ))}
              </span>
              <span className="prompt-pill__label">Copy setup prompt</span>
            </button>

            <Link to="/docs" className="cta-secondary">
              <span className="cta-secondary__icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" focusable="false">
                  <path
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinejoin="round"
                    d="M6 3.5h7L18 8v12.5H6z"
                  />
                  <path
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    d="M9 12h6M9 15.5h6"
                  />
                </svg>
              </span>
              Read the docs
            </Link>
          </div>

          <p
            className={`cta-foot${hovered ? " is-hover" : ""}${copiedPrompt ? " is-copied" : ""}`}
            aria-live="polite"
          >
            <span className="cta-foot__hint">
              paste it - your agent installs ax, labels your skills, and tells
              you which ones to actually use
            </span>
            <span className="cta-foot__copied">
              ✓ Copied - paste into your coding agent for the guided setup
            </span>
          </p>
        </div>
      </section>

      {/* ============= retro terminal: the mechanism ============= */}
      <RetroTerminal />

      {/* ============= demo: Mission Control window + floating wrapped-highlight popups ============= */}
      <section className="demo demo--popups">
        <div className="demo-intro">
          <span className="eyebrow">open the studio</span>
          <h2>
            Mission Control for your&nbsp;agents.
          </h2>
          <p>
            Run <code>ax serve</code> and the whole HUD lights up &mdash; archetype
            sigil, live activity, streaks, token spend by model. The wrapped
            highlights pop out as ax finds them.
          </p>
        </div>

        <div className="mc-stage" ref={mcStageRef}>
          <div
            className="browser browser--instrument"
            role="img"
            aria-label="ax studio Mission Control, dark instrument dashboard at 127.0.0.1:1738"
          >
            <div className="browser-bar">
              <div className="browser-dots">
                <span></span>
                <span></span>
                <span></span>
              </div>
              <div className="browser-url">127.0.0.1:1738</div>
              <div className="browser-spacer"></div>
            </div>

            <div className="mc-shell">
              <nav className="mc-rail" aria-hidden="true">
                <span className="mc-logo">ax</span>
                <span className="mc-railbtn on">◎</span>
                <span className="mc-railbtn">✦</span>
                <span className="mc-railbtn">▤</span>
                <span className="mc-railbtn">◳</span>
                <span className="mc-railbtn">⎈</span>
              </nav>

              <div className="mc-main">
                <McClock />

                <div className="mc-bento">
                  <section className="mc-card mc-hero span2 row2">
                    <div className="mc-meta mc-label">
                      <span>archetype &middot; primary</span>
                      <span>high confidence</span>
                    </div>
                    <div className="mc-sigil">
                      <McCells levels={MC_SIGIL} cols={11} cell={16} />
                    </div>
                    <div className="mc-hero-text">
                      <div className="mc-hero-name">The Cartographer</div>
                      <p className="mc-hero-tag">
                        Maps the whole repo before touching a line &mdash; reads
                        wide, edits once.
                      </p>
                    </div>
                  </section>

                  <section className="mc-card">
                    <div className="mc-label">sessions</div>
                    <div className="mc-metric mc-bottom">2,847</div>
                    <div className="mc-label">58.2K messages</div>
                  </section>

                  <section className="mc-card">
                    <div className="mc-label">tokens</div>
                    <div className="mc-metric mc-bottom">1.4B</div>
                    <div className="mc-label">+18% vs prior 90d</div>
                  </section>

                  <section className="mc-card span2">
                    <div className="mc-meta mc-label">
                      <span>activity &middot; daily</span>
                      <span className="mc-live">
                        <McLed />
                        live
                      </span>
                    </div>
                    <div className="mc-actwrap">
                      <McCells levels={MC_ACTIVITY} cols={30} cell={11} />
                    </div>
                    <div className="mc-meta mc-label">
                      <span>312 active days</span>
                      <span>21 weeks</span>
                    </div>
                  </section>

                  <section className="mc-card">
                    <div className="mc-label">streak</div>
                    <div className="mc-num mc-bottom">
                      23<small>d</small>
                    </div>
                    <McSeg total={41} on={23} color="var(--alert)" gradient />
                    <div className="mc-label">best 41 days</div>
                  </section>

                  <section className="mc-card">
                    <div className="mc-label">peak hour</div>
                    <div className="mc-metric mc-bottom">11 PM</div>
                    <div className="mc-label">most active</div>
                  </section>

                  <section className="mc-card span2 mc-split">
                    <div className="mc-meta mc-label">
                      <span>model split &middot; 365d</span>
                      <span>~$4.2K total</span>
                    </div>
                    <div className="mc-splitlist">
                      {MC_MODELS.map((m) => (
                        <div className="mc-split-row" key={m.name}>
                          <span className="mc-model">
                            <span className="mc-swatch" style={{ background: m.tone }} />
                            {m.name}
                          </span>
                          <span>
                            {m.pct}% &middot; {m.usd}
                          </span>
                          <span className="mc-segwrap">
                            <McSeg total={24} on={Math.max(1, Math.round((m.pct / 100) * 24))} color={m.tone} />
                          </span>
                        </div>
                      ))}
                    </div>
                  </section>
                </div>
              </div>
            </div>
          </div>

          {/* floating wrapped highlights - cycle through all 12 charts */}
          <div className="mc-pop-strip">
            {POP_SLOTS.map(({ off, place }) => {
              const c = POP_CHARTS[(popTick + off) % POP_CHARTS.length];
              return (
                <article key={place} className={`mc-pop ${place} ${c.accent} browser--instrument`}>
                  <span className="mc-pop-badge">wrapped</span>
                  <div key={c.key} className="mc-pop-swap">
                    <div className={`mc-pop-viz${POP_CENTERED.has(c.key) ? " mc-pop-viz--center" : ""}`}>
                      {c.viz}
                    </div>
                    <span className="mc-pop-q">$ {c.q}</span>
                    <h4 className="mc-pop-h">{c.h}</h4>
                  </div>
                </article>
              );
            })}
          </div>
        </div>

        <p className="demo-caption">
          Run <code>ax serve</code> to see yours &mdash; Mission Control, the
          Improve deck, Agent Wrapped, sessions and skill triage.
        </p>
      </section>
    </>
  );
}
