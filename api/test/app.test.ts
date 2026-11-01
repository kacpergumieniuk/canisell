import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { NotTokenError, type VerdictResponse } from "../src/risk/verdict.ts";
import { SAMPLE_VERDICT } from "../src/sample.ts";
import { mockClients } from "./helpers/mockRpc.ts";

const ADDR = "0x532f27101965dd16442E59d40670FaF5eBB142E4";
const passThrough = async (_c: unknown, next: () => Promise<void>) => next();
const fake = (address: string) => ({ ...(SAMPLE_VERDICT as unknown as VerdictResponse), address }) as VerdictResponse;

describe("HTTP app (payment stubbed)", () => {
  const app = createApp(loadConfig({}), { check: async (a) => fake(a), payment: passThrough as any, clients: mockClients({}) });

  it("serves free endpoints", async () => {
    expect((await app.request("/")).status).toBe(200);
    expect(((await (await app.request("/v1/sample")).json()) as any).verdict).toBeDefined();
    const h = await app.request("/v1/health");
    expect(h.status).toBe(200);
  });

  it("validates addresses before the paywall", async () => {
    expect((await app.request("/v1/verdict/0x1234")).status).toBe(400);
    expect((await app.request("/v1/verdict/batch")).status).toBe(405);
  });

  it("returns a verdict", async () => {
    const r = await app.request(`/v1/verdict/${ADDR}`);
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).address).toBe(ADDR);
  });

  it("batch: validates size and dedupes", async () => {
    const post = (body: unknown) => app.request("/v1/verdict/batch", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    expect((await post({ addresses: [] })).status).toBe(400);
    expect((await post({ addresses: Array(11).fill(ADDR) })).status).toBe(400);
    expect((await post({ addresses: ["nope"] })).status).toBe(400);
    const r = await post({ addresses: [ADDR, ADDR.toLowerCase()] });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).results).toHaveLength(1);
  });

  it("maps non-token errors to 422 (so the payment is not settled)", async () => {
    const a = createApp(loadConfig({}), {
      check: async () => {
        throw new NotTokenError("Address has no contract code on Base");
      },
      payment: passThrough as any,
      clients: mockClients({}),
    });
    expect((await a.request(`/v1/verdict/${ADDR}`)).status).toBe(422);
  });
});

describe("x402 paywall (facilitator stubbed)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("unpaid request gets 402 with exact/Base Sepolia USDC requirements and Bazaar metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        if (String(url).endsWith("/supported"))
          return Response.json({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }], extensions: ["bazaar"], signers: {} });
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    let checked = false;
    const app = createApp(loadConfig({}), {
      check: async (a) => {
        checked = true;
        return fake(a);
      },
      clients: mockClients({}),
    });
    const r = await app.request(`/v1/verdict/${ADDR}`, { headers: { accept: "application/json" } });
    expect(r.status).toBe(402);
    expect(checked).toBe(false);
    const header = r.headers.get("payment-required");
    expect(header).toBeTruthy();
    const req = JSON.parse(atob(header!));
    expect(req.x402Version).toBe(2);
    expect(req.accepts[0]).toMatchObject({
      scheme: "exact",
      network: "eip155:84532",
      amount: "10000",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      payTo: "0x741f78ED943C671e25405dAAaAB7b6886C7e8feb",
    });
    expect(req.extensions.bazaar.info.input.pathParams.address).toBe(ADDR);
  });
});
