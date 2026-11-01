import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { VerdictResponse } from "../src/risk/verdict.ts";
import { SAMPLE_VERDICT } from "../src/sample.ts";
import { requireSettlement } from "../src/x402.ts";
import { mockClients } from "./helpers/mockRpc.ts";

const ADDR = "0x532f27101965dd16442E59d40670FaF5eBB142E4";
const URL_ = `http://local/v1/verdict/${ADDR}`;
const VERDICT_MARKER = "NO-LEAK-MARKER-" + SAMPLE_VERDICT.summary.slice(0, 20);

type Facilitator = { verify: () => Response | Promise<Response>; settle: () => Response | Promise<Response> };
const calls: string[] = [];

/** Mocked x402 facilitator: nothing leaves the process. */
function stubFacilitator(f: Facilitator) {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      calls.push(u.split("/").pop()!);
      if (u.endsWith("/supported"))
        return Response.json({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }], extensions: ["bazaar"], signers: {} });
      if (u.endsWith("/verify")) return f.verify();
      if (u.endsWith("/settle")) return f.settle();
      throw new Error(`unexpected fetch ${u}`);
    }),
  );
}

const verifyOk = () => Response.json({ isValid: true, payer: "0x0000000000000000000000000000000000000001" });
const settleOk = () => Response.json({ success: true, transaction: "0xabc", network: "eip155:84532", payer: "0x0000000000000000000000000000000000000001" });

function makeApp() {
  const state = { handlerCalls: 0 };
  const app = createApp(loadConfig({}), {
    check: async (a) => {
      state.handlerCalls++;
      return { ...(SAMPLE_VERDICT as unknown as VerdictResponse), address: a, summary: VERDICT_MARKER } as VerdictResponse;
    },
    clients: mockClients({}),
  });
  return { app, state };
}

/** Plays an x402 client with a throwaway in-memory key (signs locally, never funded, never printed). */
async function paidGet(app: ReturnType<typeof createApp>) {
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: privateKeyToAccount(generatePrivateKey()) });
  const http = new x402HTTPClient(client);
  const first = await app.request(URL_, { headers: { accept: "application/json" } });
  expect(first.status).toBe(402);
  const required = http.getPaymentRequiredResponse((n) => first.headers.get(n), await first.json());
  const headers = http.encodePaymentSignatureHeader(await client.createPaymentPayload(required));
  return app.request(URL_, { headers: { accept: "application/json", ...headers } });
}

