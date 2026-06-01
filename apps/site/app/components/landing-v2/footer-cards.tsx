export function FooterCards() {
  return (
    <section className="cards">
      <div className="cards-grid">
        <a className="card" href="/how-it-works">
          <span className="num">01</span>
          <span className="card-title">
            How it works <span className="arrow">&rarr;</span>
          </span>
        </a>
        <a className="card" href="/showcases">
          <span className="num">02</span>
          <span className="card-title">
            Showcases <span className="arrow">&rarr;</span>
          </span>
        </a>
        <a className="card" href="/features">
          <span className="num">03</span>
          <span className="card-title">
            Features <span className="arrow">&rarr;</span>
          </span>
        </a>
        <a className="card" href="/docs">
          <span className="num">04</span>
          <span className="card-title">
            Docs <span className="arrow">&rarr;</span>
          </span>
        </a>
      </div>
    </section>
  );
}
