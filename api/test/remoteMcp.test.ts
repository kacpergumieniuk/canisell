import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapMCPClientWithPayment } from "@x402/mcp";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { readTokenInfo } from "../src/mcp.ts";
import type { VerdictResponse } from "../src/risk/verdict.ts";
import { SAMPLE_VERDICT } from "../src/sample.ts";
import { mockClient, mockClients, sel } from "./helpers/mockRpc.ts";
import { encodeAbiParameters, type Hex } from "viem";

const ADDR = "0x532f27101965dd16442E59d40670FaF5eBB142E4";
const MCP_URL = "http://local/mcp";
const MARKER = "MCP-VERDICT-MARKER";
const JSON_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

const facilitatorCalls: string[] = [];
let settleOk = true;

/** Mocked x402 facilitator: nothing leaves the process. */
function stubFacilitator() {
  facilitatorCalls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      facilitatorCalls.push(u.split("/").pop()!);
      if (u.endsWith("/supported"))
        return Response.json({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }], extensions: ["bazaar"], signers: {} });
      if (u.endsWith("/verify")) return Response.json({ isValid: true, payer: "0x0000000000000000000000000000000000000001" });
      if (u.endsWith("/settle"))
        return settleOk
          ? Response.json({ success: true, transaction: "0xabc", network: "eip155:84532", payer: "0x0000000000000000000000000000000000000001" })
          : Response.json({ success: false, errorReason: "insufficient_funds", transaction: "", network: "eip155:84532" });
      throw new Error(`unexpected fetch ${u}`);
    }),
  );
}

function makeApp() {
  const state = { checks: 0, infos: 0 };
  const app = createApp(loadConfig({}), {
    check: async (a) => {
      state.checks++;
      return { ...(SAMPLE_VERDICT as unknown as VerdictResponse), address: a, summary: MARKER } as VerdictResponse;
    },
    tokenInfo: async (a) => {
      state.infos++;
      return { address: a, chain: "base", isContract: true, codeSize: 1234, isErc20: true, name: "Test", symbol: "TST", decimals: 18, totalSupply: "1000" };
    },
    clients: mockClients({}),
  });
  return { app, state };
}

/** An MCP SDK client whose HTTP goes straight into the Hono app (no sockets). */
async function connect(app: ReturnType<typeof createApp>) {
  const client = new Client({ name: "test", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    fetch: async (input, init) => app.request(String(input), init as RequestInit),
  });
  await client.connect(transport);
  return client;
}

const rpc = (app: ReturnType<typeof createApp>, body: unknown) =>
  app.request(MCP_URL, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });

