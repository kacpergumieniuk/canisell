/**
 * Hosted remote MCP endpoint: POST /mcp (Streamable HTTP, stateless, JSON responses).
 *
 * A fresh McpServer + WebStandardStreamableHTTPServerTransport per request, so it runs in a plain Worker
 * (no Durable Objects, no sessions). Tools:
 *   check_base_token(address)  PAID. Uses the x402 MCP transport (@x402/mcp): without `_meta["x402/payment"]` it
 *                              returns isError + the x402 PaymentRequired object (no engine run), plus plain-text
 *                              instructions for paying the HTTP endpoint instead. With a payment it verifies, runs
 *                              the check, and settles through the facilitator only if the check succeeded.
 *   get_token_info(address)    FREE. Contract check + ERC-20 metadata (name/symbol/decimals/totalSupply): one
 *                              getCode plus one Multicall3 read, cached 10 minutes. No simulation, no risk verdict.
 *   get_sample_verdict()       FREE. A cached example verdict in the paid response's shape.
 *   explain_verdict_fields()   FREE. What the verdict fields mean, limits and prices.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { createPaymentWrapper } from "@x402/mcp";
import { size, type Address, type PublicClient } from "viem";
import { z } from "zod";
import type { Config } from "./config.ts";
import { ERC20_ABI, tryRead } from "./risk/contract.ts";
import { DISCLAIMER, ENGINE_VERSION, parseTokenAddress, redact, type VerdictResponse } from "./risk/verdict.ts";
import { SAMPLE_VERDICT } from "./sample.ts";
import { VERDICT_OUTPUT_SCHEMA } from "./schema.ts";
import { SERVICE_NAME, SINGLE_DESCRIPTION } from "./x402.ts";

export const MCP_SERVER_NAME = "canisell";
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const addressArg = z.string().regex(ADDRESS_RE, "must be a 0x-prefixed 20-byte address").describe("ERC-20 token contract address on Base mainnet (chain 8453)");

export interface TokenInfo {
  address: Address;
  chain: "base";
  isContract: boolean;
  codeSize: number;
  isErc20: boolean;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  totalSupply: string | null;
}

/** Contract check + ERC-20 getters. One eth_getCode and one Multicall3 batch on the configured RPCs. */
export async function readTokenInfo(client: PublicClient, address: Address): Promise<TokenInfo> {
  const read = <T>(functionName: "name" | "symbol" | "decimals" | "totalSupply") =>
    tryRead(client.readContract({ address, abi: ERC20_ABI, functionName }) as Promise<T>);
  const [code, name, symbol, decimals, totalSupply] = await Promise.all([
    client.getCode({ address }),
    read<string>("name"),
    read<string>("symbol"),
    read<number>("decimals"),
    read<bigint>("totalSupply"),
  ]);
  const isContract = !!code && code !== "0x";
  return {
    address,
    chain: "base",
    isContract,
    codeSize: isContract ? size(code!) : 0,
    isErc20: isContract && totalSupply !== undefined && decimals !== undefined,
    name: isContract ? (name ?? null) : null,
    symbol: isContract ? (symbol ?? null) : null,
    decimals: isContract && decimals !== undefined ? Number(decimals) : null,
    totalSupply: isContract && totalSupply !== undefined ? totalSupply.toString() : null,
  };
}

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
};
type ToolHandler = (args: { address: string }, extra: unknown) => Promise<ToolResult>;
type PaidWrapper = (handler: ToolHandler) => ToolHandler;

export interface McpDeps {
  cfg: Config;
  /** Public origin of the API, e.g. https://api.canisell.xyz */
  origin: string;
  /** The same cached verdict lookup the paid HTTP route uses. Only ever called after a verified payment. */
  check: (address: Address) => Promise<VerdictResponse>;
  tokenInfo: (address: Address) => Promise<TokenInfo>;
  /** x402 payment wrapper for the paid tool (built lazily: it fetches the facilitator's /supported once). */
  paidWrapper: () => Promise<PaidWrapper>;
}

