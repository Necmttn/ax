import { formatClassifierList, listClassifiers } from "../classifiers/list.ts";

export async function cmdClassifiersList(args: readonly string[]): Promise<void> {
    const json = args.includes("--json");
    console.log(formatClassifierList(listClassifiers(), { json }));
}
