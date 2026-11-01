import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Address } from "viem";
import { TtlCache } from "./cache.ts";
import { makeClients, type Clients } from "./chain/client.ts";
import type { Config } from "./config.ts";
import { registerDiscovery } from "./discovery.ts";
import { checkToken, DISCLAIMER, ENGINE_VERSION, InputError, parseTokenAddress, type VerdictResponse } from "./risk/verdict.ts";
import { SAMPLE_VERDICT } from "./sample.ts";
import { BATCH_DESCRIPTION, lazyPaymentMiddleware, SERVICE_NAME, SINGLE_DESCRIPTION } from "./x402.ts";

export const MAX_BATCH = 10;

export interface AppDeps {
  /** Override for tests. */
  check?: (address: Address) => Promise<VerdictResponse>;
  /** Override for tests: replace the x402 middleware. */
  payment?: import("hono").MiddlewareHandler;
  clients?: Clients;
}

function errorStatus(e: unknown): 400 | 422 | 502 {
  const s = (e as { status?: number }).status;
  return s === 400 || s === 422 ? s : 502;
}

export function createApp(cfg: Config, deps: AppDeps = {}) {
  const clients = deps.clients ?? makeClients(cfg);
  const cache = new TtlCache<VerdictResponse>(cfg.cacheTtlSeconds * 1000);
  const check =
    deps.check ??
    (async (address: Address) => {
      const hit = cache.get(address);
      if (hit) return hit;
      const v = await checkToken(clients, address, { simUsd: cfg.simUsd });
      cache.set(address, v);
      return v;
    });
  const payment = deps.payment ?? lazyPaymentMiddleware(cfg);

  const app = new Hono();
  app.use("*", cors({ origin: "*", exposeHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE", "X-PAYMENT-RESPONSE"] }));

  app.get("/", (c) =>
    c.json({
      name: SERVICE_NAME,
      description: SINGLE_DESCRIPTION,
      engine: ENGINE_VERSION,
      chain: "base (8453)",
      payment: { protocol: "x402 v2", network: cfg.network, payTo: cfg.payTo, facilitator: cfg.facilitatorUrl },
      endpoints: [
        { method: "GET", path: "/v1/verdict/{address}", price: cfg.priceSingle, description: SINGLE_DESCRIPTION },
        { method: "POST", path: "/v1/verdict/batch", price: cfg.priceBatch, body: '{"addresses": ["0x...", ...]} (max 10)', description: BATCH_DESCRIPTION },
        { method: "GET", path: "/v1/sample", price: "free", description: "Cached example response" },
        { method: "GET", path: "/v1/health", price: "free" },
        { method: "GET", path: "/openapi.json", price: "free", description: "OpenAPI 3.1 with prices (x-payment-info)" },
        { method: "GET", path: "/.well-known/x402", price: "free", description: "x402 resource list for directories" },
        { method: "GET", path: "/llms.txt", price: "free", description: "Plain-text description for LLMs" },
      ],
      disclaimer: DISCLAIMER,
    }),
  );

  app.get("/v1/health", async (c) => {
    const started = Date.now();
    const block = await Promise.race([
      clients.rpc.getBlockNumber().then(Number).catch(() => null),
      new Promise<null>((r) => setTimeout(() => r(null), 3000)),
    ]);
    return c.json({ ok: block !== null, block, rpcLatencyMs: Date.now() - started, network: cfg.network, engine: ENGINE_VERSION }, block !== null ? 200 : 503);
  });

  app.get("/v1/sample", (c) => c.json(SAMPLE_VERDICT));

  registerDiscovery(app, cfg);

  // Validate before the paywall so malformed requests get a 400 instead of a 402.
  app.get("/v1/verdict/:address", async (c, next) => {
    const raw = c.req.param("address");
    if (raw === "batch") return c.json({ error: "Use POST /v1/verdict/batch" }, 405);
    try {
      parseTokenAddress(raw);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    return next();
  });
  // An empty body goes on to the paywall, so discovery probes (x402scan) see the 402.
  // Present but malformed bodies are rejected here, before anyone is asked to pay.
  app.post("/v1/verdict/batch", async (c, next) => {
    if ((await c.req.text()).trim() === "") return next();
    const parsed = await parseBatch(c);
    return "error" in parsed ? c.json({ error: parsed.error }, 400) : next();
  });

  app.use("/v1/verdict/*", payment);

  // Handlers. Any status >= 400 makes the x402 middleware skip settlement, so failed checks are not charged.
  app.get("/v1/verdict/:address", async (c) => {
    try {
      const v = await check(parseTokenAddress(c.req.param("address")));
      return c.json(v, 200, { "Cache-Control": "no-store" });
    } catch (e) {
      return c.json({ error: (e as Error).message?.slice(0, 300) }, errorStatus(e));
    }
  });

  app.post("/v1/verdict/batch", async (c) => {
    // Re-validated here because empty bodies skip the pre-paywall check; a 400 is never settled.
    const parsed = await parseBatch(c);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    const unique = [...new Set(parsed.addresses)];
    const results: Array<VerdictResponse | { address: string; error: string; status: number }> = new Array(unique.length);
    let i = 0;
    const worker = async () => {
      while (i < unique.length) {
        const idx = i++;
        try {
          results[idx] = await check(unique[idx]);
        } catch (e) {
          results[idx] = { address: unique[idx], error: (e as Error).message?.slice(0, 300), status: errorStatus(e) };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, unique.length) }, worker));
    const allInfraFailed = results.every((r) => "error" in r && r.status === 502);
    if (allInfraFailed) return c.json({ error: "Upstream RPC failure; you were not charged", results }, 502);
    return c.json({ results }, 200, { "Cache-Control": "no-store" });
  });

  async function parseBatch(c: { req: { text(): Promise<string> } }): Promise<{ addresses: `0x${string}`[] } | { error: string }> {
    let body: unknown;
    try {
      body = JSON.parse(await c.req.text());
    } catch {
      return { error: 'Body must be JSON: {"addresses": ["0x..."]}' };
    }
    const list = (body as { addresses?: unknown })?.addresses;
    if (!Array.isArray(list) || list.length === 0 || list.length > MAX_BATCH)
      return { error: `"addresses" must be an array of 1-${MAX_BATCH} addresses` };
    try {
      return { addresses: list.map((a) => parseTokenAddress(String(a))) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  app.notFound((c) => c.json({ error: "Not found", docs: "/" }, 404));
  app.onError((e, c) => (e instanceof InputError ? c.json({ error: e.message }, 400) : c.json({ error: "Internal error" }, 500)));
  return app;
}
