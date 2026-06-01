import { describe, expect, test } from "bun:test";
import { classifyFeedback, classifyUserAsk } from "./ask-outcome.ts";

describe("classifyUserAsk", () => {
    test("classifies requested examples", () => {
        expect(classifyUserAsk("i also wanna improve the visuals")).toBe("ui_improvement");
        expect(classifyUserAsk("did you test the query?")).toBe("verification_request");
        expect(classifyUserAsk("alright lets share a plan")).toBe("planning");
    });

    test("uses specific buckets before broad brainstorming", () => {
        expect(classifyUserAsk("can we fix the failing ingest test")).toBe("debug_fix");
        expect(classifyUserAsk("can you show me the most used skills")).toBe("query_request");
    });

    test("classifies verification prompts before broad debug words", () => {
        expect(classifyUserAsk("did you fix the bug?")).toBe("verification_request");
        expect(classifyUserAsk("can you verify the error handling?")).toBe("verification_request");
    });

    test("keeps investigative check requests in debug buckets", () => {
        expect(classifyUserAsk("can you check why the test is failing")).toBe("debug_fix");
        expect(classifyUserAsk("please check the failing ingest test")).toBe("debug_fix");
        expect(classifyUserAsk("can you check the query error")).toBe("debug_fix");
    });

    test("falls back to unknown for vague text", () => {
        expect(classifyUserAsk("alright")).toBe("unknown");
    });
});

describe("classifyFeedback", () => {
    test("classifies requested examples", () => {
        expect(classifyFeedback("no more like scenario where there is bug message in file")).toBe("correction");
        expect(classifyFeedback("can you please do")).toBe("friction");
        expect(classifyFeedback("why didn't you fix that")).toBe("friction");
        expect(classifyFeedback("yes")).toBe("approval");
        expect(classifyFeedback("i wonder can we do sentiment analysis")).toBe("exploration");
    });

    test("keeps weak acknowledgements neutral", () => {
        expect(classifyFeedback("alright")).toBe("neutral");
    });
});
