import { contextBridge } from "electron";

// Studio <-> daemon talks HTTP, so the preload surface is intentionally tiny.
// We only expose a marker so the renderer can tell it is running inside the
// desktop shell (and pick the bundled endpoint instead of prompting).
contextBridge.exposeInMainWorld("axDesktop", {
    isDesktop: true,
    platform: process.platform,
});
