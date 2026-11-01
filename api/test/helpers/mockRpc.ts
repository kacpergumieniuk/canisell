import { createPublicClient, custom, toFunctionSelector, type Hex, type PublicClient } from "viem";
import { base } from "viem/chains";
import type { Clients } from "../../src/chain/client.ts";

export type CallHandler = (args: { to: string; data: Hex; selector: Hex; override?: unknown }) => Hex | undefined;

export interface MockSpec {
  blockNumber?: bigint;
  /** eth_call: return hex result, or undefined to revert */
  call?: CallHandler;
  code?: (address: string, block: string) => Hex;
  storage?: (address: string, slot: string) => Hex;
  logs?: (filter: any) => any[];
  txCount?: number;
  /** Never answer this request (a hung RPC connection). */
  hang?: (method: string, params: any) => boolean;
  /** Fail this request at the transport level (HTTP 429/502-style), as opposed to an on-chain revert. */
  fail?: (method: string, params: any) => boolean;
}

export const ZERO_WORD = ("0x" + "0".repeat(64)) as Hex;
export const sel = (signature: string) => toFunctionSelector(signature);

/** A viem PublicClient whose JSON-RPC transport is a local function: no network. */
export function mockClient(spec: MockSpec, log: Array<{ method: string; params: any }> = []): PublicClient {
  return createPublicClient({
    chain: base,
    transport: custom(
      {
      async request({ method, params }: { method: string; params: any }) {
        log.push({ method, params });
        if (spec.hang?.(method, params)) await new Promise(() => {});
        if (spec.fail?.(method, params)) throw Object.assign(new Error("HTTP request failed: 429 Too Many Requests"), { code: -32005, status: 429 });
        switch (method) {
          case "eth_chainId":
            return "0x2105";
          case "eth_blockNumber":
            return "0x" + (spec.blockNumber ?? 50_000_000n).toString(16);
          case "eth_getCode":
            return spec.code?.(params[0].toLowerCase(), params[1]) ?? "0x";
          case "eth_getStorageAt":
            return spec.storage?.(params[0].toLowerCase(), params[1]) ?? ZERO_WORD;
          case "eth_getLogs":
            return spec.logs?.(params[0]) ?? [];
          case "eth_getTransactionCount":
            return "0x" + (spec.txCount ?? 0).toString(16);
          case "eth_call": {
            const { to, data } = params[0];
            const out = spec.call?.({ to: to.toLowerCase(), data, selector: data.slice(0, 10) as Hex, override: params[2] });
            if (out === undefined) throw Object.assign(new Error("execution reverted"), { code: 3, data: "0x" });
            return out;
          }
          default:
            throw new Error(`mockRpc: unsupported method ${method}`);
        }
      },
    },
      { retryCount: 0 }, // a mocked revert is final; do not let viem back off and retry it
    ),
  }) as PublicClient;
}

export function mockClients(spec: MockSpec, log?: Array<{ method: string; params: any }>): Clients {
  const c = mockClient(spec, log);
  return { rpc: c, archive: c, logs: c };
}
