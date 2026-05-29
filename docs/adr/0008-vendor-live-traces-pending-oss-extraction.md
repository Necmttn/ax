# Vendor live-traces into ax pending standalone open-source extraction

`axctl` will vendor the `live-traces` Effect tracer decorator + `TraceSink` + pluggable `TraceTransport` + Schema-validated `TraceEvent` discriminated union into `src/lib/live-traces/`. The pattern originated in another project's package and is reused by ax under ADR-0007 as the progress and telemetry substrate for the **Ingest Pipeline**.

Vendoring is intentional: a workspace link across separate repositories is fragile, and extracting to a published package now would block the ax refactor on landing-page, npm publish, license, README, and example work. The two-adapter test is met by ax + the originating project, but the OSS extraction is a separate body of work with its own scope.

The vendored copy stays self-contained: no `axctl`-specific imports leak into `src/lib/live-traces/`, and the public surface stays small and stable so extraction stays mechanical. When a third project needs the pattern, that is the signal to escalate from vendor to published package, at which point ax migrates from the vendored copy to the npm dependency.

Consequence: ax ships the refactor on its own timeline; the live-traces library has a clean extraction path; duplication cost is accepted as the price of decoupling delivery from packaging work.
