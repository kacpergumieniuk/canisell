import type { Hono } from "hono";
import { createApp } from "./app.ts";
import { loadConfig, type EnvLike } from "./config.ts";

let app: Hono | undefined;

export default {
  fetch(request: Request, env: EnvLike, ctx: ExecutionContext) {
    // Built on first request: Workers only expose vars inside fetch and forbid I/O at global scope.
    app ??= createApp(loadConfig(env));
    return app.fetch(request, env, ctx);
  },
};
