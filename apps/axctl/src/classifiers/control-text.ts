export function isControlOrContextText(text: string): boolean {
    return text.startsWith("<goal_context>") ||
        text.startsWith("<subagent_notification>") ||
        text.startsWith("# AGENTS.md instructions") ||
        text.startsWith("# CLAUDE.md") ||
        text.includes("<INSTRUCTIONS>") ||
        text.includes("<environment_context>") ||
        text.startsWith("<task>") ||
        text.startsWith("<task-notification>");
}
