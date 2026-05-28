export function Chapter7CodingFirst() {
  return (
    <>
      <section className="section">
        <h2>Why coding first.</h2>

        <p>
          I am starting with coding agents on purpose, and not because this
          is the only place the loop applies. Coding is where the ground
          truth is already close to the work. Tests pass or they do not.
          The thing merged or got reverted. The user accepted the pull
          request or filed a bug. The repository already contains much of
          the truth.
        </p>

        <p>
          For a marketing agent you would have to plumb in analytics. For a
          sales agent you need CRM outcomes. For a research agent you need
          source quality and downstream use. Each domain has its own
          evidence. Coding already has the harness bolted on, so coding is
          where you build the reflection loop first, prove the shape, and
          carry it to messier domains after you trust it.
        </p>
      </section>
    </>
  );
}