describe("x402 gating: content only after verify AND settle (facilitator mocked)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("verify ok + settle fails (e.g. unfunded payer, facilitator verify does not check balance) -> 402, no verdict body", async () => {
    stubFacilitator({
      verify: verifyOk,
      settle: () => Response.json({ success: false, errorReason: "insufficient_funds", transaction: "", network: "eip155:84532" }),
    });
    const { app } = makeApp();
    const r = await paidGet(app);
    const text = await r.text();
    expect(calls).toEqual(expect.arrayContaining(["verify", "settle"]));
    expect(r.status).toBe(402);
    expect(text).not.toContain(VERDICT_MARKER);
    expect(text).not.toContain("verdict");
    expect(text).not.toContain("score");
    // the receipt must say it failed
    const receipt = JSON.parse(Buffer.from(r.headers.get("payment-response")!, "base64").toString());
    expect(receipt.success).toBe(false);
  });

  it("verify ok + settle endpoint errors out (HTTP 500) -> not 200, no verdict body", async () => {
    stubFacilitator({ verify: verifyOk, settle: () => new Response("boom", { status: 500 }) });
    const { app } = makeApp();
    const r = await paidGet(app);
    const text = await r.text();
    expect(r.status).toBeGreaterThanOrEqual(402);
    expect(r.status).not.toBe(200);
    expect(text).not.toContain(VERDICT_MARKER);
  });

  it("verify rejects (insufficient balance) -> 402 and the handler never runs", async () => {
    stubFacilitator({
      verify: () => Response.json({ isValid: false, invalidReason: "invalid_exact_evm_insufficient_balance" }),
      settle: () => {
        throw new Error("settle must not be called");
      },
    });
    const { app, state } = makeApp();
    const r = await paidGet(app);
    expect(r.status).toBe(402);
    expect(calls).not.toContain("settle");
    expect(state.handlerCalls).toBe(0);
    expect(await r.text()).not.toContain(VERDICT_MARKER);
  });

  it("verify ok + settle ok -> 200 with the verdict and a settlement receipt (positive control)", async () => {
    stubFacilitator({ verify: verifyOk, settle: settleOk });
    const { app } = makeApp();
    const r = await paidGet(app);
    expect(r.status).toBe(200);
    expect(((await r.json()) as VerdictResponse).summary).toBe(VERDICT_MARKER);
    const receipt = JSON.parse(Buffer.from(r.headers.get("payment-response")!, "base64").toString());
    expect(receipt).toMatchObject({ success: true, transaction: "0xabc" });
    // phase timings ride along: facilitator verify and settle are measured by the x402 hooks
    const st = r.headers.get("server-timing") ?? "";
    expect(st).toMatch(/verify;dur=[\d.]+/);
    expect(st).toMatch(/settle;dur=[\d.]+/);
    expect(st).toMatch(/total;dur=[\d.]+/);
  });

  it("a handler error (>=400) is not settled", async () => {
    stubFacilitator({ verify: verifyOk, settle: settleOk });
    const app = createApp(loadConfig({}), {
      check: async () => {
        throw new Error("rpc down");
      },
      clients: mockClients({}),
    });
    const r = await paidGet(app);
    expect(r.status).toBe(502);
    expect(calls).not.toContain("settle");
  });

  it("no paid route answers 2xx without a payment header, whatever the method or path form", async () => {
    stubFacilitator({ verify: verifyOk, settle: settleOk });
    const { app, state } = makeApp();
    const reqs: [string, string, unknown?][] = [
      ["GET", `/v1/verdict/${ADDR}`],
      ["HEAD", `/v1/verdict/${ADDR}`],
      ["GET", `/v1/verdict/${ADDR}/`],
      ["GET", `/v1/verdict/${ADDR}?x=1`],
      ["GET", `/v1/verdict/${ADDR.toLowerCase()}`],
      ["POST", "/v1/verdict/batch", { addresses: [ADDR] }],
      ["POST", "/v1/verdict/batch/", { addresses: [ADDR] }],
    ];
    for (const [method, path, body] of reqs) {
      const r = await app.request(path, {
        method,
        headers: { accept: "application/json", "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      expect(r.status, `${method} ${path}`).toBe(402);
    }
    expect(state.handlerCalls).toBe(0);
  });

  it("unpaid requests always get the 402, even with a malformed address or body (x402scan probes literal {address})", async () => {
    stubFacilitator({ verify: verifyOk, settle: settleOk });
    const { app, state } = makeApp();
    const post = (body?: string) =>
      app.request("/v1/verdict/batch", { method: "POST", headers: { "content-type": "application/json" }, body });
    expect((await post()).status).toBe(402);
    expect((await post("{not json")).status).toBe(402);
    expect((await post(JSON.stringify({ addresses: [] }))).status).toBe(402);
    expect((await app.request("/v1/verdict/%7Baddress%7D")).status).toBe(402);
    expect((await app.request("/v1/verdict/not-an-address")).status).toBe(402);
    expect(state.handlerCalls).toBe(0);
  });

  it("a paid request with a malformed address gets a 400 and is never settled", async () => {
    stubFacilitator({ verify: verifyOk, settle: settleOk });
    const { app, state } = makeApp();
    const client = new x402Client();
    registerExactEvmScheme(client, { signer: privateKeyToAccount(generatePrivateKey()) });
    const http = new x402HTTPClient(client);
    const first = await app.request("/v1/verdict/not-an-address", { headers: { accept: "application/json" } });
    expect(first.status).toBe(402);
    const required = http.getPaymentRequiredResponse((n) => first.headers.get(n), await first.json());
    const headers = http.encodePaymentSignatureHeader(await client.createPaymentPayload(required));
    const r = await app.request("/v1/verdict/not-an-address", { headers: { accept: "application/json", ...headers } });
    expect(r.status).toBe(400);
    expect(calls).not.toContain("settle");
    expect(state.handlerCalls).toBe(0);
  });

  it("a paid batch with an empty body gets a 400 and is never settled", async () => {
    stubFacilitator({ verify: verifyOk, settle: settleOk });
    const { app, state } = makeApp();
    const path = "/v1/verdict/batch";
    const client = new x402Client();
    registerExactEvmScheme(client, { signer: privateKeyToAccount(generatePrivateKey()) });
    const http = new x402HTTPClient(client);
    const first = await app.request(path, { method: "POST", headers: { accept: "application/json" } });
    expect(first.status).toBe(402);
    const required = http.getPaymentRequiredResponse((n) => first.headers.get(n), await first.json());
    const headers = http.encodePaymentSignatureHeader(await client.createPaymentPayload(required));
    const r = await app.request(path, { method: "POST", headers: { accept: "application/json", ...headers } });
    expect(r.status).toBe(400);
    expect(calls).not.toContain("settle");
    expect(state.handlerCalls).toBe(0);
  });
});

describe("requireSettlement guard", () => {
  const build = (inner: Parameters<typeof requireSettlement>[0]) => {
    const app = new Hono();
    app.use("/paid", requireSettlement(inner));
    app.get("/paid", (c) => c.json({ secret: "verdict" }));
    return app;
  };

  it("replaces a 2xx that has no PAYMENT-RESPONSE receipt with a 402 (a payment middleware that lets requests through)", async () => {
    const r = await build((_c, next) => next()).request("/paid");
    expect(r.status).toBe(402);
    expect(await r.text()).not.toContain("verdict");
  });

  it("keeps a 2xx that carries a settlement receipt", async () => {
    const r = await build(async (c, next) => {
      await next();
      c.res.headers.set("PAYMENT-RESPONSE", "x");
    }).request("/paid");
    expect(r.status).toBe(200);
  });

  it("keeps a Response returned by the inner middleware (e.g. its own 402)", async () => {
    const r = await build(async (c) => c.json({ error: "Payment required" }, 402)).request("/paid");
    expect(r.status).toBe(402);
    expect(await r.json()).toEqual({ error: "Payment required" });
  });
});
