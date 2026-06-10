import { describe, expect, test } from "bun:test";
import {
    EPISODE_PARENT_SQL,
    EPISODE_CHILDREN_SQL,
    EPISODE_PARENT_INVOCATIONS_SQL,
    EPISODE_CHILD_INVOCATIONS_SQL,
} from "./episode-timeline.ts";

const PARENT = "session:⟨019e0ad4-c977-7e36-a8b5-0a1b2c3d4e5f⟩";

describe("episode-timeline SQL builders", () => {
    test("parent select interpolates the validated record ref", () => {
        const sql = EPISODE_PARENT_SQL(PARENT);
        expect(sql).toContain(`FROM ${PARENT};`);
        expect(sql).toContain("started_at");
        expect(sql).toContain("ended_at");
    });

    test("children scan is bounded and ordered by spawn time", () => {
        const sql = EPISODE_CHILDREN_SQL(PARENT);
        expect(sql).toContain(`WHERE in = ${PARENT}`);
        expect(sql).toContain("ORDER BY out.started_at ASC");
        expect(sql).toContain("LIMIT 500");
    });

    test("parent invocations walk the in.session index and bound the scan", () => {
        const sql = EPISODE_PARENT_INVOCATIONS_SQL(PARENT);
        expect(sql).toContain(`WHERE in.session = ${PARENT}`);
        expect(sql).toContain("out.name IS NOT NONE");
        expect(sql).toContain("LIMIT 5000");
    });

    test("child invocations take a pre-materialised id array literal (no IN-subquery)", () => {
        const literal = `[${PARENT}]`;
        const sql = EPISODE_CHILD_INVOCATIONS_SQL(literal);
        expect(sql).toContain(`WHERE in.session IN ${literal}`);
        expect(sql).not.toContain("SELECT out FROM spawned"); // no subquery regression
        expect(sql).toContain("LIMIT 20000");
    });
});
