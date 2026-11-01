import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { paymentMiddleware } from "@x402/hono";
import type { MiddlewareHandler } from "hono";
import type { Config } from "./config.ts";
import { SAMPLE_VERDICT } from "./sample.ts";
import { ADDRESS_SCHEMA, BATCH_INPUT_SCHEMA, BATCH_OUTPUT_SCHEMA, VERDICT_OUTPUT_SCHEMA } from "./schema.ts";

export const SERVICE_NAME = "Base Launch-Token Verdict";
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
 * Receive-only x402 middleware: verification and settlement are done by the facilitator,
 * so the server holds no keys. Built lazily on the first paid request so that Workers never
 * do I/O at global scope.
 */
export function lazyPaymentMiddleware(cfg: Config): MiddlewareHandler {
  let mw: MiddlewareHandler | undefined;
  return (c, next) => {
    if (!mw) {
      const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: cfg.facilitatorUrl, timeoutMs: 20_000 })).register(
        cfg.network,
        new ExactEvmScheme(),
      );
      mw = paymentMiddleware(paidRoutes(cfg), server);
    }
    return mw(c, next);
  };
}
