/**
 * Group an ordered id list into fixed-size chunks - shared by every derive
 * stage that fetches a bounded session-id list up front, then processes one
 * batch of sessions' rows at a time so the whole corpus never sits in the Bun
 * VM heap at once (#1021, #917: a full-corpus `--reparse=claude` run
 * segfaulted at ~14 GB RSS). `derive-signals.ts` predates this module and
 * keeps its own local copy deliberately untouched; every stage chunked after
 * it imports this one instead of re-declaring the same four-line loop.
 */
export const chunkIds = <A>(items: ReadonlyArray<A>, size: number): A[][] => {
    const out: A[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
};
