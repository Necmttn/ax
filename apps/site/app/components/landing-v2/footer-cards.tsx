import { Link } from "@tanstack/react-router";

export function FooterCards() {
  return (
    <section className="cards">
      <div className="cards-grid">
        <Link className="card" to="/" hash="install">
          <span className="num">01</span>
          <span className="card-title">
            Install ax <span className="arrow">&rarr;</span>
          </span>
        </Link>
        <Link className="card" to="/routing">
          <span className="num">02</span>
          <span className="card-title">
            Routing <span className="arrow">&rarr;</span>
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
