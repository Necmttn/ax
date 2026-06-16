import { Children, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";

// ============================================================================
// MDX article component kit
//
// Origin-grade editorial components for the ax blog. Every `.md`/`.mdx` post
// rendered through `<MDXContent components={mdxComponents} />` can drop these
// in by their capitalized tag name - no import needed in the markdown.
//
// Design language is lifted from the /origin essay (app/routes/origin.tsx +
// app/components/origin-sections/*): numbered exhibit chrome, hairline rules,
// mono captions, serif pull quotes, the green "signal reinjected" callout.
// All styling lives under the `.blog-essay` scope in globals.css and is
// token-driven (no hardcoded hex). Components are pure render - SSR/prerender
// safe, no client-only APIs at module scope.
// ============================================================================

// --- Figure / Exhibit -------------------------------------------------------
// A bordered, numbered figure: a mono `.fig-id` chip + right-aligned label on a
// hairline-ruled head, arbitrary children (a code receipt, a table, a diagram),
// and a mono caption with an optional bold lead-in (origin's figcaption shape).
type FigureProps = {
  /** left chip, e.g. "Exhibit 1" or "Receipt 03" */
  id?: string;
  /** right-aligned mono meta, e.g. "ax cost split · 30 days" */
  label?: string;
  /** bold lead sentence on the caption (origin's <strong> opener) */
  lead?: ReactNode;
  /** muted caption continuation */
  caption?: ReactNode;
  children?: ReactNode;
};

export function Figure({ id, label, lead, caption, children }: FigureProps) {
  const hasHead = Boolean(id || label);
  const hasCap = Boolean(lead || caption);
  return (
    <figure className="bk-figure">
      {hasHead ? (
        <div className="bk-fig-head">
          <span className="bk-fig-id">{id}</span>
          {label ? <span className="bk-fig-label">{label}</span> : null}
        </div>
      ) : null}
      <div className="bk-fig-body">{children}</div>
      {hasCap ? (
        <figcaption className="bk-fig-cap">
          {lead ? <strong>{lead}</strong> : null}
          {lead && caption ? " " : null}
          {caption}
        </figcaption>
      ) : null}
    </figure>
  );
}

// `<Exhibit>` reads better for built diagrams; same component.
export const Exhibit = Figure;

// --- Callout ----------------------------------------------------------------
// The green reinject-style highlight box. tone="good" = green rule (a result,
// a "this is the point" line); tone="note" = blue rule (an aside / caveat).
type CalloutProps = {
  tone?: "good" | "note";
  /** optional mono eyebrow above the body */
  title?: ReactNode;
  children?: ReactNode;
};

export function Callout({ tone = "note", title, children }: CalloutProps) {
  return (
    <aside className={`bk-callout bk-callout--${tone}`}>
      {title ? <p className="bk-callout-title">{title}</p> : null}
      <div className="bk-callout-body">{children}</div>
    </aside>
  );
}

// --- StatGrid / Stat --------------------------------------------------------
// A numbered/labeled stat row, like origin's exhibit grids: a big serif numeral
// over a mono label, hairline-separated. Use for the three-leak math etc.
type StatGridProps = {
  /** mono eyebrow above the grid */
  label?: ReactNode;
  children?: ReactNode;
};

export function StatGrid({ label, children }: StatGridProps) {
  return (
    <div className="bk-statgrid">
      {label ? <span className="bk-statgrid-label">{label}</span> : null}
      <div className="bk-stats">{children}</div>
    </div>
  );
}

type StatProps = {
  /** the big numeral / headline figure, e.g. "$605.02" */
  value: ReactNode;
  /** mono label under the figure */
  label: ReactNode;
  /** optional muted sub-note */
  sub?: ReactNode;
};

export function Stat({ value, label, sub }: StatProps) {
  return (
    <div className="bk-stat">
      <span className="bk-stat-value">{value}</span>
      <span className="bk-stat-label">{label}</span>
      {sub ? <span className="bk-stat-sub">{sub}</span> : null}
    </div>
  );
}

// --- PullQuote --------------------------------------------------------------
// Large serif pull quote for punchy lines.
type PullQuoteProps = {
  children?: ReactNode;
  cite?: ReactNode;
};

export function PullQuote({ children, cite }: PullQuoteProps) {
  return (
    <blockquote className="bk-pull">
      <p>{children}</p>
      {cite ? <cite>{cite}</cite> : null}
    </blockquote>
  );
}

// --- FrameworkList ----------------------------------------------------------
// A mono two-column definition list (term + note), origin's framework-list.
type FrameworkListProps = {
  label?: ReactNode;
  children?: ReactNode;
};

export function FrameworkList({ label, children }: FrameworkListProps) {
  return (
    <div className="bk-framework">
      {label ? <span className="bk-framework-label">{label}</span> : null}
      <ul>{children}</ul>
    </div>
  );
}

export function FrameworkItem({ name, children }: { name: ReactNode; children?: ReactNode }) {
  return (
    <li>
      <span className="bk-fw-name">{name}</span>
      <span className="bk-fw-note">{children}</span>
    </li>
  );
}

// --- KBD --------------------------------------------------------------------
// Inline keycap. Markdown <kbd> also works; this is the JSX-friendly handle.
export function KBD({ children }: { children?: ReactNode }) {
  return <kbd className="bk-kbd">{children}</kbd>;
}

// --- SplitBar / SplitSeg ----------------------------------------------------
// One horizontal stacked bar that makes a proportional split obvious at a
// glance: the dominant segment is the ink mass, minor ones are tinted slivers.
// origin's bar-chart language - token-driven fills, mono legend, hairline rule.
// Composable like StatGrid/Stat: <SplitSeg> is a pure data carrier the parent
// reads via Children, so it renders the bar AND the legend deterministically.
type SplitTone = "ink" | "green" | "muted";

type SplitSegProps = {
  /** legend label, e.g. "main agent" */
  label: ReactNode;
  /** preformatted amount, e.g. "$21,015.22" (kept exact, not computed) */
  amount: ReactNode;
  /** share, doubles as the bar segment width, e.g. "84.0%" */
  pct: string;
  tone?: SplitTone;
};

// Marker component - never renders on its own; SplitBar reads its props.
export function SplitSeg(_props: SplitSegProps) {
  return null;
}

type SplitBarProps = {
  /** preformatted grand total for the legend total row, e.g. "$25,027.00" */
  total?: ReactNode;
  /** label for the total row (default "total") */
  totalLabel?: ReactNode;
  children?: ReactNode;
};

export function SplitBar({ total, totalLabel = "total", children }: SplitBarProps) {
  const segs = Children.toArray(children).filter(isValidElement) as ReactElement<SplitSegProps>[];
  return (
    <div className="bk-split">
      <div className="bk-split-bar" role="img" aria-label="proportional cost split">
        {segs.map((s, i) => (
          <span
            key={i}
            className={`bk-split-seg bk-tone-${s.props.tone ?? "ink"}`}
            style={{ width: s.props.pct }}
          >
            <span className="bk-split-seg-in">{s.props.pct}</span>
          </span>
        ))}
      </div>
      <div className="bk-split-legend">
        {segs.map((s, i) => (
          <div key={i} className="bk-split-leg">
            <span className={`bk-split-dot bk-tone-${s.props.tone ?? "ink"}`} aria-hidden />
            <span className="bk-split-leg-label">{s.props.label}</span>
            <span className="bk-split-leg-amt">{s.props.amount}</span>
            <span className="bk-split-leg-pct">{s.props.pct}</span>
          </div>
        ))}
        {total ? (
          <div className="bk-split-leg bk-split-leg-total">
            <span className="bk-split-dot bk-split-dot-empty" aria-hidden />
            <span className="bk-split-leg-label">{totalLabel}</span>
            <span className="bk-split-leg-amt">{total}</span>
            <span className="bk-split-leg-pct">100.0%</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// --- BarChart / Bar ---------------------------------------------------------
// Horizontal bar chart: one row per item, bar fill proportional to `value`.
// The peak (most expensive) bar gets a hot tone (origin's red peak); the rest
// are ink. Widths are computed in JS from value/max - fully deterministic, so
// SSR/prerender produce identical markup. <Bar> is a marker like <SplitSeg>.
type BarProps = {
  /** row label, rendered mono (e.g. a model name) */
  name: ReactNode;
  /** preformatted value, e.g. "$1,979.34" (kept exact) */
  amount: ReactNode;
  /** optional share, e.g. "7.9%" */
  pct?: ReactNode;
  /** numeric magnitude that drives bar width */
  value: number;
  /** muted sub-note under the bar, e.g. "247 sessions" */
  sub?: ReactNode;
  /** mark the hot/peak bar (the max); gets the warm tone */
  peak?: boolean;
};

export function Bar(_props: BarProps) {
  return null;
}

type BarChartProps = {
  /** mono eyebrow above the chart */
  label?: ReactNode;
  /** override the max used for proportional widths (default = largest value) */
  max?: number;
  children?: ReactNode;
};

export function BarChart({ label, max, children }: BarChartProps) {
  const bars = Children.toArray(children).filter(isValidElement) as ReactElement<BarProps>[];
  const peak = bars.reduce((m, b) => Math.max(m, b.props.value), 0);
  const denom = max ?? peak ?? 1;
  return (
    <div className="bk-barchart">
      {label ? <span className="bk-barchart-label">{label}</span> : null}
      {bars.map((b, i) => {
        const ratio = denom > 0 ? b.props.value / denom : 0;
        const width = `${Math.max(0, Math.min(100, ratio * 100)).toFixed(2)}%`;
        return (
          <div className="bk-bar-row" key={i}>
            <div className="bk-bar-head">
              <span className="bk-bar-name">{b.props.name}</span>
              <span className="bk-bar-amt">{b.props.amount}</span>
              {b.props.pct ? <span className="bk-bar-pct">{b.props.pct}</span> : null}
            </div>
            <div className="bk-bar-track">
              <span
                className={`bk-bar-fill${b.props.peak ? " bk-bar-fill-peak" : ""}`}
                style={{ width }}
              />
            </div>
            {b.props.sub ? <span className="bk-bar-sub">{b.props.sub}</span> : null}
          </div>
        );
      })}
    </div>
  );
}

// --- AxResult ---------------------------------------------------------------
// A colorized terminal receipt for `ax` command output. The author passes the
// raw output as a single string child:
//   <AxResult>{`$ ax cost split\n...`}</AxResult>
// Each line is tokenized with small, deterministic regexes so the money (the
// signal) reads green, percentages blue, drop/off-model markers red, model
// names a subtle tint, the `$ ...` prompt line dim. SSR-safe (pure string ops).

// One alternation, capture-group order = token class. Kept narrow on purpose
// (2-4 colors, scannability not a rainbow).
const AX_TOKEN =
  /(\$[\d,]+(?:\.\d{1,2})?)|(\d+(?:\.\d+)?%)|(claude-[a-z0-9.-]+|\b(?:sonnet|haiku|opus|fable)\b)|(\boff-model\b|\bdropped\b|!)/g;

function tokenizeAxLine(line: string, lineKey: number): ReactNode {
  // The command/prompt line reads dim - it's the input, not the result.
  if (/^\s*\$\s/.test(line)) {
    return <span className="bk-ax-cmd">{line}</span>;
  }
  // Comments (# ...) stay muted too.
  if (/^\s*#/.test(line)) {
    return <span className="bk-ax-cmd">{line}</span>;
  }
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  AX_TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = AX_TOKEN.exec(line)) !== null) {
    if (m.index > last) out.push(line.slice(last, m.index));
    const cls = m[1]
      ? "bk-ax-money"
      : m[2]
        ? "bk-ax-pct"
        : m[3]
          ? "bk-ax-model"
          : "bk-ax-warn";
    out.push(
      <span className={cls} key={`${lineKey}-${key++}`}>
        {m[0]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

export function AxResult({ children }: { children?: ReactNode }) {
  const raw = typeof children === "string" ? children : String(children ?? "");
  const text = raw.replace(/^\n+/, "").replace(/\s+$/, "");
  const lines = text.split("\n");
  return (
    <pre className="bk-axresult">
      <code>
        {lines.map((ln, i) => (
          <span className="bk-ax-line" key={i}>
            {tokenizeAxLine(ln, i)}
            {i < lines.length - 1 ? "\n" : null}
          </span>
        ))}
      </code>
    </pre>
  );
}

// ----------------------------------------------------------------------------
// Components map handed to <MDXContent>. The lowercase `a` keeps external links
// safe; the capitalized entries are the article kit. Prose typography itself is
// owned by the `.blog-essay` / `.prose` scopes in globals.css.
// ----------------------------------------------------------------------------
export const mdxComponents = {
  a: (props: ComponentProps<"a">) => {
    const external = typeof props.href === "string" && /^https?:/.test(props.href);
    return external ? (
      <a {...props} target="_blank" rel="noopener noreferrer" />
    ) : (
      <a {...props} />
    );
  },
  Figure,
  Exhibit,
  Callout,
  StatGrid,
  Stat,
  PullQuote,
  FrameworkList,
  FrameworkItem,
  KBD,
  SplitBar,
  SplitSeg,
  BarChart,
  Bar,
  AxResult,
};
