import type { ComponentProps, ReactNode } from "react";

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
};
