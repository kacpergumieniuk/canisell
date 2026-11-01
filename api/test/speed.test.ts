import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createApp } from "../src/app.ts";
import { workersEdgeCache } from "../src/cache.ts";
import { loadConfig } from "../src/config.ts";
import { clearCreationCache, type VerdictResponse } from "../src/risk/verdict.ts";
import { plausiblePayment } from "../src/x402.ts";
import { noPoolSpec, TOKEN, zoraSpec } from "./helpers/engineMock.ts";
import { mockClients, type MockSpec } from "./helpers/mockRpc.ts";

const URL_ = `http://local/v1/verdict/${TOKEN}`;
const cfg = loadConfig({});
const PAYER = "0x0000000000000000000000000000000000000001";

type Facilitator = { verifyDelayMs?: number; settleOk?: boolean };
const facilitatorLog: Array<{ what: string; at: number }> = [];

function stubFacilitator(f: Facilitator = {}) {
  facilitatorLog.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/supported"))
        return Response.json({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }], extensions: ["bazaar"], signers: {} });
      if (u.endsWith("/verify")) {
        facilitatorLog.push({ what: "verify-start", at: Date.now() });
        if (f.verifyDelayMs) await new Promise((r) => setTimeout(r, f.verifyDelayMs));
        facilitatorLog.push({ what: "verify-end", at: Date.now() });
        return Response.json({ isValid: true, payer: PAYER });
      }
      if (u.endsWith("/settle")) {
        facilitatorLog.push({ what: "settle", at: Date.now() });
        return f.settleOk === false
          ? Response.json({ success: false, errorReason: "insufficient_funds", transaction: "", network: "eip155:84532" })
          : Response.json({ success: true, transaction: "0xabc", network: "eip155:84532", payer: PAYER });
      }
      throw new Error(`unexpected fetch ${u}`);
    }),
  );
}

/** A real x402 client with a throwaway key: signs locally, never funded. */
async function paymentHeaders(app: ReturnType<typeof createApp>, url = URL_) {
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: privateKeyToAccount(generatePrivateKey()) });
  const http = new x402HTTPClient(client);
  const first = await app.request(url, { headers: { accept: "application/json" } });
  expect(first.status).toBe(402);
  const required = http.getPaymentRequiredResponse((n) => first.headers.get(n), await first.json());
  return http.encodePaymentSignatureHeader(await client.createPaymentPayload(required));
}
const paidGet = async (app: ReturnType<typeof createApp>) => app.request(URL_, { headers: { accept: "application/json", ...(await paymentHeaders(app)) } });

/** Mock chain that records when the engine first touches the RPC and how often. */
function spied(spec: MockSpec) {
  const log: Array<{ method: string; params: any }> = [];
  const state = { firstRpcAt: 0 };
  const wrapped: MockSpec = {
    ...spec,
    code: (a, b) => ((state.firstRpcAt ||= Date.now()), spec.code?.(a, b) ?? "0x"),
  };
  return { clients: mockClients(wrapped, log), log, state };
}
const count = (log: Array<{ method: string }>, method: string) => log.filter((l) => l.method === method).length;

beforeEach(() => clearCreationCache());
afterEach(() => vi.unstubAllGlobals());

describe("pre-computing the verdict while the payment is being verified", () => {
  it("starts the engine before the facilitator has finished verifying, and runs it only once", async () => {
    stubFacilitator({ verifyDelayMs: 300 });
    const { clients, log, state } = spied(zoraSpec());
    const app = createApp(cfg, { clients });
    const r = await paidGet(app);
    expect(r.status).toBe(200);
    expect(((await r.json()) as VerdictResponse).verdict).toBeDefined();
    const verifyEnd = facilitatorLog.find((l) => l.what === "verify-end")!.at;
    expect(state.firstRpcAt).toBeGreaterThan(0);
    expect(state.firstRpcAt).toBeLessThan(verifyEnd - 150); // engine was running well before verification came back
    expect(count(log, "eth_blockNumber")).toBe(1); // the speculative run was reused, not repeated
  });

  it("still releases the verdict only after settlement: a failed settle gives a 402 and no body", async () => {
    stubFacilitator({ settleOk: false });
    const { clients } = spied(zoraSpec());
    const app = createApp(cfg, { clients });
    const r = await paidGet(app);
    const text = await r.text();
    expect(r.status).toBe(402);
    expect(text).not.toContain("verdict");
    expect(text).not.toContain("score");
  });

  it("an unpaid request, a garbage header and a payment for someone else never start the engine", async () => {
    stubFacilitator();
    const { clients, log } = spied(zoraSpec());
    const app = createApp(cfg, { clients });
    expect((await app.request(URL_)).status).toBe(402);
    expect((await app.request(URL_, { headers: { "payment-signature": "not-base64-json" } })).status).toBe(402);
    const elsewhere = Buffer.from(JSON.stringify({ x402Version: 2, accepted: { network: cfg.network, payTo: "0x000000000000000000000000000000000000dEaD" }, payload: {} })).toString("base64");
    await app.request(URL_, { headers: { "payment-signature": elsewhere } });
    expect(log).toHaveLength(0);
  });

  it("a failing check is a 502 and is not settled, even though it was started early", async () => {
    stubFacilitator();
    const { clients } = spied(noPoolSpec({ fail: (m, p) => m === "eth_call" && p[0].to.toLowerCase() === TOKEN }));
    const app = createApp(cfg, { clients });
    const r = await paidGet(app);
    expect(r.status).toBe(502);
    expect(facilitatorLog.map((l) => l.what)).not.toContain("settle");
  });
});

