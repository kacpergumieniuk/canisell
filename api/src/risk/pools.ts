import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  parseAbi,
  parseAbiItem,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { BASE } from "../chain/addresses.ts";
import { isOnChainFailure } from "./contract.ts";
import type { Clients } from "../chain/client.ts";
import type { CoarseAge } from "./age.ts";
import type { CreationFacts, Launchpad, PoolKeyV4, PoolRef } from "./types.ts";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
export const DYNAMIC_FEE = 0x800000;

export const PM_ABI = parseAbi(["function extsload(bytes32[] slots) view returns (bytes32[])"]);
const V2_FACTORY_ABI = parseAbi(["function getPair(address,address) view returns (address)"]);
const V3_FACTORY_ABI = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const AERO_FACTORY_ABI = parseAbi(["function getPool(address,address,bool) view returns (address)"]);
const AERO_CL_FACTORY_ABI = parseAbi(["function getPool(address,address,int24) view returns (address)"]);
const AERO_CL_TICK_SPACINGS = [1, 50, 100, 200, 2000];
export const ZORA_COIN_ABI = parseAbi([
  "function getPoolKey() view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks))",
  "function payoutRecipient() view returns (address)",
]);
const CLANKER_FACTORY_ABI = parseAbi([
  "function tokenDeploymentInfo(address) view returns ((address token, address hook, address locker, address[] extensions))",
]);
export const INITIALIZE_EVENT = parseAbiItem(
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
);

const V4_STANDARD_FEES: Array<[number, number]> = [
  [100, 1],
  [500, 10],
  [3000, 60],
  [10000, 200],
];
const V3_FEES = [100, 500, 3000, 10000];
/** eth_getLogs window used after token creation (LOGS_RPC allows 10k blocks). */
const LOG_WINDOW = 9_999;
/** publicnode serves ~30 days of logs without an archive token. */
const LOG_MAX_AGE_BLOCKS = 1_250_000;

export function sortCurrencies(a: Address, b: Address): [Address, Address] {
  return BigInt(a) < BigInt(b) ? [a, b] : [b, a];
}

export function poolIdOf(key: PoolKeyV4): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

/** StateLibrary: pools mapping lives at slot 6 of the PoolManager. */
export function v4Slot0Slot(poolId: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [poolId, 6n]));
}
export function v4LiquiditySlot(poolId: Hex): Hex {
  return `0x${(BigInt(v4Slot0Slot(poolId)) + 3n).toString(16).padStart(64, "0")}`;
}

export function decodeSlot0(word: Hex): { sqrtPriceX96: bigint; tick: number } {
  const v = BigInt(word);
  const sqrtPriceX96 = v & ((1n << 160n) - 1n);
  let tick = Number((v >> 160n) & 0xffffffn);
  if (tick >= 0x800000) tick -= 0x1000000;
  return { sqrtPriceX96, tick };
}

export async function readV4Slot0s(client: PublicClient, ids: Hex[]): Promise<Array<{ sqrtPriceX96: bigint; tick: number }>> {
  if (ids.length === 0) return [];
  const words = await client.readContract({
    address: BASE.v4PoolManager,
    abi: PM_ABI,
    functionName: "extsload",
    args: [ids.map(v4Slot0Slot)],
  });
  return words.map(decodeSlot0);
}

function v4Ref(token: Address, key: PoolKeyV4, source: PoolRef["source"], launchpad?: Launchpad): PoolRef {
  const tokenIs0 = key.currency0.toLowerCase() === token.toLowerCase();
  return {
    kind: "uniswap-v4",
    id: poolIdOf(key),
    quote: tokenIs0 ? key.currency1 : key.currency0,
    tokenIs0,
    key,
    source,
    launchpad,
  };
}

export interface Discovery {
  pools: PoolRef[];
  /** false when a lookup failed, so "no pool" may be a false negative */
  complete: boolean;
  launchpad?: Launchpad;
  launchpadCreator?: { address: Address; source: "zora-payout" | "clanker-admin" };
  errors: string[];
}

export interface DiscoveryContext {
  /** Chain head; only awaited when the v4 log scan is needed. */
  head: Promise<number>;
  /** The age search's first round (resolves undefined if it cannot tell). Lets the log scan start long before the exact creation block is known. */
  coarse?: Promise<CoarseAge | undefined>;
  /** Creation facts ({} when unknown); only awaited when the v4 log scan is needed. Must not reject. */
  creation: Promise<CreationFacts>;
}

/**
 * Finds pools for `token` on Uniswap v4 (launchpad keys, standard keys, Initialize logs near creation),
 * Uniswap v3/v2 and Aerodrome v2 (factory lookups against WETH and USDC).
 *
 * Everything except the log scan is one batched round of reads plus one slot0 read, and does not depend on the
 * token's age. The log scan (the slow, rate-limited part) only runs when no live launchpad pool was found:
 * a Clanker/Zora token's pool is read straight from the launchpad, so scanning logs for more v4 pools would
 * only add latency. Tokens that did not come from a known launchpad still get the scan.
 */
