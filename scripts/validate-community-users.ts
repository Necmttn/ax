/**
 * PR gate for community/users/<login>.json registrations (profiles spec
 * §3a). Strict by construction: exactly {github, gist_id, joined}, filename
 * == github == PR author (case-insensitive; filename lowercase), joined is
 * YYYY-MM-DD. Used by .github/workflows/community-users.yml; also runnable
 * locally: bun scripts/validate-community-users.ts --author=me community/users/me.json
 */

const ALLOWED_KEYS = new Set(["github", "gist_id", "joined"]);

export async function validateUserFile(path: string, author: string): Promise<string[]> {
    const errors: string[] = [];
    const fileName = path.split("/").pop() ?? "";
    const stem = fileName.replace(/\.json$/, "");

    let raw: unknown;
    try {
        raw = JSON.parse(await Bun.file(path).text());
    } catch (e) {
        return [`${fileName}: not valid JSON (${e instanceof Error ? e.message : String(e)})`];
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return [`${fileName}: must be a JSON object`];
    }
    const r = raw as Record<string, unknown>;

    for (const key of Object.keys(r)) {
        if (!ALLOWED_KEYS.has(key)) errors.push(`${fileName}: unknown field "${key}"`);
    }
    const github = typeof r.github === "string" ? r.github : "";
    if (github === "") errors.push(`${fileName}: "github" must be a non-empty string`);
    if (typeof r.gist_id !== "string" || r.gist_id === "" || !/^[a-f0-9]+$/i.test(r.gist_id)) {
        errors.push(`${fileName}: "gist_id" must be a hex gist id`);
    }
    if (typeof r.joined !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.joined)) {
        errors.push(`${fileName}: "joined" must be YYYY-MM-DD`);
    }
    if (github !== "" && stem !== github.toLowerCase()) {
        errors.push(`${fileName}: filename must be the lowercase github login ("${github.toLowerCase()}.json")`);
    }
    if (github !== "" && github.toLowerCase() !== author.toLowerCase()) {
        errors.push(`${fileName}: "github" (${github}) must match the PR author (${author})`);
    }
    return errors;
}

if (import.meta.main) {
    const args = process.argv.slice(2);
    const authorArg = args.find((a) => a.startsWith("--author="));
    const files = args.filter((a) => !a.startsWith("--"));
    if (!authorArg || files.length === 0) {
        console.error("usage: bun scripts/validate-community-users.ts --author=<login> <file>...");
        process.exit(2);
    }
    const author = authorArg.slice("--author=".length);
    let failed = false;
    for (const file of files) {
        const errors = await validateUserFile(file, author);
        for (const e of errors) {
            console.error(e);
            failed = true;
        }
    }
    if (failed) process.exit(1);
    console.log(`${files.length} registration file(s) valid for @${author}.`);
}
