/* THROWAWAY - Variant B: Editorial Instrument. ax receipts evolved, light-first:
   serif headlines + dot-matrix numerals + segmented telemetry. */
import { CellGrid, GlyphReel, Led, Segbar } from "./viz";
import { ACTIVITY, CARDS, MODELS, PROFILE, litFor } from "./mock";
import type { Theme } from "./switcher";

const seedFrom = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

export function VariantEditorial({ theme }: { theme: Theme }) {
    const dim = theme === "dark" ? "#222222" : "#dad7cb";
    const lit = theme === "dark" ? "#ffffff" : "#1a1a1a";
    const vitals: Array<[string, string, string]> = [
        [String(PROFILE.sessions), "", "sessions"],
        [PROFILE.tokens, "", "tokens"],
        [PROFILE.cost.replace("$", "~$"), "", "est. spend"],
        [`${PROFILE.activeDays}/98`, "", "days active"],
        [String(PROFILE.streak), "d", "streak"],
    ];
    return (
        <div className="v-ed">
            <div className="v-ed-kicker">
                <span className="v-ed-live"><Led />live · pulled from gist</span>
                <span>{PROFILE.window.days}-day window · compiled {PROFILE.window.compiled}</span>
            </div>
            <h1 className="v-ed-name"><span className="at">@</span>{PROFILE.handle}</h1>
            <div className="v-ed-sub">
                <span className="v-ed-chips">{PROFILE.harnesses.map((h) => <span className="v-ed-chip" key={h}>{h}</span>)}</span>
                <span>compiled from local transcripts by ax</span>
            </div>

            <div className="v-ed-ledger">
                {vitals.map(([n, u, l]) => (
                    <div className="v-ed-vital" key={l}>
                        <span className="n">{n}{u ? <small> {u}</small> : null}</span>
                        <span className="l">{l}</span>
                    </div>
                ))}
            </div>

            <section className="v-ed-section">
                <div className="v-ed-h"><span className="n">01</span><h2>The window</h2><span className="rule" /><span className="note">last 98 days</span></div>
                <div className="v-ed-heat">
                    <CellGrid levels={ACTIVITY} cols={26} cell={16} gap={4} />
                    <div className="v-ed-heatmeta">
                        <span><b>{PROFILE.activeDays}</b></span>
                        <span>active days of 98</span>
                        <span style={{ marginTop: 8 }}>peak <b style={{ fontSize: 18 }}>{PROFILE.peakHour}</b></span>
                    </div>
                </div>
                <div style={{ marginTop: 22, display: "flex", flexDirection: "column", gap: 10, maxWidth: 520 }}>
                    {MODELS.slice(0, 4).map((m) => (
                        <div key={m.name} style={{ display: "grid", gridTemplateColumns: "180px 1fr 70px", gap: 12, alignItems: "center", fontFamily: "var(--mono)", fontSize: 12, color: "var(--sec)" }}>
                            <span style={{ color: "var(--pri)" }}>{m.name}</span>
                            <Segbar total={28} on={litFor(m.share, 28)} tone={m.tone === "green" ? "green" : "pri"} />
                            <span style={{ textAlign: "right" }}>{Math.round(m.share * 100)}%</span>
                        </div>
                    ))}
                </div>
            </section>

            <section className="v-ed-section">
                <div className="v-ed-h"><span className="n">02</span><h2>The shape of the work</h2><span className="rule" /><span className="note">derived</span></div>
                <div className="v-ed-cards">
                    {CARDS.map((c, i) => (
                        <article className="v-ed-card" key={c.q}>
                            <div className="v-ed-card-art">{i === 0 ? <GlyphReel seed={seedFrom(c.q)} dim={dim} lit={lit} /> : null}</div>
                            <div className="v-ed-card-body">
                                <span className="v-ed-card-q">$ {c.q}</span>
                                <span className="v-ed-card-a">{c.a}</span>
                                <span className="v-ed-card-s">{c.s}</span>
                            </div>
                        </article>
                    ))}
                </div>
            </section>
        </div>
    );
}
