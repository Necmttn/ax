/**
 * Compatibility seam for the CLI's historical `session-show` imports.
 * The richer read shape now lives in Session View.
 */

export {
    fetchSessionView as fetchSessionShow,
    groupSessionSkillsByRole,
    selectSessionChildrenToExpand,
} from "./session-view.ts";

export type {
    FetchSessionViewOptions as FetchSessionShowOptions,
    SessionViewPayload as SessionShowPayload,
} from "./session-view.ts";
