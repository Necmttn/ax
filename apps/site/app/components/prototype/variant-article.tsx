/* THROWAWAY - SURFACE: Article. Docs/prose in the new look, showing the
   article-FIGURE house style: receipt-framed telemetry (heatmap, lineage,
   glyph), captioned "FIG.NN" with a provenance stamp. */
import { CellGrid, GlyphReel, Led, Segbar } from "./viz";
import { ACTIVITY } from "./mock";
import type { Theme } from "./switcher";

export function VariantArticle({ theme }: { theme: Theme }) {
    const dim = theme === "dark" ? "#232823" : "#dad7cb";
    const lit = theme === "dark" ? "#eafff0" : "#173a22";
    return (
        <article className="v-art">
            <div className="v-art-crumb"><span className="accent">docs</span><span>/</span><span>concepts</span><span>/</span><span>the taste graph</span></div>
            <h1>Your agents have a taste. ax draws it.</h1>
            <div className="v-art-meta">
                <span className="live"><Led />living doc</span>
                <span>updated 2026-06-13</span>
                <span>6 min read</span>
            </div>

            <p>
                Every coding agent leaves a trail - which skills it reaches for, how it
                recovers from a failed test, where the tokens go. Most of that signal
                evaporates the moment the session ends. <code className="inl">ax</code> keeps
                it: it reads your local transcripts and assembles a graph of how you
                and your agents actually work.
            </p>

            <figure className="rdx-fig">
                <div className="rdx-fig-head">
                    <span className="rdx-fig-n">Fig.01 - activity</span>
                    <span className="rdx-fig-src"><Led />compiled from local transcripts</span>
                </div>
                <div className="rdx-fig-body"><CellGrid levels={ACTIVITY} cols={26} cell={15} gap={4} /></div>
                <figcaption className="rdx-fig-cap"><b>98 days of activity.</b> Cell brightness = daily tokens; the busiest days glow. The same heatmap renders on your profile and in <code className="inl">ax wrapped</code>.</figcaption>
            </figure>

            <p>
                The graph isn't just counts. ax mines the <em>order</em> of events -
                the recurring sequences that precede a good outcome. We call these
                workflow arcs, and they're the backbone of the lineage view.
            </p>

            <figure className="rdx-fig">
                <div className="rdx-fig-head">
                    <span className="rdx-fig-n">Fig.02 - workflow arc</span>
                    <span className="rdx-fig-src">×142 sessions</span>
                </div>
                <div className="rdx-fig-body">
                    <div className="rdx-fig-lineage">
                        <span className="rdx-fig-node">brainstorm</span><span className="rdx-fig-arrow">→</span>
                        <span className="rdx-fig-node">worktree</span><span className="rdx-fig-arrow">→</span>
                        <span className="rdx-fig-node hot">tdd</span><span className="rdx-fig-arrow">→</span>
                        <span className="rdx-fig-node">review</span><span className="rdx-fig-arrow">→</span>
                        <span className="rdx-fig-node">ship</span>
                    </div>
                </div>
                <figcaption className="rdx-fig-cap"><b>The recipe behind a merge.</b> Nodes are skills; the highlighted step is where verification catches the most regressions.</figcaption>
            </figure>

            <p className="v-art-pull">“The point isn't the dashboard. It's that your agents get measurably better because you can finally see what they do.”</p>

            <h2>A graph you can read at a glance</h2>
            <p>
                Because it's a graph, ax can rank: which skills carry their weight,
                which models earn their cost, which guardrails actually fire. The
                glyph below is ax's sigil - a live readout that breathes while the
                daemon ingests.
            </p>

            <figure className="rdx-fig">
                <div className="rdx-fig-head">
                    <span className="rdx-fig-n">Fig.03 - the sigil</span>
                    <span className="rdx-fig-src"><Led />live · ingesting</span>
                </div>
                <div className="rdx-fig-body" style={{ display: "grid", gridTemplateColumns: "130px 1fr", gap: 20, alignItems: "center" }}>
                    <div className="rdx-fig-glyph"><GlyphReel seed={3} dim={dim} lit={lit} /></div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        <Segbar total={28} on={20} tone="accent" wave />
                        <span className="rdx-stamp">ingest · 10.2 mb/s · 412 sessions</span>
                    </div>
                </div>
                <figcaption className="rdx-fig-cap"><b>The mark moves.</b> It morphs through ax's pattern set while the local graph updates - the same canvas reused as a loader, a profile crest, and this figure.</figcaption>
            </figure>
        </article>
    );
}
