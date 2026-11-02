import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { paymentMiddleware } from "@x402/hono";
import type { MiddlewareHandler } from "hono";
import type { Config } from "./config.ts";
import { SAMPLE_VERDICT } from "./sample.ts";
import type { Timings } from "./timing.ts";
import { ADDRESS_SCHEMA, BATCH_INPUT_SCHEMA, BATCH_OUTPUT_SCHEMA, VERDICT_OUTPUT_SCHEMA } from "./schema.ts";

export const SERVICE_NAME = "Canisell";
export const SINGLE_DESCRIPTION =
  "Pre-trade risk verdict for a Base ERC-20 (built for brand-new Clanker/Zora/Uniswap v4 launches): simulated buy+sell (honeypot, taxes, round-trip loss), owner powers (mint/blacklist/pause/fee setters, upgradeable proxy), exit liquidity and LP lock, token age and creator history. Returns SAFE/CAUTION/DANGER, a 0-100 score and reasons.";
export const BATCH_DESCRIPTION = "Same verdict for up to 10 Base ERC-20 tokens in one paid call.";

/** Route table for @x402/hono, including Bazaar discovery metadata. */
export function paidRoutes(cfg: Config) {
  const accepts = (price: string) => ({ scheme: "exact" as const, price, network: cfg.network, payTo: cfg.payTo });
  const tags = ["base", "token-risk", "honeypot", "uniswap-v4", "clanker", "zora"];
  return {
    "GET /v1/verdict/:address": {
      accepts: accepts(cfg.priceSingle),
      description: SINGLE_DESCRIPTION,
      mimeType: "application/json",
      serviceName: SERVICE_NAME,
      tags,
      extensions: {
        ...declareDiscoveryExtension({
          pathParamsSchema: { properties: { address: ADDRESS_SCHEMA }, required: ["address"] },
          output: { example: SAMPLE_VERDICT, schema: VERDICT_OUTPUT_SCHEMA as unknown as Record<string, unknown> },
        }),
      },
    },
    "POST /v1/verdict/batch": {
      accepts: accepts(cfg.priceBatch),
      description: BATCH_DESCRIPTION,
      mimeType: "application/json",
      serviceName: SERVICE_NAME,
      tags,
      extensions: {
        ...declareDiscoveryExtension({
          bodyType: "json",
          input: { addresses: [SAMPLE_VERDICT.address, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"] },
          inputSchema: BATCH_INPUT_SCHEMA as unknown as Record<string, unknown>,
          output: { example: { results: [SAMPLE_VERDICT] }, schema: BATCH_OUTPUT_SCHEMA as unknown as Record<string, unknown> },
        }),
      },
    },
  };
}

/**
 * Defence in depth around the x402 middleware. @x402/hono already buffers the handler response, settles
 * through the facilitator and swaps in a 402 when settlement fails, so a 2xx only leaves it with a
 * PAYMENT-RESPONSE header. This wrapper enforces that invariant: any non-error response on a paid route
 * that does not carry a settlement receipt is replaced by a 402 without the body, whatever the cause.
 */
export function requireSettlement(inner: MiddlewareHandler): MiddlewareHandler {
  return async (c, next) => {
    // A middleware may return its response instead of assigning c.res (Hono does that after we return).
    const returned = await inner(c, next);
    if (returned instanceof Response) c.res = returned;
    const res = c.res;
    if (res && res.status < 400 && !res.headers.has("PAYMENT-RESPONSE")) {
      c.res = new Response(JSON.stringify({ error: "Payment was not settled; no content served" }), {
        status: 402,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }
  };
}

/**
 * Cheap local plausibility check of a payment header (no signature verification, no network): base64 JSON naming this
 * service's network and payee. It only gates *speculative* engine starts; the facilitator still verifies and settles.
 */
export function plausiblePayment(header: string | undefined, cfg: Pick<Config, "network" | "payTo">): boolean {
  if (!header || header.length > 16_384) return false;
  try {
    const json = JSON.parse(typeof atob === "function" ? atob(header) : Buffer.from(header, "base64").toString("utf8"));
    const accepted = json?.accepted ?? json;
    const payTo = String(accepted?.payTo ?? json?.payload?.authorization?.to ?? "").toLowerCase();
    return String(accepted?.network) === cfg.network && payTo === cfg.payTo.toLowerCase() && typeof json?.payload === "object" && json.payload !== null;
  } catch {
    return false;
  }
}

/** Hono context of the request that triggered an x402 hook (carried in the transport context). */
function timingOf(ctx: unknown): Timings | undefined {
  return (ctx as { transportContext?: { request?: { adapter?: { c?: { get(k: string): unknown } } } } })?.transportContext?.request?.adapter?.c?.get("timing") as
    | Timings
    | undefined;
}

/** Times the facilitator /supported call (once per isolate) so cold starts show up in the logs. */
class TimedFacilitatorClient extends HTTPFacilitatorClient {
  override async getSupported() {
    const t = Date.now();
    try {
      return await super.getSupported();
    } finally {
      console.log(JSON.stringify({ evt: "facilitator_supported", ms: Date.now() - t }));
    }
  }
}

export type PaymentMiddleware = MiddlewareHandler & { warm(): void };

/**
 * Receive-only x402 middleware: verification and settlement are done by the facilitator,
 * so the server holds no keys. Built lazily on the first request that needs it so that Workers never
 * do I/O at global scope. `warm()` builds it (which starts the facilitator /supported fetch) ahead of the
 * first paid request, e.g. from a health check.
 */
export function lazyPaymentMiddleware(cfg: Config): PaymentMiddleware {
  let mw: MiddlewareHandler | undefined;
  const build = () => {
    if (!mw) {
      const server = new x402ResourceServer(new TimedFacilitatorClient({ url: cfg.facilitatorUrl, timeoutMs: 20_000 })).register(
        cfg.network,
        new ExactEvmScheme(),
      );
      // Phase timings for Server-Timing / logs: facilitator verify and settle are the two network round trips we do not control.
      server.onBeforeVerify(async (ctx) => void timingOf(ctx)?.start("verify"));
      server.onAfterVerify(async (ctx) => void timingOf(ctx)?.end("verify"));
      server.onVerifyFailure(async (ctx) => void timingOf(ctx)?.end("verify"));
      server.onBeforeSettle(async (ctx) => void timingOf(ctx)?.start("settle"));
      server.onAfterSettle(async (ctx) => void timingOf(ctx)?.end("settle"));
      server.onSettleFailure(async (ctx) => void timingOf(ctx)?.end("settle"));
      mw = requireSettlement(paymentMiddleware(paidRoutes(cfg), server));
    }
    return mw;
  };
  const handler = ((c, next) => build()(c, next)) as PaymentMiddleware;
  handler.warm = () => void build();
  return handler;
}