const text = (v: unknown, isError = false): ToolResult => ({
  content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

/** Plain-language payment terms and the paid HTTP route, for clients that cannot pay inside MCP. */
export function paymentHowTo(cfg: Config, origin: string, address?: string): string {
  const url = `${origin}/v1/verdict/${address ?? "{address}"}`;
  return [
    `check_base_token costs ${cfg.priceSingle} USDC per call, paid with x402 (scheme "exact", network ${cfg.network}, payTo ${cfg.payTo}). No verdict was computed and nothing was charged.`,
    "",
    "Ways to pay:",
    `1. MCP clients with an x402 wallet (for example @x402/mcp createx402MCPClient, or a wallet MCP proxy) pay automatically: retry this tool call with the payment in _meta["x402/payment"]. The PaymentRequired object is in the first content item and in structuredContent.`,
    `2. Call the paid HTTP endpoint directly with any x402 client: GET ${url}. Example with @x402/fetch (npm i @x402/fetch @x402/evm viem):`,
    `   const pay = wrapFetchWithPaymentFromConfig(fetch, { schemes: [{ network: "${cfg.network}", client: new ExactEvmScheme(privateKeyToAccount(KEY)) }] });`,
    `   const verdict = await (await pay("${url}")).json();`,
    "",
    `You are charged only when the check succeeds. Free tools here: get_token_info (contract + ERC-20 metadata), get_sample_verdict, explain_verdict_fields. Docs: ${origin}/llms.txt`,
  ].join("\n");
}

function isPaymentRequired(r: ToolResult): boolean {
  const s = r.structuredContent as { x402Version?: unknown; accepts?: unknown } | undefined;
  return r.isError === true && !!s && s.x402Version !== undefined && Array.isArray(s.accepts);
}

export function fieldGuide(cfg: Config, origin: string) {
  return {
    service: SERVICE_NAME,
    engine: ENGINE_VERSION,
    chain: "Base mainnet (8453)",
    verdict: {
      SAFE: "No mechanical trap found: the simulated buy and sell both work at normal taxes and no dangerous owner powers were detected.",
      CAUTION: "Some risk signals (owner keeps powers, thin or unlocked liquidity, very new token, high taxes, unknown facts). Read the reasons.",
      DANGER: "A trap or severe signal: cannot sell (honeypot), extreme taxes or round-trip loss, or critical owner powers.",
    },
    score: "0-100; 100 = no risk signals. Each finding subtracts its penalty.",
    fields: {
      reasons: "Plain-English reasons, most severe first.",
      findings: "Structured findings: id, severity (critical/high/medium/low/info), penalty, message.",
      "flags.trading": "Simulated buy then sell via eth_call with state overrides (about $20): canBuy, canSell, buyTaxPct, sellTaxPct, roundTripLossPct, poolKind.",
      "flags.ownership": "owner, renounced, capabilities (mint/blacklist/pause/fee setters/trading toggle/limit setters), proxy kind and implementation.",
      "flags.liquidity": "Pools found on Uniswap v2/v3/v4 and Aerodrome, total depth in USD, LP lock status where knowable.",
      "flags.creator": "Deployer and its history of earlier tokens.",
      "flags.age": "Token age in seconds and creation block.",
      launchpad: "clanker | zora | null.",
      "meta.partial": "Optional checks that timed out and are reported as unknown instead of delaying the answer.",
    },
    limits: [
      "Heuristics, not financial advice and not an audit. A snapshot at one block: an owner who keeps powers can change the token later.",
      "Base mainnet ERC-20 tokens on Uniswap v2/v3/v4 or Aerodrome pools only.",
      "Results are cached for 60 seconds per address.",
    ],
    prices: {
      check_base_token: `${cfg.priceSingle} USDC (x402, ${cfg.network})`,
      "GET /v1/verdict/{address}": cfg.priceSingle,
      "POST /v1/verdict/batch": `${cfg.priceBatch} for up to 10 tokens`,
      get_token_info: "free",
      get_sample_verdict: "free",
    },
    outputSchema: VERDICT_OUTPUT_SCHEMA,
    docs: `${origin}/llms.txt`,
    disclaimer: DISCLAIMER,
  };
}

function buildServer(deps: McpDeps): McpServer {
  const { cfg, origin } = deps;
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: ENGINE_VERSION },
    {
      instructions: `${SERVICE_NAME}: pre-trade risk checks for Base ERC-20 tokens. get_token_info, get_sample_verdict and explain_verdict_fields are free. check_base_token returns a SAFE/CAUTION/DANGER verdict and costs ${cfg.priceSingle} USDC via x402; clients without an x402 wallet get the payment terms and the paid HTTP URL instead. ${DISCLAIMER}`,
    },
  );
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

  const paidHandler: ToolHandler = async ({ address }) => {
    try {
      return text(await deps.check(parseTokenAddress(address)));
    } catch (e) {
      // isError results are not settled by the payment wrapper: failed checks are free.
      const status = (e as { status?: number }).status;
      return text({ error: status === 422 ? "not_a_token" : status === 400 ? "bad_request" : "upstream_error", message: redact((e as Error).message ?? "").slice(0, 300), charged: false }, true);
    }
  };

  server.registerTool(
    "check_base_token",
    {
      title: "Check a Base token (paid)",
      description: `${SINGLE_DESCRIPTION} Costs ${cfg.priceSingle} USDC per call via x402. MCP clients without an x402 wallet get the payment terms and the paid HTTP URL instead of a verdict. Not financial advice.`,
      inputSchema: { address: addressArg },
      annotations: readOnly,
    },
    async (args, extra) => {
      let wrapped: ToolHandler;
      try {
        wrapped = (await deps.paidWrapper())(paidHandler);
      } catch {
        return text(paymentHowTo(cfg, origin, args.address), true);
      }
      const result = await wrapped(args, extra);
      if (isPaymentRequired(result)) result.content.push({ type: "text", text: paymentHowTo(cfg, origin, args.address) });
      return result as never;
    },
  );

  server.registerTool(
    "get_token_info",
    {
      title: "Base token metadata (free)",
      description:
        "Free. Whether an address on Base mainnet is a contract and an ERC-20, plus its name, symbol, decimals and total supply. No risk analysis: use check_base_token (paid) for the SAFE/CAUTION/DANGER verdict.",
      inputSchema: { address: addressArg },
      annotations: readOnly,
    },
    async ({ address }) => {
      try {
        const info = await deps.tokenInfo(parseTokenAddress(address));
        return text({ ...info, next: info.isErc20 ? `For a pre-trade risk verdict call check_base_token (${cfg.priceSingle} USDC via x402).` : undefined });
      } catch (e) {
        return text({ error: "upstream_error", message: `Base RPC unavailable, try again shortly (${redact((e as Error).message ?? "").slice(0, 120)})` }, true);
      }
    },
  );

  server.registerTool(
    "get_sample_verdict",
    {
      title: "Example verdict (free)",
      description: "Free. A cached example of the check_base_token response for a real Base token, to see the shape before paying.",
      inputSchema: {},
      annotations: { ...readOnly, openWorldHint: false },
    },
    async () => text(SAMPLE_VERDICT),
  );

  server.registerTool(
    "explain_verdict_fields",
    {
      title: "Explain verdict fields (free)",
      description: "Free. What SAFE/CAUTION/DANGER, the score and each field of a verdict mean, the limits of the checks, prices, and the JSON schema.",
      inputSchema: {},
      annotations: { ...readOnly, openWorldHint: false },
    },
    async () => text(fieldGuide(cfg, origin)),
  );

  return server;
}

