import { Link } from "@tanstack/react-router";

export function FooterCards() {
  return (
    <section className="cards">
      <div className="cards-grid">
        <Link className="card" to="/how-it-works">
          <span className="num">01</span>
          <span className="card-title">
            How it works <span className="arrow">&rarr;</span>
          </span>
        </Link>
        <Link className="card" to="/showcases">
          <span className="num">02</span>
          <span className="card-title">
            Showcases <span className="arrow">&rarr;</span>
          </span>
        </Link>
        <Link className="card" to="/features">
          <span className="num">03</span>
          <span className="card-title">
            Features <span className="arrow">&rarr;</span>
          </span>
        </Link>
        <Link className="card" to="/docs">
          <span className="num">04</span>
          <span className="card-title">
            Docs <span className="arrow">&rarr;</span>
          </span>
        </Link>
      </div>
    </section>
  );
}
