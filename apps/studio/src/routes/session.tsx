import { useParams } from "@tanstack/react-router";
import { SessionInspectView } from "./session-inspect.tsx";

export function SessionRoute() {
    const { sessionId } = useParams({ from: "/sessions/$sessionId" });
    return <SessionInspectView sessionId={sessionId} />;
}