/**
 * The SDK answers 406 to a POST whose Accept lacks application/json or text/event-stream. Directory health checks
 * and crawlers often send only application/json, a wildcard or no Accept at all. Responses are always JSON here
 * (enableJsonResponse), so such requests are served instead of rejected.
 */
export function withLenientAccept(request: Request): Request {
  if (request.method !== "POST") return request;
  const accept = request.headers.get("accept") ?? "";
  if (accept.includes("application/json") && accept.includes("text/event-stream")) return request;
  const headers = new Headers(request.headers);
  headers.set("accept", "application/json, text/event-stream");
  return new Request(request, { headers });
}

/** Handles one HTTP request to /mcp. */
export async function handleMcp(request: Request, deps: McpDeps): Promise<Response> {
  const server = buildServer(deps);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 64 * 1024 });
  await server.connect(transport);
  try {
    return await transport.handleRequest(withLenientAccept(request));
  } finally {
    // JSON mode: the response body is complete once handleRequest resolves.
    void server.close().catch(() => {});
  }
}

/** Builds the x402 payment wrapper for check_base_token once per isolate; a failed build is retried on the next call. */
export function lazyPaidWrapper(cfg: Config, origin: () => string): () => Promise<PaidWrapper> {
  let built: Promise<PaidWrapper> | undefined;
  return () =>
    (built ??= (async () => {
      const rs = new x402ResourceServer(new HTTPFacilitatorClient({ url: cfg.facilitatorUrl, timeoutMs: 20_000 })).register(cfg.network, new ExactEvmScheme());
      await rs.initialize();
      const accepts = await rs.buildPaymentRequirements({ scheme: "exact", network: cfg.network, payTo: cfg.payTo, price: cfg.priceSingle });
      return createPaymentWrapper(rs, {
        accepts,
        resource: {
          url: "mcp://tool/check_base_token",
          description: SINGLE_DESCRIPTION,
          mimeType: "application/json",
          serviceName: SERVICE_NAME,
          tags: ["base", "token-risk", "honeypot", "mcp"],
          iconUrl: `${origin()}/favicon.svg`,
        },
      }) as unknown as PaidWrapper;
    })().catch((e) => {
      built = undefined;
      throw e;
    }));
}
