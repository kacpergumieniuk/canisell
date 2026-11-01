import type { Hono } from "hono";
import type { Config } from "./config.ts";
import { DISCLAIMER, ENGINE_VERSION } from "./risk/verdict.ts";
import { SAMPLE_VERDICT } from "./sample.ts";
import { ADDRESS_SCHEMA, BATCH_INPUT_SCHEMA, BATCH_OUTPUT_SCHEMA, VERDICT_OUTPUT_SCHEMA } from "./schema.ts";
import { BATCH_DESCRIPTION, SERVICE_NAME, SINGLE_DESCRIPTION } from "./x402.ts";

/**
 * Free discovery endpoints for agent directories (x402scan, Bazaar crawlers, LLM tools):
 *   GET /.well-known/x402  - x402scan fan-out list (version 1, resources[])
 *   GET /openapi.json      - OpenAPI 3.1 with `x-payment-info` (price, protocol) on paid operations
 *   GET /llms.txt          - short plain-text description and usage
 * Spec followed: https://github.com/Merit-Systems/x402scan/blob/main/docs/DISCOVERY.md
 * The service name comes from SERVICE_NAME (x402.ts) only; nothing here hardcodes it.
 */

interface EndpointDoc {
  id: string;
  method: "get" | "post";
  /** OpenAPI-style path template. */
  path: string;
  /** Configured price like "$0.01"; undefined for free endpoints. */
  price?: string;
  summary: string;
  description: string;
  /** Concrete, probe-able URL path for /.well-known/x402 (paid endpoints only). */
  probePath?: string;
}

function endpoints(cfg: Config): EndpointDoc[] {
  return [
    {
      id: "getVerdict", method: "get",
      path: "/v1/verdict/{address}",
      price: cfg.priceSingle,
      summary: "Risk verdict for one Base ERC-20 token",
      description: SINGLE_DESCRIPTION,
      probePath: `/v1/verdict/${SAMPLE_VERDICT.address}`,
    },
    {
      id: "postVerdictBatch", method: "post",
      path: "/v1/verdict/batch",
      price: cfg.priceBatch,
      summary: "Risk verdicts for up to 10 Base ERC-20 tokens",
      description: BATCH_DESCRIPTION,
      probePath: "/v1/verdict/batch",
    },
    { id: "getSample", method: "get", path: "/v1/sample", summary: "Example verdict response", description: "Cached example response in the same shape as the paid endpoint. Free." },
    { id: "getHealth", method: "get", path: "/v1/health", summary: "RPC reachability", description: "Liveness and RPC reachability. Free." },
    { id: "getRoot", method: "get", path: "/", summary: "Service description", description: "Service description and endpoint list. Free." },
    { id: "getOpenApi", method: "get", path: "/openapi.json", summary: "OpenAPI 3.1 description", description: "This document. Free." },
    { id: "getWellKnownX402", method: "get", path: "/.well-known/x402", summary: "x402 resource list", description: "x402scan discovery fan-out. Free." },
    { id: "getLlmsTxt", method: "get", path: "/llms.txt", summary: "Plain-text description for LLMs", description: "Short plain-text description and usage. Free." },
  ];
}

/** "$0.01" -> "0.01" (USD amount as a decimal string). */
export function usdAmount(price: string): string {
  return price.trim().replace(/^\$/, "");
}

function baseUrl(cfg: Config, requestUrl: string): string {
  return (cfg.publicBaseUrl ?? new URL(requestUrl).origin).replace(/\/+$/, "");
}

export function wellKnownX402(cfg: Config, origin: string) {
  return {
    version: 1,
    resources: endpoints(cfg)
      .filter((e) => e.probePath)
      .map((e) => `${origin}${e.probePath}`),
    instructions: `${SERVICE_NAME}: pay-per-call Base token risk verdicts (x402, USDC on ${cfg.network}). Machine-readable description at ${origin}/openapi.json, plain text at ${origin}/llms.txt.`,
  };
}