describe("verdict caching", () => {
  it("a second paid call for the same token is served from memory without touching the RPC again", async () => {
    stubFacilitator();
    const { clients, log } = spied(zoraSpec());
    const app = createApp(cfg, { clients });
    const first = await paidGet(app);
    expect(first.status).toBe(200);
    expect(first.headers.get("server-timing")).toMatch(/cache;desc="miss"/);
    const calls = log.length;
    const second = await paidGet(app);
    expect(second.status).toBe(200);
    expect(second.headers.get("server-timing")).toMatch(/cache;desc="memory"/);
    expect(log.length).toBe(calls);
  });

  it("a cached verdict is still not released without settlement", async () => {
    stubFacilitator();
    const { clients } = spied(zoraSpec());
    const app = createApp(cfg, { clients });
    expect((await paidGet(app)).status).toBe(200); // warms the cache
    stubFacilitator({ settleOk: false });
    const r = await paidGet(app);
    expect(r.status).toBe(402);
    expect(await r.text()).not.toContain("verdict");
  });

  it("another isolate (empty memory) is served from the Cache API store", async () => {
    stubFacilitator();
    const store = new Map<string, Response>();
    const edgeStore = { match: async (req: Request) => store.get(req.url)?.clone(), put: async (req: Request, res: Response) => void store.set(req.url, res) };
    const a = spied(zoraSpec());
    expect((await paidGet(createApp(cfg, { clients: a.clients, edgeStore }))).status).toBe(200);
    expect(store.size).toBe(1);

    const b = spied(zoraSpec());
    const r = await paidGet(createApp(cfg, { clients: b.clients, edgeStore }));
    expect(r.status).toBe(200);
    expect(r.headers.get("server-timing")).toMatch(/cache;desc="edge"/);
    expect(b.log).toHaveLength(0);
  });

  it("the Cache API wrapper is a quiet no-op where the runtime has no cache", async () => {
    const c = workersEdgeCache<{ a: number }>(60, "t", undefined);
    await c.put("k", { a: 1 });
    expect(await c.get("k")).toBeUndefined();
  });
});

describe("plausiblePayment", () => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
  it("accepts a payload naming this network and payee, rejects the rest", () => {
    expect(plausiblePayment(b64({ accepted: { network: cfg.network, payTo: cfg.payTo }, payload: { signature: "0x" } }), cfg)).toBe(true);
    expect(plausiblePayment(b64({ accepted: { network: cfg.network, payTo: cfg.payTo.toLowerCase() }, payload: {} }), cfg)).toBe(true);
    expect(plausiblePayment(b64({ accepted: { network: "eip155:8453", payTo: cfg.payTo }, payload: {} }), cfg)).toBe(false);
    expect(plausiblePayment(b64({ accepted: { network: cfg.network, payTo: PAYER }, payload: {} }), cfg)).toBe(false);
    expect(plausiblePayment(b64({ accepted: { network: cfg.network, payTo: cfg.payTo } }), cfg)).toBe(false);
    expect(plausiblePayment("%%%", cfg)).toBe(false);
    expect(plausiblePayment(undefined, cfg)).toBe(false);
    expect(plausiblePayment("a".repeat(20_000), cfg)).toBe(false);
  });
});
