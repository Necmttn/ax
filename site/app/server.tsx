import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";

const handler = createStartHandler(defaultStreamHandler);

export default {
  async fetch(request: Request, opts?: Parameters<typeof handler>[1]) {
    return await handler(request, opts);
  },
};
