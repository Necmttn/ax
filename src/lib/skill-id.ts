import { legacySkillRecordKey as legacyKey, skillRecordKeyV2 } from "./ids.ts";

export function skillRecordKey(name: string): string {
    return skillRecordKeyV2(name);
}

export function legacySkillRecordKey(name: string): string {
    return legacyKey(name);
}

export function skillRecordLookupKeys(name: string): string[] {
    const modern = skillRecordKey(name);
    const legacy = legacySkillRecordKey(name);
    return modern === legacy ? [modern] : [modern, legacy];
}
