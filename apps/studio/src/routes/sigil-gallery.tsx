/** Hidden design-iteration page: every archetype sigil at once, in a real hero
 *  card, so the dot-matrix icons can be eyeballed and tuned side by side. Linked
 *  only from /lab (no nav tab). Dark/light toggle since the design system ships
 *  both. Source of truth: the canonical dictionary (@ax/lib/shared/archetypes). */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ARCHETYPES } from "@ax/lib/shared/archetypes";
import { ArchetypeReel } from "../instrument/archetype-reel.tsx";
import "../instrument/instrument.css";

export function SigilGalleryRoute() {
    const [theme, setTheme] = useState<"dark" | "light">("dark");
    return (
        <div className="rdx" data-theme={theme} style={{ minHeight: "100vh", background: "var(--bg)", padding: 24 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 18, gap: 12, flexWrap: "wrap" }}>
                <div>
                    <div className="v-mc-hero-name" style={{ fontSize: 22 }}>Archetype sigils</div>
                    <div className="rdx-label">design iteration · {ARCHETYPES.length} archetypes · hidden lab page</div>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <button
                        type="button"
                        className="rdx-label"
                        onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
                        style={{ cursor: "pointer", background: "transparent", border: "1px solid var(--border)", borderRadius: 8, padding: "7px 12px", color: "var(--pri)" }}
                    >
                        theme · {theme} ▸
                    </button>
                    <Link to="/lab" className="rdx-label" style={{ textDecoration: "none", border: "1px solid var(--border)", borderRadius: 8, padding: "7px 12px", color: "var(--sec)" }}>
                        ← lab
                    </Link>
                </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 16 }}>
                {ARCHETYPES.map((a) => (
                    <section key={a.id} className="rdx-card v-mc-hero" style={{ minHeight: 360 }}>
                        <ArchetypeReel archetypeId={a.id} symbol={a.symbol} />
                        <div className="v-mc-meta rdx-label v-mc-hero-over"><span className="nf-key">{a.slug}</span><span>{a.symbol}</span></div>
                        <div className="v-mc-hero-text">
                            <div className="v-mc-hero-name">{a.name}</div>
                            <p style={{ margin: "6px 0 0", fontSize: 13.5, lineHeight: 1.5, color: "var(--sec)", maxWidth: "46ch" }}>{a.tagline}</p>
                            <p className="arc-humor">{a.humor}</p>
                        </div>
                    </section>
                ))}
            </div>
        </div>
    );
}
