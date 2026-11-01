import { parseAbi, type Address, type PublicClient } from "viem";
import { BASE } from "../chain/addresses.ts";
import { ERC20_ABI } from "./contract.ts";
import { poolIdOf, readV4Slot0s, ZORA_COIN_ABI } from "./pools.ts";
import type { PoolKeyV4 } from "./types.ts";

const V3F = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const CLF = parseAbi(["function getPool(address,address,int24) view returns (address)"]);
const FEED_ABI = parseAbi([
  "function latestRoundData() view returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80)",
]);

export async function ethUsd(client: PublicClient): Promise<number | undefined> {
  try {
    const [, answer] = await client.readContract({ address: BASE.chainlinkEthUsd, abi: FEED_ABI, functionName: "latestRoundData" });
    return Number(answer) / 1e8;
  } catch {
    return undefined;
  }
}

/** Spot price of currency0 in currency1 (human units) from sqrtPriceX96. */
export function spotPrice0In1(sqrtPriceX96: bigint, dec0: number, dec1: number): number {
  const s = Number(sqrtPriceX96) / 2 ** 96;
  return s * s * 10 ** (dec0 - dec1);
}

const KNOWN_QUOTE_META: Record<string, TokenMeta> = {
  [BASE.weth.toLowerCase()]: { symbol: "WETH", decimals: 18 },
  [BASE.usdc.toLowerCase()]: { symbol: "USDC", decimals: 6 },
  [BASE.usdbc.toLowerCase()]: { symbol: "USDbC", decimals: 6 },
};

export interface TokenMeta {
  symbol?: string;
  decimals: number;
}

export class PriceBook {
  private usd = new Map<string, Promise<number | undefined>>();
  private meta = new Map<string, Promise<TokenMeta>>();
  constructor(
    private client: PublicClient,
    private eth: Promise<number | undefined>,
  ) {}

  tokenMeta(addr: Address): Promise<TokenMeta> {
    const k = addr.toLowerCase();
    if (BigInt(addr) === 0n) return Promise.resolve({ symbol: "ETH", decimals: 18 });
    // The usual quote assets are immutable and well known: no round trip needed.
    const known = KNOWN_QUOTE_META[k];
    if (known) return Promise.resolve(known);
    if (!this.meta.has(k)) {
      this.meta.set(
        k,
        Promise.all([
          this.client.readContract({ address: addr, abi: ERC20_ABI, functionName: "symbol" }).catch(() => undefined),
          this.client.readContract({ address: addr, abi: ERC20_ABI, functionName: "decimals" }).catch(() => 18),
        ]).then(([symbol, decimals]) => ({ symbol, decimals: Number(decimals) })),
      );
    }
    return this.meta.get(k)!;
  }

  /** USD price for a quote asset: ETH/WETH via Chainlink, USDC=1, Zora coins recursively via their own pool. */
  usdPrice(addr: Address, depth = 0): Promise<number | undefined> {
    const k = addr.toLowerCase();
    if (!this.usd.has(k)) this.usd.set(k, this.resolve(addr, depth));
    return this.usd.get(k)!;
  }

  private async resolve(addr: Address, depth: number): Promise<number | undefined> {
    const k = addr.toLowerCase();
    if (BigInt(addr) === 0n || k === BASE.weth.toLowerCase()) return this.eth;
    if (k === BASE.usdc.toLowerCase() || k === BASE.usdbc.toLowerCase()) return 1;
    if (depth >= 3) return undefined;
    const viaZora = await this.viaZoraPool(addr, depth);
    if (viaZora !== undefined) return viaZora;
    return this.viaWethPools(addr);
  }

  /** Fallback: spot price against WETH from the deepest Uniswap v3 / Aerodrome CL pool. */
  private async viaWethPools(addr: Address): Promise<number | undefined> {
    const eth = await this.eth;
    if (eth === undefined) return undefined;
    const lookups: Array<Promise<Address | undefined>> = [
      ...[3000, 10000].map((fee) =>
        this.client.readContract({ address: BASE.v3Factory, abi: V3F, functionName: "getPool", args: [addr, BASE.weth, fee] }).catch(() => undefined),
      ),
      ...[100, 200].map((ts) =>
        this.client.readContract({ address: BASE.aeroClFactory, abi: CLF, functionName: "getPool", args: [addr, BASE.weth, ts] }).catch(() => undefined),
      ),
    ];
    const pools = (await Promise.all(lookups)).filter((p): p is Address => !!p && BigInt(p) !== 0n);
    if (!pools.length) return undefined;
    const bals = await Promise.all(
      pools.map((p) => this.client.readContract({ address: BASE.weth, abi: ERC20_ABI, functionName: "balanceOf", args: [p] }).catch(() => 0n)),
    );
    const best = pools[bals.indexOf(bals.reduce((a, b) => (b > a ? b : a)))];
    // Slipstream slot0 has a different tail (no feeProtocol) but sqrtPriceX96 is the first word in both.
    const word = await this.client.call({ to: best, data: "0x3850c7bd" }).catch(() => undefined);
    if (!word?.data || word.data.length < 66) return undefined;
    const sqrt = BigInt(word.data.slice(0, 66));
    const meta = await this.tokenMeta(addr);
    const tokenIs0 = BigInt(addr) < BigInt(BASE.weth);
    const p01 = spotPrice0In1(sqrt, tokenIs0 ? meta.decimals : 18, tokenIs0 ? 18 : meta.decimals);
    return (tokenIs0 ? p01 : 1 / p01) * eth;
  }

  private async viaZoraPool(addr: Address, depth: number): Promise<number | undefined> {
    const k = addr.toLowerCase();
    try {
      const raw = await this.client.readContract({ address: addr, abi: ZORA_COIN_ABI, functionName: "getPoolKey" });
      const key: PoolKeyV4 = { ...raw, fee: Number(raw.fee), tickSpacing: Number(raw.tickSpacing) };
      const isC0 = key.currency0.toLowerCase() === k;
      const other = isC0 ? key.currency1 : key.currency0;
      const [[slot0], m0, m1, otherUsd] = await Promise.all([
        readV4Slot0s(this.client, [poolIdOf(key)]),
        this.tokenMeta(key.currency0),
        this.tokenMeta(key.currency1),
        this.usdPrice(other, depth + 1),
      ]);
      if (!slot0.sqrtPriceX96 || otherUsd === undefined) return undefined;
      const p01 = spotPrice0In1(slot0.sqrtPriceX96, m0.decimals, m1.decimals);
      return isC0 ? p01 * otherUsd : otherUsd / p01;
    } catch {
      return undefined;
    }
  }
}
