import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, parseAbi } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeClients, splitUrls } from "../src/chain/client.ts";
import { ERC20_ABI } from "../src/risk/contract.ts";
import { redact } from "../src/risk/verdict.ts";

const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
const AGG3 = parseAbi(["function aggregate3((address target,bool allowFailure,bytes callData)[]) returns ((bool success,bytes returnData)[])"]);
const TOKEN = "0x1111111111111111111111111111111111111111";

type Req = { method: string; params: any[]; id: number };
const ok = (id: number, result: unknown) => ({ jsonrpc: "2.0", id, result });

/** Answers eth_chainId / eth_call(Multicall3) locally; `route` can reject a URL with an HTTP status. */
function stubFetch(route: (url: string) => number | undefined = () => undefined) {
  const hits: Array<{ url: string; methods: string[]; multicallSize?: number }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body));
      const reqs: Req[] = Array.isArray(body) ? body : [body];
      const hit: (typeof hits)[number] = { url, methods: reqs.map((r) => r.method) };
      hits.push(hit);
      const status = route(url);
      if (status) return new Response("rate limited", { status });
      const out = reqs.map((r) => {
        if (r.method === "eth_chainId") return ok(r.id, "0x2105");
        if (r.method === "eth_call" && r.params[0].to.toLowerCase() === MULTICALL3) {
          const { args } = decodeFunctionData({ abi: AGG3, data: r.params[0].data });
          hit.multicallSize = (args[0] as unknown[]).length;
          const results = (args[0] as readonly { callData: `0x${string}` }[]).map(() => ({
            success: true,
            returnData: encodeAbiParameters([{ type: "uint256" }], [6n]),
          }));
          return ok(r.id, encodeFunctionResult({ abi: AGG3, functionName: "aggregate3", result: results }));
        }
        return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: `unexpected ${r.method}` } };
      });
      return Response.json(Array.isArray(body) ? out : out[0]);
    }),
  );
  return hits;
}

afterEach(() => vi.unstubAllGlobals());

describe("RPC clients", () => {
  it("splits a comma-separated URL list", () => {
    expect(splitUrls(" https://a , https://b,, ")).toEqual(["https://a", "https://b"]);
  });

  it("never lets an RPC URL (which may carry an API key) reach an API response", () => {
    expect(redact("HTTP request failed.\n\nStatus: 429\nURL: https://rpc.example/v2/SECRETKEY\nRequest body: {}")).not.toContain("SECRETKEY");
  });

  it("coalesces concurrent contract reads into one Multicall3 request", async () => {
    const hits = stubFetch();
    const { rpc } = makeClients({ rpcUrl: "https://rpc.test", archiveRpcUrl: "https://rpc.test", logsRpcUrl: "https://rpc.test" });
    const reads = await Promise.all(
      Array.from({ length: 12 }, () => rpc.readContract({ address: TOKEN, abi: ERC20_ABI, functionName: "decimals" })),
    );
    expect(reads).toEqual(Array(12).fill(6));
    const calls = hits.filter((h) => h.methods.includes("eth_call"));
    expect(calls).toHaveLength(1);
    expect(calls[0].multicallSize).toBe(12);
  });

  it("moves on to the next endpoint on HTTP 429 instead of retrying the limited one", async () => {
    const hits = stubFetch((url) => (url.startsWith("https://limited.test") ? 429 : undefined));
    const { rpc } = makeClients({
      rpcUrl: "https://limited.test, https://good.test",
      archiveRpcUrl: "https://good.test",
      logsRpcUrl: "https://good.test",
    });
    const t = Date.now();
    const v = await rpc.readContract({ address: TOKEN, abi: ERC20_ABI, functionName: "decimals" });
    expect(v).toBe(6);
    expect(hits.filter((h) => h.url.startsWith("https://limited.test"))).toHaveLength(1); // no backoff loop on the limited URL
    expect(hits.filter((h) => h.url.startsWith("https://good.test")).length).toBeGreaterThan(0);
    expect(Date.now() - t).toBeLessThan(1_000);
  });

  it("gives up with an error once every endpoint is limited (no endless retry)", async () => {
    stubFetch(() => 429);
    const { rpc } = makeClients({ rpcUrl: "https://a.test,https://b.test", archiveRpcUrl: "https://a.test", logsRpcUrl: "https://a.test" });
    const t = Date.now();
    await expect(rpc.readContract({ address: TOKEN, abi: ERC20_ABI, functionName: "decimals" })).rejects.toThrow();
    expect(Date.now() - t).toBeLessThan(3_000);
  });
});