export async function discoverPools(
  clients: Clients,
  token: Address,
  ctx: DiscoveryContext,
): Promise<Discovery> {
  const { rpc } = clients;
  const errors: string[] = [];
  const quotes = [BASE.weth, BASE.usdc] as Address[];
  // A lookup that reverts means "not there" (e.g. no Zora getPoolKey on a plain token). One that never reached a
  // node says nothing, so it must not read as "no pool": note it and report the discovery as incomplete.
  let lookupFailed = false;
  const safe = async <T,>(p: Promise<T>): Promise<T | undefined> => {
    try {
      return await p;
    } catch (e) {
      if (isOnChainFailure(e)) return undefined;
      lookupFailed = true;
      if (errors.length < 3) errors.push(`pool lookup failed: ${(e as Error).message?.slice(0, 100)}`);
      return undefined;
    }
  };

  const zoraP = safe(rpc.readContract({ address: token, abi: ZORA_COIN_ABI, functionName: "getPoolKey" }));
  const zoraPayoutP = safe(rpc.readContract({ address: token, abi: ZORA_COIN_ABI, functionName: "payoutRecipient" }));
  const clankerP = safe(
    rpc.readContract({ address: BASE.clankerV4Factory, abi: CLANKER_FACTORY_ABI, functionName: "tokenDeploymentInfo", args: [token] }),
  );
  const clankerAdminP = safe(
    rpc.readContract({ address: token, abi: parseAbi(["function admin() view returns (address)"]), functionName: "admin" }),
  );

  // Standard hookless v4 keys against native ETH, WETH and USDC. They depend only on the token, so their slot0
  // read goes out together with the launchpad and factory lookups instead of after them.
  const stdKeys: PoolKeyV4[] = [];
  for (const q of [ZERO, BASE.weth, BASE.usdc] as Address[]) {
    const [c0, c1] = sortCurrencies(token, q);
    for (const [fee, tickSpacing] of V4_STANDARD_FEES) stdKeys.push({ currency0: c0, currency1: c1, fee, tickSpacing, hooks: ZERO });
  }
  const seen = new Set<string>();
  const unique = (list: PoolRef[]) => list.filter((p) => !seen.has(p.id) && !!seen.add(p.id));
  const initialized = async (list: PoolRef[]): Promise<PoolRef[]> => {
    if (list.length === 0) return [];
    try {
      const slot0s = await readV4Slot0s(rpc, list.map((p) => p.id));
      return list.filter((_, i) => slot0s[i].sqrtPriceX96 !== 0n);
    } catch (e) {
      errors.push(`v4 slot0 read failed: ${(e as Error).message?.slice(0, 120)}`);
      incomplete = true;
      return [];
    }
  };
  let incomplete = false;
  const stdInitP = initialized(unique(stdKeys.map((key) => v4Ref(token, key, "standard-key"))));

  const v2P = Promise.all(
    quotes.map((q) => safe(rpc.readContract({ address: BASE.v2Factory, abi: V2_FACTORY_ABI, functionName: "getPair", args: [token, q] }))),
  );
  const aeroP = Promise.all(
    quotes.map((q) =>
      safe(rpc.readContract({ address: BASE.aeroV2Factory, abi: AERO_FACTORY_ABI, functionName: "getPool", args: [token, q, false] })),
    ),
  );
  const v3P = Promise.all(
    quotes.flatMap((q) =>
      V3_FEES.map((fee) =>
        safe(rpc.readContract({ address: BASE.v3Factory, abi: V3_FACTORY_ABI, functionName: "getPool", args: [token, q, fee] })).then(
          (addr) => ({ addr, q }),
        ),
      ),
    ),
  );

  const clP = Promise.all(
    quotes.flatMap((q) =>
      AERO_CL_TICK_SPACINGS.map((ts) =>
        safe(rpc.readContract({ address: BASE.aeroClFactory, abi: AERO_CL_FACTORY_ABI, functionName: "getPool", args: [token, q, ts] })).then(
          (addr) => ({ addr, q }),
        ),
      ),
    ),
  );

  const [zoraKey, zoraPayout, clanker, clankerAdmin, v2, aero, v3, cl] = await Promise.all([
    zoraP,
    zoraPayoutP,
    clankerP,
    clankerAdminP,
    v2P,
    aeroP,
    v3P,
    clP,
  ]);

  const out: Discovery = { pools: [], errors, complete: true };
  const candidates: PoolRef[] = [];

  if (zoraKey && BigInt(zoraKey.hooks) !== 0n) {
    out.launchpad = "zora";
    const key = { ...zoraKey, fee: Number(zoraKey.fee), tickSpacing: Number(zoraKey.tickSpacing) } as PoolKeyV4;
    candidates.push(v4Ref(token, key, "zora", "zora"));
    if (zoraPayout && BigInt(zoraPayout) !== 0n) out.launchpadCreator = { address: getAddress(zoraPayout), source: "zora-payout" };
  }
  let clankerHook: Address | undefined;
  if (clanker && clanker.token.toLowerCase() === token.toLowerCase()) {
    out.launchpad = "clanker";
    clankerHook = getAddress(clanker.hook);
    if (clankerAdmin && BigInt(clankerAdmin) !== 0n) out.launchpadCreator = { address: getAddress(clankerAdmin), source: "clanker-admin" };
    const [c0, c1] = sortCurrencies(token, BASE.weth);
    candidates.push(v4Ref(token, { currency0: c0, currency1: c1, fee: DYNAMIC_FEE, tickSpacing: 200, hooks: clankerHook }, "clanker", "clanker"));
  }

  // Keep only v4 candidates that are initialized (sqrtPrice != 0); dedupe by id.
  const v4Pools = [...(await initialized(unique(candidates))), ...(await stdInitP)];

  // Scan v4 Initialize logs in the 10k blocks after creation; if the creation block is unknown
  // (archive lookup failed), scan the latest 10k blocks, which covers launches up to ~5.5 h old.
  // Skipped when a launchpad pool is live (see above).
  if (!v4Pools.some((p) => p.launchpad)) {
    // Window selection. The coarse answer (one archive round trip) is enough for most tokens: created within the
    // last ~5 h means the latest 10k blocks hold its whole life, so the scan need not wait for the exact creation block.
    const head = await ctx.head;
    const coarse = await ctx.coarse;
    const recent = coarse && !coarse.olderThan30d && coarse.createdWithinBlocks !== undefined && coarse.createdWithinBlocks < LOG_WINDOW;
    const creation: CreationFacts = coarse?.olderThan30d ? { olderThanDays: 30 } : recent ? {} : await ctx.creation;
    const knownAndRecent = creation.createdBlock !== undefined && head - creation.createdBlock < LOG_MAX_AGE_BLOCKS;
    const unknownAge = creation.createdBlock === undefined && creation.olderThanDays === undefined;
    if (knownAndRecent || unknownAge) {
      const fromBlock = BigInt(knownAndRecent ? creation.createdBlock! : Math.max(0, head - LOG_WINDOW));
      const toBlock = BigInt(knownAndRecent ? Math.min(creation.createdBlock! + LOG_WINDOW, head) : head);
      const q = (args: { currency0?: Address; currency1?: Address }) =>
        clients.logs.getLogs({ address: BASE.v4PoolManager, event: INITIALIZE_EVENT, args, fromBlock, toBlock });
      try {
        const [a, b] = await Promise.all([q({ currency0: token }), q({ currency1: token })]);
        const keys: PoolKeyV4[] = [...a, ...b].map((l) => ({
          currency0: getAddress(l.args.currency0!),
          currency1: getAddress(l.args.currency1!),
          fee: Number(l.args.fee),
          tickSpacing: Number(l.args.tickSpacing),
          hooks: getAddress(l.args.hooks!),
        }));
        const refs = keys.map((key) => {
          const lp: Launchpad | undefined =
            clankerHook && key.hooks.toLowerCase() === clankerHook.toLowerCase()
              ? "clanker"
              : zoraKey && key.hooks.toLowerCase() === zoraKey.hooks.toLowerCase()
                ? "zora"
                : undefined;
          return v4Ref(token, key, "logs", lp);
        });
        v4Pools.push(...(await initialized(unique(refs))));
      } catch (e) {
        errors.push(`v4 log scan failed: ${(e as Error).message?.slice(0, 120)}`);
        incomplete = true;
      }
    }
  }
  out.pools.push(...v4Pools);
  out.complete = !lookupFailed && !incomplete;

  const pushPair = (kind: PoolRef["kind"], addr: Address | undefined, q: Address) => {
    if (!addr || BigInt(addr) === 0n) return;
    out.pools.push({
      kind,
      id: getAddress(addr) as Hex,
      quote: q,
      tokenIs0: BigInt(token) < BigInt(q),
      source: "factory",
    });
  };
  v2.forEach((a, i) => pushPair("uniswap-v2", a, quotes[i]));
  aero.forEach((a, i) => pushPair("aerodrome-v2", a, quotes[i]));
  v3.forEach(({ addr, q }) => pushPair("uniswap-v3", addr, q));
  cl.forEach(({ addr, q }) => pushPair("aerodrome-cl", addr, q));
  return out;
}
