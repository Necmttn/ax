/**
 * Typed brand-specimen data for /brand.
 *
 * Curated, hand-authored mirror of the ax visual identity. The route renders
 * these as live specimens (typeset wordmark, real color swatches, animated
 * live-pulse, serif/mono scale) rather than prose - the page demonstrates the
 * rules it documents.
 *
 * Audience split (deliberate): this module + the /brand page are PUBLIC brand
 * material - voice, wordmark, palette, typography, motifs, the voice contract.
 * Contributor mechanics (commit-message rules, project-name scrubbing, repo
 * paths) live in CONTRIBUTING.md, not here.
 *
 * Hex values are mirrored from the live tokens in apps/site/app/styles/globals.css
 * (:root). Keep them in sync if the tokens move.
 *
 * Always "ax" in visitor-facing copy, never "axctl".
 */

/** One palette token rendered as a real swatch (swatch + name + hex + role). */
export interface BrandSwatch {
  /** CSS custom property name, e.g. "--ink". */
  readonly token: string;
  /** Live hex value mirrored from :root. */
  readonly hex: string;
  /** What this color carries. Color only when it means something. */
  readonly role: string;
  /** True for ink/page/panel/line - the monochrome ground. */
  readonly mono?: boolean;
}

/** The ink-on-paper ground + the four information colors. */
export const BRAND_SWATCHES: readonly BrandSwatch[] = [
  { token: "--ink", hex: "#0a0a0a", role: "Primary text, the wordmark, 2px masthead rules.", mono: true },
  { token: "--page", hex: "#f6f5f0", role: "The paper. Every page sits on it.", mono: true },
  { token: "--panel", hex: "#fbfaf5", role: "Card and panel ground, a half-shade off the page.", mono: true },
  { token: "--line", hex: "#d8d6cf", role: "Hairline borders. Hierarchy comes from rules, never shadows.", mono: true },
  { token: "--muted", hex: "#6b6b66", role: "Secondary text, eyebrows, captions, table meta.", mono: true },
  { token: "--green", hex: "#2f9e44", role: "The live pulse, success, the primary accent.  Use the pulse once per surface." },
  { token: "--blue", hex: "#2567a8", role: "References and links. Flag names in the CLI reference." },
  { token: "--red", hex: "#c0392b", role: "Failure, regressions, offline state." },
  { token: "--amber", hex: "#b07900", role: "Review buckets and watch-list items that need a look." },
];

/** One row of the serif headline scale, rendered live at its real size. */
export interface SerifSpecimen {
  /** Display label for the row. */
  readonly label: string;
  /** Inline font-size used to render the live specimen. */
  readonly px: number;
  /** Where this size appears in the product. */
  readonly use: string;
  /** The string to typeset. */
  readonly sample: string;
}

export const SERIF_SCALE: readonly SerifSpecimen[] = [
  { label: "Wordmark", px: 36, use: "Masthead. Georgia, -1px tracking.", sample: "ax" },
  { label: "Hero headline", px: 34, use: "Page h1 across docs and marketing.", sample: "Receipts over vibes." },
  { label: "Section title", px: 28, use: "Group headings (h2).", sample: "See where the money goes" },
  { label: "Card title", px: 20, use: "Sub-section headings (h3).", sample: "The experiment loop" },
];

/** A mono $-eyebrow specimen, rendered exactly as it leads a section. */
export const EYEBROW_SAMPLES: readonly string[] = [
  "$ mine your history",
  "$ see where the money goes",
  "$ review proposals",
  "$ guard the harness",
];

/** A voice rule from the contract - kept verbatim from docs/brand.md. */
export interface VoiceRule {
  readonly label: string;
  readonly rule: string;
}

/**
 * The voice contract, verbatim from the prior brand doc. This is good and
 * survives the rebuild unchanged.
 */