export function openApiDocument(cfg: Config, origin: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const e of endpoints(cfg)) {
    const paid = e.price !== undefined;
    const responses: Record<string, unknown> = {};
    const json = (schema: unknown) => ({ "application/json": { schema } });
    if (e.path === "/v1/verdict/{address}") responses["200"] = { description: "Verdict", content: json(VERDICT_OUTPUT_SCHEMA) };
    else if (e.path === "/v1/verdict/batch") responses["200"] = { description: "Verdicts", content: json(BATCH_OUTPUT_SCHEMA) };
    else if (e.path === "/openapi.json" || e.path === "/.well-known/x402") responses["200"] = { description: "OK", content: json({ type: "object" }) };
    else if (e.path === "/llms.txt") responses["200"] = { description: "OK", content: { "text/plain": { schema: { type: "string" } } } };
    else responses["200"] = { description: "OK", content: json({ type: "object" }) };
    if (paid) {
      responses["400"] = { description: "Malformed request; payment is not settled" };
      responses["402"] = { description: "Payment required (x402). Requirements are in the PAYMENT-REQUIRED header and body." };
      responses["422"] = { description: "Address is not a token contract; payment is not settled" };
      responses["502"] = { description: "Upstream RPC failure; payment is not settled" };
    }
    const op: Record<string, unknown> = {
      operationId: e.id,
      summary: e.summary,
      description: e.description,
      ...(e.path.includes("{address}") ? { parameters: [{ name: "address", in: "path", required: true, schema: ADDRESS_SCHEMA }] } : {}),
      ...(e.path === "/v1/verdict/batch"
        ? { requestBody: { required: true, content: { "application/json": { schema: BATCH_INPUT_SCHEMA } } } }
        : {}),
      responses,
    };
    if (paid) {
      op["x-payment-info"] = {
        protocols: [{ x402: {} }],
        price: { mode: "fixed", currency: "USD", amount: usdAmount(e.price!) },
        scheme: "exact",
        network: cfg.network,
        asset: "USDC",
        payTo: cfg.payTo,
      };
      op.security = [{ x402: [] }];
    } else {
      op.security = [];
    }
    (paths[e.path] ??= {})[e.method] = op;
  }
  return {
    openapi: "3.1.0",
    info: {
      title: SERVICE_NAME,
      version: ENGINE_VERSION,
      description: `${SINGLE_DESCRIPTION}\n\n${DISCLAIMER}`,
    },
    servers: [{ url: origin }],
    paths,
    components: {
      securitySchemes: {
        x402: {
          type: "apiKey",
          in: "header",
          name: "PAYMENT-SIGNATURE",
          description: "x402 payment payload (base64). Request without it to get a 402 with the payment requirements.",
        },
      },
    },
  };
}

export function llmsTxt(cfg: Config, origin: string): string {
  return `# ${SERVICE_NAME}

> Pay-per-call risk verdicts for Base (chain 8453) ERC-20 tokens, built for brand-new Clanker / Zora / Uniswap v4 launches. Returns SAFE / CAUTION / DANGER, a 0-100 score, reasons and structured findings. ${DISCLAIMER}

Payment: x402, USDC on ${cfg.network}, scheme "exact". Call a paid endpoint without payment to receive HTTP 402 with the payment requirements (PAYMENT-REQUIRED header); an x402 client (for example @x402/fetch) pays and retries automatically. You are charged only when the check succeeds.

## Paid endpoints
- GET ${origin}/v1/verdict/{address}: ${cfg.priceSingle} per call. One token. Example: ${origin}/v1/verdict/${SAMPLE_VERDICT.address}
- POST ${origin}/v1/verdict/batch: ${cfg.priceBatch} per call. JSON body {"addresses": ["0x...", ...]}, 1-10 addresses.

## Free endpoints
- GET ${origin}/v1/sample: example response
- GET ${origin}/v1/health: service and RPC status
- GET ${origin}/openapi.json: OpenAPI 3.1 with prices (x-payment-info)
- GET ${origin}/.well-known/x402: x402 resource list

## Notes
- Token data always comes from Base mainnet; payments settle on ${cfg.network}.
- Malformed requests return 400 and non-token addresses return 422; neither is charged.
`;
}

export function registerDiscovery(app: Hono, cfg: Config): void {
  const cache = { "Cache-Control": "public, max-age=300" };
  app.get("/.well-known/x402", (c) => c.json(wellKnownX402(cfg, baseUrl(cfg, c.req.url)), 200, cache));
  app.get("/openapi.json", (c) => c.json(openApiDocument(cfg, baseUrl(cfg, c.req.url)), 200, cache));
  app.get("/llms.txt", (c) => c.text(llmsTxt(cfg, baseUrl(cfg, c.req.url)), 200, { ...cache, "Content-Type": "text/plain; charset=utf-8" }));
}
