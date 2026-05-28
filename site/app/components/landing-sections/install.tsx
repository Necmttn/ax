export function InstallSection() {
  return (
    <section id="install">
      <p className="eyebrow">install</p>
      <h2>Install. Ingest. Serve.</h2>
      <pre>
        <code>
          <span className="prompt">$</span> curl -fsSL https://raw.githubusercontent.com/Necmttn/ax/main/install.sh | bash{"\n"}
          <span className="prompt">$</span> PATH=&quot;$HOME/.local/bin:$PATH&quot; axctl ingest --since=7{"\n"}
          <span className="prompt">$</span> axctl serve   <span className="comment"># live dashboard at http://127.0.0.1:8520</span>
        </code>
      </pre>
      <p className="install-label install-or">or via nix</p>
      <pre>
        <code>
          <span className="prompt">$</span> nix profile add github:Necmttn/ax{"\n"}
          <span className="prompt">$</span> axctl ingest --since=7{"\n"}
          <span className="prompt">$</span> axctl serve   <span className="comment"># live dashboard at http://127.0.0.1:8520</span>
        </code>
      </pre>
      <p className="install-meta">
        ephemeral run &middot; <code>nix run github:Necmttn/ax</code><br />
        devshell &middot; <code>nix develop github:Necmttn/ax</code>
      </p>
      <p>
        For dev setup, schema, and benchmarks, see{" "}
        <a href="/docs/development"><code>docs/development.md</code></a>.
      </p>
    </section>
  );
}
