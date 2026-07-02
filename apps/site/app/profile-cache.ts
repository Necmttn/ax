import { fetchProfile } from "@ax/lib/shared/community";

// The site has no query cache; this memo is what makes profile prefetch
// meaningful. Failed lookups are evicted so real navigation retries.
const cache = new Map<string, ReturnType<typeof fetchProfile>>();

export function cachedFetchProfile(login: string): ReturnType<typeof fetchProfile> {
    const key = login.toLowerCase();
    const existing = cache.get(key);
    if (existing) return existing;
    const p = fetchProfile(login);
    cache.set(key, p);
    p.catch(() => cache.delete(key));
    return p;
}

export function prefetchProfile(login: string): Promise<unknown> {
    return cachedFetchProfile(login).catch(() => undefined);
}
