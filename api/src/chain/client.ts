import { createPublicClient, http, type PublicClient } from "viem";
import { base } from "viem/chains";
import type { Config } from "../config.ts";

export interface Clients {
  /** Reads and eth_call with state overrides. */
  rpc: PublicClient;
  /** Archive eth_getCode (token age search). */
  archive: PublicClient;
  /** eth_getLogs only. */
  logs: PublicClient;
}

export function makeClients(cfg: Pick<Config, "rpcUrl" | "logsRpcUrl" | "archiveRpcUrl">): Clients {
  const mk = (url: string) =>
    createPublicClient({
      chain: base,
      // JSON-RPC batching keeps Workers subrequest counts low.
      transport: http(url, { batch: { batchSize: 25, wait: 4 }, timeout: 8_000, retryCount: 3, retryDelay: 250 }),
    }) as PublicClient;
  return { rpc: mk(cfg.rpcUrl), archive: mk(cfg.archiveRpcUrl), logs: mk(cfg.logsRpcUrl) };
}
