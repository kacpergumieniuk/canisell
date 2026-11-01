import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { usdAmount } from "../src/discovery.ts";
import { SAMPLE_VERDICT } from "../src/sample.ts";
import { SERVICE_NAME } from "../src/x402.ts";
import { mockClients } from "./helpers/mockRpc.ts";

const passThrough = async (_c: unknown, next: () => Promise<void>) => next();
const mk = (env: Record<string, string> = {}) =>
  createApp(loadConfig(env), { check: async () => SAMPLE_VERDICT as never, payment: passThrough as never, clients: mockClients({}) });

describe("discovery endpoints (free, no payment middleware involved)", () => {
  const app = mk();

  it("GET /.well-known/x402 lists probe-able paid resources (x402scan version 1)", async () => {
    const r = await app.request("http://api.test/.well-known/x402");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
    const j = (await r.json()) as { version: number; resources: string[]; instructions: string };
    expect(j.version).toBe(1);
    expect(j.resources).toEqual([`http://api.test/v1/verdict/${SAMPLE_VERDICT.address}`, "http://api.test/v1/verdict/batch"]);
    expect(j.instructions).toContain(SERVICE_NAME);
  });

  it("GET /openapi.json is OpenAPI 3.1 with x-payment-info prices and a 402 response on paid operations", async () => {
    const r = await app.request("http://api.test/openapi.json");
    expect(r.status).toBe(200);
    const doc = (await r.json()) as any;
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toBe(SERVICE_NAME);
    expect(doc.info.version).toBeTruthy();
    expect(doc.servers[0].url).toBe("http://api.test");

    const single = doc.paths["/v1/verdict/{address}"].get;
    expect(single["x-payment-info"]).toMatchObject({ protocols: ["x402"], price: { mode: "fixed", currency: "USD", amount: "0.01" }, network: "eip155:84532" });
    expect(single.responses["402"]).toBeDefined();
    expect(single.parameters[0]).toMatchObject({ name: "address", in: "path", required: true });
    expect(single.security).toEqual([{ x402: [] }]);

    const batch = doc.paths["/v1/verdict/batch"].post;
    expect(batch["x-payment-info"].price.amount).toBe("0.05");
    expect(batch.requestBody.content["application/json"].schema.required).toEqual(["addresses"]);

    // every route the app serves is documented; free ones carry no payment info
    for (const [p, m] of [["/v1/sample", "get"], ["/v1/health", "get"], ["/", "get"], ["/openapi.json", "get"], ["/.well-known/x402", "get"], ["/llms.txt", "get"]] as const) {
      expect(doc.paths[p]?.[m], `${m} ${p}`).toBeDefined();
      expect(doc.paths[p][m]["x-payment-info"]).toBeUndefined();
    }
    const ids = Object.values<any>(doc.paths).flatMap((p) => Object.values<any>(p).map((o) => o.operationId));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("prices and origin follow configuration (PRICE_*, PUBLIC_BASE_URL)", async () => {
    const a = mk({ PRICE_SINGLE: "$0.02", PRICE_BATCH: "0.1", PUBLIC_BASE_URL: "https://api.example.com/" });
    const doc = (await (await a.request("http://localhost/openapi.json")).json()) as any;
    expect(doc.servers[0].url).toBe("https://api.example.com");
    expect(doc.paths["/v1/verdict/{address}"].get["x-payment-info"].price.amount).toBe("0.02");
    expect(doc.paths["/v1/verdict/batch"].post["x-payment-info"].price.amount).toBe("0.1");
    const wk = (await (await a.request("http://localhost/.well-known/x402")).json()) as any;
    expect(wk.resources[0]).toBe(`https://api.example.com/v1/verdict/${SAMPLE_VERDICT.address}`);
    expect(usdAmount("$0.01")).toBe("0.01");
  });

  it("GET /llms.txt is short plain text with the name, prices and usage", async () => {
    const r = await app.request("http://api.test/llms.txt");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/plain");
    const t = await r.text();
    expect(t.startsWith(`# ${SERVICE_NAME}\n`)).toBe(true);
    expect(t).toContain("x402");
    expect(t).toContain("$0.01");
    expect(t).toContain("$0.05");
    expect(t).toContain("http://api.test/v1/verdict/{address}");
    expect(t.length).toBeLessThan(3000);
  });

  it("the service name lives in one constant: renaming it changes every document", async () => {
    const src = await import("node:fs").then((fs) => fs.readFileSync(new URL("../src/discovery.ts", import.meta.url), "utf8"));
    expect(src).not.toContain(SERVICE_NAME);
    expect(src).toContain("SERVICE_NAME");
  });

  it("discovery endpoints are not paywalled by the real middleware", async () => {
    const real = createApp(loadConfig({}), { clients: mockClients({}) }); // real lazy x402 middleware, no facilitator reachable
    for (const p of ["/openapi.json", "/.well-known/x402", "/llms.txt"]) expect((await real.request(p)).status, p).toBe(200);
  });

  it("CORS lets browser-based agents read the documents", async () => {
    const r = await app.request("/openapi.json", { headers: { origin: "https://x402scan.com" } });
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
  });
});
