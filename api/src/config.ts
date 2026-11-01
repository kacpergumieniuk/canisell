/** Runtime configuration. Every value can be overridden with an environment variable (Node) or a Worker var. */
export type EnvLike = Record<string, string | undefined>;

export const NETWORKS = {
  "base-sepolia": "eip155:84532",
  base: "eip155:8453",
} as const;

export const FACILITATORS = {
  "x402.org": "https://x402.org/facilitator", // testnet only
  payai: "https://facilitator.payai.network",
  dexter: "https://x402.dexter.cash",
} as const;

export const DEFAULT_PAY_TO = "0x741f78ED943C671e25405dAAaAB7b6886C7e8feb";

/**
 * Free public Base RPCs, comma-separated and tried in order. From Cloudflare's shared egress IPs publicnode and
 * mainnet.base.org answer HTTP 429 for most of a verdict's calls, so they sit behind providers that held up in
 * testing (state-override eth_call, Multicall3, archive eth_getCode). Providers change limits without notice:
 * for production traffic put a keyed endpoint first (`wrangler secret put RPC_URL`).
 */
export const DEFAULT_RPC_URLS = "https://base-public.nodies.app,https://base-mainnet.public.blastapi.io,https://base-rpc.publicnode.com";
export const DEFAULT_ARCHIVE_RPC_URLS = "https://base-public.nodies.app,https://base-mainnet.public.blastapi.io,https://base-rpc.publicnode.com,https://mainnet.base.org";
/** eth_getLogs over 10k blocks: only publicnode allows that range on a free tier. */
export const DEFAULT_LOGS_RPC_URL = "https://base-rpc.publicnode.com";

export interface Config {
  /** Base mainnet RPC(s), comma-separated, for reads and eth_call simulations (needs state overrides). */
  rpcUrl: string;
  /** RPC with archive state, used only for eth_getCode at past blocks (token age). */
  archiveRpcUrl: string;
  /** RPC that allows eth_getLogs (mainnet.base.org blocks it). */
  logsRpcUrl: string;
  /** CAIP-2 network that payments are accepted on. */
  network: `${string}:${string}`;
  facilitatorUrl: string;
  payTo: `0x${string}`;
  priceSingle: string;
  priceBatch: string;
  /** USD notional of the simulated buy (capped at a fraction of pool depth). */
  simUsd: number;
  /** Public origin used in Bazaar metadata, e.g. https://api.example.com */
  publicBaseUrl?: string;
  cacheTtlSeconds: number;
}

export function loadConfig(env: EnvLike = {}): Config {
  const netKey = (env.X402_NETWORK ?? "base-sepolia") as keyof typeof NETWORKS;
  const network = NETWORKS[netKey] ?? (env.X402_NETWORK as `${string}:${string}`);
  if (!network || !network.includes(":")) throw new Error(`Unknown X402_NETWORK: ${env.X402_NETWORK}`);

  const isTestnet = network === NETWORKS["base-sepolia"];
  const facKey = (env.FACILITATOR ?? (isTestnet ? "x402.org" : "payai")) as keyof typeof FACILITATORS;
  const facilitatorUrl = env.FACILITATOR_URL ?? FACILITATORS[facKey];
  if (!facilitatorUrl) throw new Error(`Unknown FACILITATOR: ${env.FACILITATOR}`);
  if (!isTestnet && facilitatorUrl === FACILITATORS["x402.org"]) {
    throw new Error("x402.org facilitator is testnet-only; set FACILITATOR=payai|dexter for mainnet");
  }

  const payTo = (env.PAY_TO ?? DEFAULT_PAY_TO) as `0x${string}`;
  if (!/^0x[0-9a-fA-F]{40}$/.test(payTo)) throw new Error("PAY_TO must be an EVM address");

  return {
    rpcUrl: env.RPC_URL ?? DEFAULT_RPC_URLS,
    archiveRpcUrl: env.ARCHIVE_RPC_URL ?? DEFAULT_ARCHIVE_RPC_URLS,
    logsRpcUrl: env.LOGS_RPC_URL ?? DEFAULT_LOGS_RPC_URL,
    network,
    facilitatorUrl,
    payTo,
    priceSingle: env.PRICE_SINGLE ?? "$0.01",
    priceBatch: env.PRICE_BATCH ?? "$0.05",
    simUsd: Number(env.SIM_USD ?? 20),
    publicBaseUrl: env.PUBLIC_BASE_URL,
    cacheTtlSeconds: Number(env.CACHE_TTL_SECONDS ?? 60),
  };
}
