import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";

const cfg = loadConfig(process.env);
const port = Number(process.env.PORT ?? 8787);
serve({ fetch: createApp(cfg).fetch, port }, (info) => {
  console.log(`launch-token verdict API on http://localhost:${info.port}  (payments: ${cfg.network} via ${cfg.facilitatorUrl}, payTo ${cfg.payTo})`);
});
