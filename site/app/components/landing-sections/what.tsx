export function WhatSection() {
  return (
    <section id="what">
      <p className="eyebrow">what ax does.</p>
      <h2>It reflects. Then it earns the change.</h2>
      <p>
        Every sub-agent you spawn finishes its work and disappears.
        Whatever it figured out - which command failed three times before
        the right one, which file actually mattered, which approach to
        skip - dies with it. <code>ax</code> closes the loop before the
        session ends, and proves whether the fix earned its place.
      </p>
      <ul className="principles">
        <li>
          <strong>retros</strong>
          <p>Every session ends with a structured note - tried, worked, failed, next. Main sessions and sub-agents alike. JSON by default.</p>
        </li>
        <li>
          <strong>experiments</strong>
          <p>Accepted proposals become artifacts you can point at. Each one gets a +3 / +10 / +30 session checkpoint.</p>
        </li>
        <li>
          <strong>evidence</strong>
          <p>Verdicts come from retros, tool calls, corrections, and local git outcomes - joined in one graph. No vibes.</p>
        </li>
      </ul>
    </section>
  );
}
