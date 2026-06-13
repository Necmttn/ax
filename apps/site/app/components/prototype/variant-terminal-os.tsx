/* THROWAWAY - Variant C: Terminal OS. Windowed desktop shell, menubar +
   command palette + monospace panes. Leans hardest into "desktop application". */
import { CellGrid, Led, Segbar } from "./viz";
import { ACTIVITY, FEED, MODELS, PROFILE, SKILLS, litFor } from "./mock";

export function VariantTerminalOS() {
    return (
        <div className="v-os">
            <div className="v-os-menubar">
                <span className="logo">ax</span>
                <span className="item">File</span><span className="item">View</span><span className="item">Graph</span><span className="item">Tools</span>
                <span className="spacer" />
                <span className="pal">⌘K  search the graph</span>
                <span className="live"><Led />live</span>
                <span>11:50</span>
            </div>

            <div className="v-os-desk">
                {/* main window: a sessions transcript / terminal */}
                <div className="v-os-win tall">
                    <div className="v-os-titlebar">
                        <span className="v-os-dots"><i /><i /><i /></span>
                        <span className="v-os-title">~/projects/ax · ax serve</span>
                    </div>
                    <div className="v-os-tabbar">
                        <span className="tab on">wrapped</span><span className="tab">sessions</span><span className="tab">skills</span><span className="tab">improve</span>
                    </div>
                    <div className="v-os-body">
                        <div className="v-os-prompt">
                            <div><span className="pfx">necmttn@ax</span> ~ ax profile show</div>
                            <div className="out">  archetype   <span style={{ color: "var(--pri)" }}>Night-Owl Builder</span> · high confidence</div>
                            <div className="out">  sessions    <span style={{ color: "var(--pri)" }}>{PROFILE.sessions}</span> · {PROFILE.messages.toLocaleString()} messages</div>
                            <div className="out">  tokens      <span style={{ color: "var(--pri)" }}>{PROFILE.tokens}</span> · {PROFILE.cost}</div>
                            <div className="out">  streak      <span style={{ color: "var(--pri)" }}>{PROFILE.streak}d</span> · best {PROFILE.longest}d</div>
                        </div>
                        <div style={{ margin: "16px 0 6px" }} className="rdx-label">activity · 98d</div>
                        <CellGrid levels={ACTIVITY} cols={26} cell={13} />
                        <div style={{ marginTop: 18 }} className="v-os-prompt">
                            <div><span className="pfx">necmttn@ax</span> ~ ax watch <span style={{ color: "var(--accent)" }}>●</span></div>
                            {FEED.slice(0, 3).map((f) => (
                                <div className="out" key={f.t}>  {f.t}  <span style={{ color: f.kind === "feat" ? "var(--green)" : f.kind === "fix" ? "var(--accent)" : "var(--pri)" }}>{f.msg}</span></div>
                            ))}
                        </div>
                    </div>
                </div>

                {/* side window: vitals */}
                <div className="v-os-win">
                    <div className="v-os-titlebar"><span className="v-os-dots"><i /><i /><i /></span><span className="v-os-title">vitals.json</span></div>
                    <div className="v-os-body">
                        <div className="v-os-kv">
                            <span className="k">sessions</span><span className="v rdx-doto">{PROFILE.sessions}</span>
                            <span className="k">tokens</span><span className="v">{PROFILE.tokens}</span>
                            <span className="k">spend</span><span className="v">{PROFILE.cost}</span>
                            <span className="k">streak</span><span className="v rdx-doto">{PROFILE.streak}d</span>
                            <span className="k">peak</span><span className="v">{PROFILE.peakHour}</span>
                            <span className="k">top model</span><span className="v">{PROFILE.topModel}</span>
                        </div>
                    </div>
                </div>

                {/* side window: model split */}
                <div className="v-os-win">
                    <div className="v-os-titlebar"><span className="v-os-dots"><i /><i /><i /></span><span className="v-os-title">model-split</span></div>
                    <div className="v-os-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                        {MODELS.slice(0, 4).map((m) => (
                            <div key={m.name}>
                                <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "var(--mono)", fontSize: 12, color: "var(--sec)", marginBottom: 5 }}>
                                    <span style={{ color: "var(--pri)" }}>{m.name}</span><span>{Math.round(m.share * 100)}% · {m.cost}</span>
                                </div>
                                <Segbar total={22} on={litFor(m.share, 22)} tone={m.tone === "green" ? "green" : "pri"} />
                            </div>
                        ))}
                    </div>
                </div>

                {/* side window: skills */}
                <div className="v-os-win">
                    <div className="v-os-titlebar"><span className="v-os-dots"><i /><i /><i /></span><span className="v-os-title">skills · weighted</span></div>
                    <div className="v-os-body">
                        <div style={{ display: "flex", flexDirection: "column", gap: 8, fontFamily: "var(--mono)", fontSize: 12.5 }}>
                            {SKILLS.map((s) => (
                                <div key={s.name} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                                    <span style={{ color: "var(--pri)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</span>
                                    <span style={{ color: "var(--dim)", flex: "none" }}>×{s.runs}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </div>

            <div className="v-os-statline">
                <span>● ax serve :1738</span><span>graph: 412 sessions</span><span>ingest 10.2 MB/s</span><span style={{ marginLeft: "auto" }}>v0.29.0</span>
            </div>
        </div>
    );
}
