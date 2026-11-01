import { FAVICON_SVG } from "./favicon.ts";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Address } from "viem";
import { TtlCache, workersEdgeCache } from "./cache.ts";
import { makeClients, type Clients } from "./chain/client.ts";
import { requestTiming } from "./chain/trace.ts";
import type { Config } from "./config.ts";
import { registerDiscovery } from "./discovery.ts";
import { checkToken, DISCLAIMER, ENGINE_VERSION, InputError, parseTokenAddress, redact, type VerdictResponse } from "./risk/verdict.ts";
import { SAMPLE_VERDICT } from "./sample.ts";
import { Timings } from "./timing.ts";
import { BATCH_DESCRIPTION, lazyPaymentMiddleware, plausiblePayment, SERVICE_NAME, SINGLE_DESCRIPTION } from "./x402.ts";

declare module "hono" {
  interface ContextVariableMap {
    timing: Timings;
  }
}

export const MAX_BATCH = 10;

export interface AppDeps {
  /** Override for tests. */
  check?: (address: Address, timing?: Timings) => Promise<VerdictResponse>;
  /** Override for tests: replace the x402 middleware. */
  payment?: import("hono").MiddlewareHandler;
  clients?: Clients;
  /** Override for tests: stand-in for caches.default. */
  edgeStore?: Pick<Cache, "match" | "put">;
}

function errorStatus(e: unknown): 400 | 422 | 502 {
  const s = (e as { status?: number }).status;
  return s === 400 || s === 422 ? s : 502;
}

