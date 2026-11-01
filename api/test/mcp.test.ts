import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { VerdictResponse } from "../src/risk/verdict.ts";
import { SAMPLE_VERDICT } from "../src/sample.ts";
import { buildServer } from "../mcp/server.ts";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mockClients } from "./helpers/mockRpc.ts";

const ADDR = "0x532f27101965dd16442E59d40670FaF5eBB142E4";
const realFetch = globalThis.fetch;
const textOf = (r: any) => JSON.parse(r.content[0].text);

describe("MCP stdio server against a locally running API (real paywall, facilitator stubbed)", () => {
  let httpServer: ReturnType<typeof serve>;
  let baseUrl: string;
  let client: Client;

  beforeAll(async () => {
    // Only the facilitator's /supported call is faked; localhost traffic passes through.
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/supported"))
        return Response.json({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }], extensions: ["bazaar"], signers: {} });
      return realFetch(url as any, init);
    });
    const app = createApp(loadConfig({}), { check: async (a) => ({ ...(SAMPLE_VERDICT as unknown as VerdictResponse), address: a }) as VerdictResponse, clients: mockClients({}) });
    httpServer = serve({ fetch: app.fetch, port: 0 });
    await new Promise((r) => httpServer.once("listening", r));
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

    client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: "npx",
        args: ["tsx", "mcp/server.ts"],
        env: { PATH: process.env.PATH ?? "", VERDICT_API_URL: baseUrl },
        stderr: "ignore",
      }),
    );
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    httpServer?.close();
    vi.unstubAllGlobals();
  });

  it("lists exactly the check_base_token tool", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["check_base_token"]);
    expect(tools[0].inputSchema.required).toEqual(["address"]);
  });

  it("an unpaid call returns the 402 payment terms", async () => {
    const r = await client.callTool({ name: "check_base_token", arguments: { address: ADDR } });
    expect(r.isError).toBe(true);
    const body = textOf(r);
    expect(body.error).toBe("payment_required");
    expect(body.accepts[0]).toMatchObject({ scheme: "exact", network: "eip155:84532", amount: "10000" });
  });

  it("rejects malformed addresses", async () => {
    await expect(client.callTool({ name: "check_base_token", arguments: { address: "0x12" } })).resolves.toMatchObject({ isError: true });
  });
});

describe("MCP payment flow (in-process, stub signer, stub API)", () => {
  // Stub signer: produces a well-formed dummy signature; no key material involved.
  const signer = { address: "0x000000000000000000000000000000000000dEaD" as const, signTypedData: async () => ("0x" + "11".repeat(65)) as `0x${string}` };
  const requirements = {
    scheme: "exact",
    network: "eip155:84532",
    amount: "10000",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    payTo: "0x741f78ED943C671e25405dAAaAB7b6886C7e8feb",
    maxTimeoutSeconds: 60,
    extra: { name: "USDC", version: "2" },
  };
  const paymentRequired = { x402Version: 2, error: "Payment required", resource: { url: "http://api/v1/verdict/x" }, accepts: [requirements] };

  async function connect(fetchImpl: typeof fetch, over: object = {}) {
    const server = buildServer({ baseUrl: "http://api", fetchImpl, signer, ...over });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    return client;
  }

  it("answers 402 with a signed payment header and returns the verdict + settlement", async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const h = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
      seen.push(h);
      const sig = h["PAYMENT-SIGNATURE"] ?? h["payment-signature"];
      if (!sig) return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": btoa(JSON.stringify(paymentRequired)) } });
      const payload = JSON.parse(atob(sig));
      expect(payload.accepted.amount).toBe("10000");
      return Response.json(SAMPLE_VERDICT, {
        headers: { "PAYMENT-RESPONSE": btoa(JSON.stringify({ success: true, transaction: "0xabc", network: "eip155:84532", payer: signer.address })) },
      });
    }) as unknown as typeof fetch;
    const client = await connect(fetchImpl);
    const r = textOf(await client.callTool({ name: "check_base_token", arguments: { address: ADDR } }));
    expect(seen).toHaveLength(2);
    expect(r.verdict).toBe("SAFE");
    expect(r.payment).toMatchObject({ transaction: "0xabc" });
  });

  it("refuses to pay above the spend cap", async () => {
    const fetchImpl = (async () => new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": btoa(JSON.stringify(paymentRequired)) } })) as unknown as typeof fetch;
    const client = await connect(fetchImpl, { maxPaymentUsd: 0.001 });
    const r: any = await client.callTool({ name: "check_base_token", arguments: { address: ADDR } });
    expect(r.isError).toBe(true);
    expect(textOf(r).error).toBe("request_failed");
  });
});
