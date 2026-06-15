// ACT 2 - GRAPH. One designed figure of the graph model: session / turn /
// tool_call / skill / file nodes joined by typed edges. Drawn as a real SVG
// diagram, not code-span soup. The canonical caption line
// (skill <- invoked <- turn -> edited -> file) is the legend.

export function ActGraph() {
  return (
    <section className="how-act how-act--graph">
      <div className="how-act-inner">
        <header className="how-act-head">
          <p className="how-eyebrow">$ 02 · graph</p>
          <h2 className="how-headline">
            Not a vector index. A graph of what actually happened.
          </h2>
          <p className="how-dek">
            Every run becomes nodes and typed edges. The interesting questions
            are relational &mdash; which tool call preceded that correction,
            which skill fires in the sessions that ship &mdash; so the edges
            are the load-bearing primitive, queryable as first-class facts.
          </p>
        </header>

        <figure className="how-graph-fig">
          <svg
            className="how-graph-svg"
            viewBox="0 0 900 440"
            role="img"
            aria-label="ax graph model: a session contains turns, a turn invokes a skill, produces a tool_call, edits a file, and a session produces a commit that touches files"
          >
            <defs>
              <marker
                id="howArrow"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M0 0 L10 5 L0 10 z" fill="var(--muted)" />
              </marker>
            </defs>

            {/* edges (drawn first, under the nodes) */}
            <g className="how-graph-edges" fill="none" stroke="var(--muted)" strokeWidth="1.4">
              {/* session -> turn (contains) */}
              <path d="M205 96 C300 96 300 150 360 150" markerEnd="url(#howArrow)" />
              {/* turn -> skill (invoked) - drawn right-to-left to read "invoked" */}
              <path d="M520 132 C600 110 640 80 700 72" markerEnd="url(#howArrow)" />
              {/* turn -> tool_call (produced) */}
              <path d="M520 168 C600 200 620 240 700 250" markerEnd="url(#howArrow)" />
              {/* turn -> file (edited) */}
              <path d="M460 210 C460 290 540 320 612 332" markerEnd="url(#howArrow)" />
              {/* session -> commit (produced) */}
              <path d="M150 132 C150 250 200 330 280 348" markerEnd="url(#howArrow)" />
              {/* commit -> file (touched) */}
              <path d="M420 360 C500 360 540 348 600 344" markerEnd="url(#howArrow)" />
            </g>

            {/* edge labels */}
            <g className="how-graph-edge-labels" fontFamily="var(--mono)" fontSize="11">
              <text x="285" y="108" textAnchor="middle">contains</text>
              <text x="612" y="86" textAnchor="middle">invoked</text>
              <text x="624" y="214" textAnchor="middle">produced</text>
              <text x="486" y="276" textAnchor="middle">edited</text>
              <text x="120" y="252" textAnchor="middle">produced</text>
              <text x="508" y="338" textAnchor="middle">touched</text>
            </g>

            {/* nodes */}
            <g className="how-graph-nodes">
              {/* session */}
              <g className="how-node how-node--session">
                <rect x="40" y="68" width="160" height="58" rx="6" />
                <text className="how-node-kind" x="120" y="92" textAnchor="middle">session</text>
                <text className="how-node-val" x="120" y="111" textAnchor="middle">run · model · repo</text>
              </g>

              {/* turn */}
              <g className="how-node how-node--turn">
                <rect x="360" y="124" width="160" height="58" rx="6" />
                <text className="how-node-kind" x="440" y="148" textAnchor="middle">turn</text>
                <text className="how-node-val" x="440" y="167" textAnchor="middle">role · intent · text</text>
              </g>

              {/* skill */}
              <g className="how-node how-node--skill">
                <rect x="700" y="44" width="160" height="58" rx="6" />
                <text className="how-node-kind" x="780" y="68" textAnchor="middle">skill</text>
                <text className="how-node-val" x="780" y="87" textAnchor="middle">standing instruction</text>
              </g>

              {/* tool_call */}
              <g className="how-node how-node--tool">
                <rect x="700" y="222" width="160" height="58" rx="6" />
                <text className="how-node-kind" x="780" y="246" textAnchor="middle">tool_call</text>
                <text className="how-node-val" x="780" y="265" textAnchor="middle">args · result · ms</text>
              </g>

              {/* file */}
              <g className="how-node how-node--file">
                <rect x="612" y="316" width="160" height="56" rx="6" />
                <text className="how-node-kind" x="692" y="340" textAnchor="middle">file</text>
                <text className="how-node-val" x="692" y="358" textAnchor="middle">path in your repo</text>
              </g>

              {/* commit */}
              <g className="how-node how-node--commit">
                <rect x="260" y="332" width="160" height="56" rx="6" />
                <text className="how-node-kind" x="340" y="356" textAnchor="middle">commit</text>
                <text className="how-node-val" x="340" y="374" textAnchor="middle">sha · message</text>
              </g>
            </g>
          </svg>

          <figcaption className="how-graph-cap">
            <code>skill &larr; invoked &larr; turn &rarr; edited &rarr; file</code>
            <span className="how-graph-cap-note">
              The line at the top of the schema. That is the model &mdash;
              a <code>RELATE</code> edge between a session and a commit is a
              queryable fact, not a join across two tables.
            </span>
          </figcaption>
        </figure>
      </div>
    </section>
  );
}