export function createApp(cfg: Config, deps: AppDeps = {}) {
  const clients = deps.clients ?? makeClients(cfg);
  const memory = new TtlCache<VerdictResponse>(cfg.cacheTtlSeconds * 1000);
  const edge = workersEdgeCache<VerdictResponse>(cfg.cacheTtlSeconds, `verdict-v${ENGINE_VERSION}`, deps.edgeStore);
  /** One computation per address at a time: a speculative start and the real request share it. */
  const inflight = new Map<string, Promise<VerdictResponse>>();
  const MAX_INFLIGHT = 16;

  /**
   * Verdict lookup, cheapest first: this isolate's memory, a computation already running for the address,
   * the data center's Cache API, then the engine. Only successes are cached.
   */
  const lookup = (address: Address, timing?: Timings): Promise<VerdictResponse> => {
    const hit = memory.get(address);
    if (hit) {
      if (timing) timing.info.cache ??= "memory";
      return Promise.resolve(hit);
    }
    const running = inflight.get(address);
    if (running) {
      if (timing) timing.info.cache ??= "shared";
      return running;
    }
    const compute = (async () => {
      const shared = cfg.cacheTtlSeconds > 0 ? await edge.get(address) : undefined;
      if (shared) {
        if (timing) timing.info.cache = "edge";
        memory.set(address, shared);
        return shared;
      }
      if (timing) timing.info.cache = "miss";
      const v = await checkToken(clients, address, { simUsd: cfg.simUsd, timing });
      memory.set(address, v);
      if (cfg.cacheTtlSeconds > 0) timing?.background.push(edge.put(address, v));
      return v;
    })().finally(() => inflight.delete(address));
    inflight.set(address, compute);
    return compute;
  };
  const check = deps.check ?? lookup;
  /** Start the engine early for a request that carries a plausible payment (see the speculation middleware). */
  const prefetch = deps.check ? undefined : (address: Address, timing: Timings) => {
    if (memory.get(address) || inflight.has(address) || inflight.size >= MAX_INFLIGHT) return;
    lookup(address, timing).catch(() => {});
  };
  const payment = deps.payment ?? lazyPaymentMiddleware(cfg);

  const app = new Hono();
  app.use("*", cors({ origin: "*", exposeHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE", "X-PAYMENT-RESPONSE", "Server-Timing"] }));
  // Phase timings: a Server-Timing header on every response and one JSON log line per payment attempt.
  app.use("*", async (c, next) => {
    const timing = new Timings();
    c.set("timing", timing);
    await requestTiming.run(timing, next);
    c.header("Server-Timing", timing.header());
    if (timing.background.length) {
      try {
        c.executionCtx.waitUntil(Promise.allSettled(timing.background));
      } catch {
        // not running in a Worker (Node, tests): the writes simply finish on their own
      }
    }
    if (c.req.path.startsWith("/v1/verdict/") && (c.req.header("payment-signature") || c.req.header("x-payment"))) {
      // Why a payment was not settled (facilitator reason code only; no payer, no signature).
      try {
        const receipt = JSON.parse(atob(c.res.headers.get("PAYMENT-RESPONSE") ?? ""));
        timing.info.settled = receipt.success === true;
        if (receipt.success !== true) timing.info.settleError = String(receipt.errorReason ?? receipt.error ?? "unknown").slice(0, 80);
      } catch {
        // no receipt: payment rejected before settlement or handler error
      }
      console.log(JSON.stringify({ evt: "paid_request", path: c.req.path, status: c.res.status, ...timing.toJSON(), ...timing.info }));
    }
  });

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

  /** Whether the runtime really stores Cache API entries (probed once per isolate). */
  let cacheProbe: Promise<boolean> | undefined;
  const edgeCacheWorks = () =>
    (cacheProbe ??= (async () => {
      const probe = workersEdgeCache<{ ok: true }>(60, "health-probe", deps.edgeStore);
      await probe.put("probe", { ok: true });
      return (await probe.get("probe"))?.ok === true;
    })());

  app.get("/v1/health", async (c) => {
    const started = Date.now();
    const block = await Promise.race([
      clients.rpc.getBlockNumber().then(Number).catch(() => null),
      new Promise<null>((r) => setTimeout(() => r(null), 3000)),
    ]);
    return c.json(
      { ok: block !== null, block, rpcLatencyMs: Date.now() - started, network: cfg.network, engine: ENGINE_VERSION, cacheApi: await edgeCacheWorks() },
      block !== null ? 200 : 503,
    );
  });

  // Directory icon (x402scan reads /favicon.ico at the API root). SVG served under both names.
  const icon = (c: { body(data: string, status: 200, headers: Record<string, string>): Response }) =>
    c.body(FAVICON_SVG, 200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" });
  app.get("/favicon.ico", icon);
  app.get("/favicon.svg", icon);
  app.get("/v1/sample", (c) => c.json(SAMPLE_VERDICT));

  registerDiscovery(app, cfg);

  // Unpaid requests always reach the paywall, so discovery probes (x402scan probes the literal "{address}") see the 402.
  // A request that carries a payment is validated first: a malformed one gets a 400 and is never settled.
  const hasPayment = (c: { req: { header(name: string): string | undefined } }) =>
    Boolean(c.req.header("payment-signature") ?? c.req.header("x-payment"));
  app.get("/v1/verdict/:address", async (c, next) => {
    const raw = c.req.param("address");
    if (raw === "batch") return c.json({ error: "Use POST /v1/verdict/batch" }, 405);
    if (!hasPayment(c)) return next();
    try {
      parseTokenAddress(raw);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    return next();
  });
  // Pre-compute during verification. A request that already carries a plausible payment for this service starts the
  // engine now, so the verdict is ready (or nearly) by the time the facilitator has verified the payment instead
  // of starting after it. The handler still only runs, and the response is still only released, after verify AND
  // settle; this only moves the engine's start earlier. Unpaid requests never trigger it, and the check is local
  // (a forged header can still start one cached, deduplicated, capped engine run per address).
  app.get("/v1/verdict/:address", async (c, next) => {
    if (prefetch && plausiblePayment(c.req.header("payment-signature") ?? c.req.header("x-payment"), cfg)) {
      prefetch(parseTokenAddress(c.req.param("address")), c.get("timing"));
    }
    return next();
  });
  // Same for batch: unpaid requests get the 402; a paid request with a malformed body gets a 400 and is not settled.
  app.post("/v1/verdict/batch", async (c, next) => {
    if (!hasPayment(c)) return next();
    const parsed = await parseBatch(c);
    return "error" in parsed ? c.json({ error: parsed.error }, 400) : next();
  });

  app.use("/v1/verdict/*", payment);

  // Handlers. Any status >= 400 makes the x402 middleware skip settlement, so failed checks are not charged.
  app.get("/v1/verdict/:address", async (c) => {
    try {
      const timing = c.get("timing");
      const v = await check(parseTokenAddress(c.req.param("address")), timing);
      timing.info.verdict = v.verdict;
      timing.info.partial = v.meta?.partial?.length;
      return c.json(v, 200, { "Cache-Control": "no-store" });
    } catch (e) {
      return c.json({ error: redact((e as Error).message ?? "").slice(0, 300) }, errorStatus(e));
    }
  });

  app.post("/v1/verdict/batch", async (c) => {
    const parsed = await parseBatch(c);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    const unique = [...new Set(parsed.addresses)];
    const results: Array<VerdictResponse | { address: string; error: string; status: number }> = new Array(unique.length);
    let i = 0;
    const worker = async () => {
      while (i < unique.length) {
        const idx = i++;
        try {
          results[idx] = await check(unique[idx], c.get("timing"));
        } catch (e) {
          results[idx] = { address: unique[idx], error: redact((e as Error).message ?? "").slice(0, 300), status: errorStatus(e) };
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