export const VOICE_RULES: readonly VoiceRule[] = [
  { label: "Pronoun", rule: "Second person (\"your agent\", \"you\"). Never first-person plural (\"we\")." },
  { label: "Case", rule: "Lowercase headings where they fit (e.g. ax retro, ax doctor). Sentence case prose." },
  { label: "Tone", rule: "Terse, evidence-first, no startup voice. State facts, then move on." },
  { label: "Forbidden words", rule: "\"magical\", \"delight\", \"revolutionary\", \"powered by AI\", \"unlock\"." },
  { label: "Hedge sparingly", rule: "Say what's true. Mark what's roadmap with \"tracked next\"." },
];

/** A do / instead-of voice example. No emoji - the rule forbids them. */
export interface VoiceExample {
  /** The on-brand line. */
  readonly say: string;
  /** The off-brand line it replaces. */
  readonly instead: string;
}

export const VOICE_EXAMPLES: readonly VoiceExample[] = [
  {
    say: "ax answers these by reading what already happened.",
    instead: "ax magically uncovers hidden patterns in your agent history.",
  },
  {
    say: "Skill triage - which of your installed skills get used, which never fire.",
    instead: "Get powerful insights into your skill usage.",
  },
];

/** A typography stack and where it is used. */
export interface TypeStack {
  readonly stack: string;
  readonly cssVar: string;
  readonly use: string;
}

export const TYPE_STACKS: readonly TypeStack[] = [
  { stack: "Georgia, serif", cssVar: "--serif", use: "Wordmark, headlines, section titles." },
  { stack: "ui-monospace, Menlo", cssVar: "--mono", use: "$-eyebrows, receipts, flags, table meta, the brand tag." },
  { stack: "system-ui sans", cssVar: "--sans", use: "Prose and body copy." },
];

/** A naming-canon entry: how a verb is spoken vs. shipped. */
export interface NamingEntry {
  /** The command as a visitor speaks it. */
  readonly command: string;
  /** What it does. */
  readonly desc: string;
  /** "shipped" renders normally; "roadmap" gets a tracked-next tag. */
  readonly status: "shipped" | "roadmap";
}

/**
 * The naming canon. Visitor copy is always "ax <verb>". Roadmap entries are
 * marked, never presented as if they ship today.
 */
export const NAMING_CANON: readonly NamingEntry[] = [
  { command: "ax doctor", desc: "System check.", status: "shipped" },
  { command: "ax retro", desc: "Session retrospective.", status: "shipped" },
  { command: "ax wrapped", desc: "Annual recap cards.", status: "shipped" },
  { command: "ax serve", desc: "The dashboard daemon (ax studio lives at /studio).", status: "shipped" },
  { command: "ax improve", desc: "Rank proposals, accept them, track verdicts.", status: "shipped" },
  { command: "ax routing", desc: "Mine dispatch history, route mechanical work to cheaper models.", status: "shipped" },
];

/** A brand motif documented as a live specimen. */
export interface Motif {
  readonly title: string;
  readonly body: string;
}

export const MOTIFS: readonly Motif[] = [
  {
    title: "Receipts, not vibes",
    body:
      "ax makes claims with real numbers - $605 redirectable, 26x recurring, +3/+10/+30 sessions measured. Every figure is something the graph actually computed. The home page and /origin are the canonical executions: proposal cards and a measured-bets strip, not marketing adjectives.",
  },
  {
    title: "Real numbers as proof",
    body:
      "Receipts use actual CLI output - real timestamps, real session ids, real token counts. The proof is the data, not the framing. Never fake a figure to make a point land.",
  },
  {
    title: "Ink on paper",
    body:
      "Monochrome by default. Color only when it carries information: green for live and success, blue for references, red for failure, amber for review. A surface that's all color is a surface where nothing means anything.",
  },
  {
    title: "Hairline rules",
    body:
      "1px lines separate sections. A 2px ink rule caps the masthead and group heads. Hierarchy comes from rules and type, never from drop shadows.",
  },
  {
    title: "The live pulse",
    body:
      "A single green dot on a 1.6s ease-in-out opacity loop signals freshness. One per surface - duplicate it and it stops meaning \"live\".",
  },
];
