import { AsyncLocalStorage } from "node:async_hooks";
import type { Timings } from "../timing.ts";

/** The request being served, so upstream RPC calls can be attributed to it (counts, slow calls, errors). */
export const requestTiming = new AsyncLocalStorage<Timings>();

const SLOW_MS = 1_000;

function methodsOf(body: unknown): string {
  try {
    const parsed = JSON.parse(String(body));
    return (Array.isArray(parsed) ? parsed : [parsed]).map((b: { method?: string }) => b?.method).slice(0, 6).join(",");
  } catch {
    return "";
  }
}

/**
 * fetch wrapper for the JSON-RPC transports. Counts upstream HTTP requests per request and logs the
 * ones that are slow, rate limited or failed. The URL is never logged (RPC URLs may embed API keys).
 */
export function tracedFetch(label: string): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const timing = requestTiming.getStore();
    const started = performance.now();
    let status: number | string = "error";
    try {
      const res = await fetch(input, init);
      status = res.status;
      return res;
    } finally {
      const ms = Math.round(performance.now() - started);
      if (timing) {
        timing.info[`rpc_${label}_n`] = ((timing.info[`rpc_${label}_n`] as number | undefined) ?? 0) + 1;
        if (ms > ((timing.info[`rpc_${label}_max_ms`] as number | undefined) ?? 0)) timing.info[`rpc_${label}_max_ms`] = ms;
      }
      if (ms >= SLOW_MS || status !== 200) {
        console.log(JSON.stringify({ evt: "rpc_slow_or_failed", label, ms, status, methods: methodsOf(init?.body) }));
      }
    }
  }) as typeof fetch;
}
