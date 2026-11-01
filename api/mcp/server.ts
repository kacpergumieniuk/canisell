/**
 * MCP server (stdio) exposing one tool, `check_base_token(address)`.
 *
 * It calls the paid HTTP API (GET {VERDICT_API_URL}/v1/verdict/{address}) and returns the verdict JSON.
 * @x402/mcp is for MCP servers that charge MCP clients directly; stdio hosts such as Claude Desktop or
 * Cursor cannot pay, so this server acts as the x402 client instead.
 *
 * Env:
 *   VERDICT_API_URL   base URL of the API (default http://localhost:8787)
 *   EVM_PRIVATE_KEY   OPTIONAL 0x-prefixed key of a funded USDC wallet that pays per call. Supply a
 *                     dedicated low-balance wallet. Without it, the tool reports the 402 payment terms.
 *   MAX_PAYMENT_USD   per-call spend cap (default 0.05)
 *
 * stdout is the MCP channel; all logging goes to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { pathToFileURL } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";

export const TOOL_NAME = "check_base_token";
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export interface McpOptions {
  baseUrl: string;
  /** 0x-prefixed private key of the paying wallet; omit for unpaid (402-info) mode. */
  privateKey?: string;
  /** Alternative to privateKey (used by tests): any x402 EVM client signer. */
  signer?: Parameters<typeof registerExactEvmScheme>[1]["signer"];
  maxPaymentUsd?: number;
  fetchImpl?: typeof fetch;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const out = (v: unknown, isError = false): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(v, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

function makePayer(opts: McpOptions) {
  let signer = opts.signer;
  if (!signer && opts.privateKey) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(opts.privateKey)) throw new Error("EVM_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key");
    signer = privateKeyToAccount(opts.privateKey as `0x${string}`);
  }
  if (!signer) return undefined;
  const client = new x402Client();
  registerExactEvmScheme(client, { signer });
  client.setSpendControls({ maxAmountPerPayment: `$${opts.maxPaymentUsd ?? 0.05}` });
  return { http: new x402HTTPClient(client) };
}

export function buildServer(opts: McpOptions) {
  const f = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, "");
  const payer = makePayer(opts);

  async function fetchVerdict(address: string): Promise<ToolResult> {
    const url = `${base}/v1/verdict/${address}`;
    let res = await f(url, { headers: { accept: "application/json" } });
    let paid = false;

    if (res.status === 402) {
      const bodyText = await res.text();
      let body: unknown;
      try {
        body = JSON.parse(bodyText);
      } catch {
        /* header-only 402 */
      }
      const required = (() => {
        try {
          return (payer?.http ?? new x402HTTPClient(new x402Client())).getPaymentRequiredResponse((n) => res.headers.get(n), body);
        } catch {
          return undefined;
        }
      })();
      if (!payer) {
        return out(
          {
            error: "payment_required",
            message: "This API costs USDC per call (x402). Set EVM_PRIVATE_KEY in the MCP server env to a funded wallet to pay automatically.",
            accepts: required?.accepts,
          },
          true,
        );
      }
      if (!required) return out({ error: "payment_required", message: "Could not parse 402 payment requirements" }, true);
      const payload = await payer.http.createPaymentPayload(required);
      res = await f(url, { headers: { accept: "application/json", ...payer.http.encodePaymentSignatureHeader(payload) } });
      paid = true;
    }

    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text.slice(0, 500) };
    }
    if (!res.ok) return out({ error: `HTTP ${res.status}`, detail: json, ...(paid && res.status === 402 ? { message: "Payment was not accepted" } : {}) }, true);
    if (paid) {
      try {
        const s = payer!.http.getPaymentSettleResponse((n) => res.headers.get(n));
        (json as Record<string, unknown>).payment = { transaction: s.transaction, network: s.network, payer: s.payer };
      } catch {
        /* no settlement header */
      }
    }
    return out(json);
  }

  const server = new McpServer({ name: "base-token-verdict", version: "0.1.0" });
  server.registerTool(
    TOOL_NAME,
    {
      description:
        "Pre-trade risk check for a Base (chain 8453) ERC-20 token. Simulates buy+sell (honeypot, taxes), inspects owner powers, proxy, liquidity and LP lock, token age and creator history. Returns a SAFE / CAUTION / DANGER verdict, a 0-100 score and reasons. Costs about $0.01 USDC per call (x402). Not financial advice.",
      inputSchema: { address: z.string().regex(ADDRESS_RE, "must be a 0x-prefixed 20-byte address").describe("Base ERC-20 token contract address") },
    },
    async ({ address }) => {
      try {
        return await fetchVerdict(address);
      } catch (e) {
        return out({ error: "request_failed", message: (e as Error).message }, true);
      }
    },
  );
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const baseUrl = process.env.VERDICT_API_URL ?? "http://localhost:8787";
  const server = buildServer({
    baseUrl,
    privateKey: process.env.EVM_PRIVATE_KEY,
    maxPaymentUsd: process.env.MAX_PAYMENT_USD ? Number(process.env.MAX_PAYMENT_USD) : undefined,
  });
  await server.connect(new StdioServerTransport());
  console.error(`[mcp] ready: ${TOOL_NAME} -> ${baseUrl} (${process.env.EVM_PRIVATE_KEY ? "paying wallet configured" : "no wallet: unpaid mode"})`);
}
