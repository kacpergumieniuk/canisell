import { createPublicClient, fallback, http, type PublicClient, type Transport } from "viem";
import { base } from "viem/chains";
import type { Config } from "../config.ts";
import { tracedFetch } from "./trace.ts";

export interface Clients {
  /** Reads and eth_call with state overrides. */
  rpc: PublicClient;
  /** Archive eth_getCode (token age search). */
  archive: PublicClient;
  /** eth_getLogs only. */
  logs: PublicClient;
}

/** Per-attempt timeout. Calls that matter (simulation) finish in well under a second on a healthy node. */
const ATTEMPT_TIMEOUT_MS = 4_000;

/** `RPC_URL` may hold several comma-separated endpoints; they are tried in order. */
export function splitUrls(value: string): string[] {
  return value
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
}

/**
 * One http transport per URL with JSON-RPC batching. With several URLs a failure (HTTP 429/5xx, timeout,
 * rate-limit error object) moves straight on to the next endpoint instead of sleeping and hammering the same
 * rate-limited one: free public RPCs throttle Cloudflare's shared egress IPs hard, and the viem default
 * (3 retries on the same URL with exponential backoff) turned a 100 ms call into 2-5 s.
 */
export function makeTransport(urls: string[], label: string): Transport {
  const multi = urls.length > 1;
  const mk = (url: string, i: number) =>
    http(url, {
      batch: { batchSize: 25, wait: 4 },
      timeout: ATTEMPT_TIMEOUT_MS,
      retryCount: multi ? 0 : 1,
      retryDelay: 150,
      fetchFn: tracedFetch(multi ? `${label}${i}` : label),
    });
  return multi ? fallback(urls.map(mk), { rank: false, retryCount: 1, retryDelay: 150 }) : mk(urls[0], 0);
}

export function makeClients(cfg: Pick<Config, "rpcUrl" | "logsRpcUrl" | "archiveRpcUrl">): Clients {
  const mk = (value: string, label: string, multicall: boolean) => {
    const urls = splitUrls(value);
    if (urls.length === 0) throw new Error(`No RPC URL configured for ${label}`);
    return createPublicClient({
      chain: base,
      transport: makeTransport(urls, label),
      // Concurrent eth_call reads (ERC-20 getters, factory lookups, balances) coalesce into one Multicall3
      // aggregate3 call: one provider-side request instead of dozens, which is what keeps us under the rate limits.
      // Calls with state overrides (the trade simulator) are never batched.
      ...(multicall ? { batch: { multicall: { batchSize: 8_192, wait: 5 } } } : {}),
    }) as PublicClient;
  };
  return { rpc: mk(cfg.rpcUrl, "rpc", true), archive: mk(cfg.archiveRpcUrl, "archive", false), logs: mk(cfg.logsRpcUrl, "logs", false) };
}