describe("remote MCP endpoint /mcp (Streamable HTTP, stateless)", () => {
  beforeEach(() => {
    settleOk = true;
    stubFacilitator();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("initialize over raw JSON-RPC returns server info and tools capability, no session id", async () => {
    const { app } = makeApp();
    const r = await rpc(app, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "curl", version: "0" } },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("mcp-session-id")).toBeNull();
    const body: any = await r.json();
    expect(body.result.serverInfo.name).toBe("canisell");
    expect(body.result.capabilities.tools).toBeDefined();
    expect(body.result.instructions).toContain("check_base_token");
  });

  it("tools/list works without initialize (stateless) and lists the paid and free tools", async () => {
    const { app } = makeApp();
    const r = await rpc(app, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(r.status).toBe(200);
    const names = ((await r.json()) as any).result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(["check_base_token", "explain_verdict_fields", "get_sample_verdict", "get_token_info"]);
  });

  it("free tools answer through the MCP SDK client", async () => {
    const { app, state } = makeApp();
    const client = await connect(app);
    const tools = await client.listTools();
    const paid = tools.tools.find((t) => t.name === "check_base_token")!;
    expect(paid.annotations?.readOnlyHint).toBe(true);
    expect(paid.description).toContain("$0.01");

    const info = await client.callTool({ name: "get_token_info", arguments: { address: ADDR } });
    expect(info.isError).toBeFalsy();
    const parsed = JSON.parse((info.content as { text: string }[])[0].text);
    expect(parsed).toMatchObject({ symbol: "TST", isErc20: true, decimals: 18 });
    expect(state.infos).toBe(1);

    const sample = await client.callTool({ name: "get_sample_verdict", arguments: {} });
    expect(JSON.parse((sample.content as { text: string }[])[0].text).verdict).toBe(SAMPLE_VERDICT.verdict);

    const guide = await client.callTool({ name: "explain_verdict_fields", arguments: {} });
    expect((guide.content as { text: string }[])[0].text).toContain("DANGER");

    const bad = await client.callTool({ name: "get_token_info", arguments: { address: "0x123" } });
    expect(bad.isError).toBe(true);
    expect(state.checks).toBe(0);
    await client.close();
  });

  it("paid tool without payment returns x402 payment terms and the paid HTTP URL, never a verdict", async () => {
    const { app, state } = makeApp();
    const client = await connect(app);
    const r = await client.callTool({ name: "check_base_token", arguments: { address: ADDR } });
    expect(r.isError).toBe(true);
    const content = r.content as { text: string }[];
    const required = JSON.parse(content[0].text);
    expect(required.x402Version).toBe(2);
    expect(required.accepts[0]).toMatchObject({ scheme: "exact", network: "eip155:84532", payTo: loadConfig({}).payTo, amount: "10000" });
    expect(r.structuredContent).toMatchObject({ x402Version: 2 });
    expect(content[1].text).toContain(`/v1/verdict/${ADDR}`);
    expect(content[1].text).toContain("@x402/fetch");
    expect(JSON.stringify(r)).not.toContain(MARKER);
    expect(state.checks).toBe(0);
    expect(facilitatorCalls).not.toContain("verify");
    expect(facilitatorCalls).not.toContain("settle");
    await client.close();
  });

  it("paid tool with an x402 MCP payment verifies, runs the check and settles", async () => {
    const { app, state } = makeApp();
    const payer = new x402Client();
    registerExactEvmScheme(payer, { signer: privateKeyToAccount(generatePrivateKey()) }); // throwaway, never funded
    const paying = wrapMCPClientWithPayment(await connect(app), payer, { autoPayment: true });
    const r = await paying.callTool("check_base_token", { address: ADDR });
    expect(r.isError).toBeFalsy();
    expect((r.content as unknown as { text: string }[])[0].text).toContain(MARKER);
    expect(facilitatorCalls).toEqual(expect.arrayContaining(["verify", "settle"]));
    expect(state.checks).toBe(1);
  });

  it("paid tool: a failed settlement returns no verdict", async () => {
    settleOk = false;
    const { app } = makeApp();
    const payer = new x402Client();
    registerExactEvmScheme(payer, { signer: privateKeyToAccount(generatePrivateKey()) });
    const paying = wrapMCPClientWithPayment(await connect(app), payer, { autoPayment: true });
    const r = await paying.callTool("check_base_token", { address: ADDR }).catch((e: Error) => ({ thrown: e.message }));
    expect(JSON.stringify(r)).not.toContain(MARKER);
  });

  it("paid tool: facilitator unreachable -> still returns honest payment instructions", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    const { app, state } = makeApp();
    const client = await connect(app);
    const r = await client.callTool({ name: "check_base_token", arguments: { address: ADDR } });
    expect(r.isError).toBe(true);
    expect((r.content as { text: string }[])[0].text).toContain("$0.01 USDC");
    expect(state.checks).toBe(0);
  });

  it("GET /mcp describes the endpoint; SSE GET and DELETE get 405", async () => {
    const { app } = makeApp();
    const info = await app.request(MCP_URL);
    expect(info.status).toBe(200);
    expect(((await info.json()) as any).clientConfig.mcpServers.canisell.url).toBe("http://local/mcp");
    expect((await app.request(MCP_URL, { headers: { accept: "text/event-stream" } })).status).toBe(405);
    expect((await app.request(MCP_URL, { method: "DELETE" })).status).toBe(405);
  });

  it("/mcp is listed in discovery (root, llms.txt, OpenAPI)", async () => {
    const { app } = makeApp();
    const root: any = await (await app.request("http://local/")).json();
    expect(root.endpoints.some((e: { path: string }) => e.path === "/mcp")).toBe(true);
    expect(await (await app.request("http://local/llms.txt")).text()).toContain("http://local/mcp");
    const oa: any = await (await app.request("http://local/openapi.json")).json();
    expect(oa.paths["/mcp"].post.security).toEqual([]);
  });
});

describe("readTokenInfo (mocked RPC)", () => {
  const word = (types: { type: string }[], values: unknown[]) => encodeAbiParameters(types, values) as Hex;
  it("reads ERC-20 metadata for a contract", async () => {
    const client = mockClient({
      code: () => "0x6080604052",
      call: ({ data }) => {
        // mockClient has no multicall batching, so each getter arrives as its own eth_call.
        const s = data.slice(0, 10);
        if (s === sel("name()")) return word([{ type: "string" }], ["Test Token"]);
        if (s === sel("symbol()")) return word([{ type: "string" }], ["TST"]);
        if (s === sel("decimals()")) return word([{ type: "uint8" }], [18]);
        if (s === sel("totalSupply()")) return word([{ type: "uint256" }], [10n ** 21n]);
        return undefined;
      },
    });
    const info = await readTokenInfo(client, ADDR);
    expect(info).toMatchObject({ isContract: true, isErc20: true, name: "Test Token", symbol: "TST", decimals: 18, totalSupply: "1000000000000000000000", codeSize: 5 });
  });

  it("an address without code is not a contract", async () => {
    const info = await readTokenInfo(mockClient({}), ADDR);
    expect(info).toMatchObject({ isContract: false, isErc20: false, name: null, totalSupply: null });
  });
});
