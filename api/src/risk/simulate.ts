import {
  decodeErrorResult,
  decodeFunctionResult,
  encodeFunctionData,
  parseAbi,
  parseEther,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { BASE, SIMULATOR_ADDRESS } from "../chain/addresses.ts";
import { TRADE_SIMULATOR_ABI, TRADE_SIMULATOR_RUNTIME } from "../sim/bytecode.ts";
import { ERC20_ABI } from "./contract.ts";
import type { PriceBook } from "./price.ts";
import type { PoolFacts, PoolRef, SimResult } from "./types.ts";

const PAIR_ABI = parseAbi([
  "function getReserves() view returns (uint112, uint112, uint32)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const DEAD = "0x000000000000000000000000000000000000dEaD" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const INT128_MAX = (1n << 127n) - 1n;

const override = [{ address: SIMULATOR_ADDRESS, code: TRADE_SIMULATOR_RUNTIME, balance: parseEther("1000000") }];

async function simCall<F extends "simV4" | "simV2" | "simV3" | "depthV4">(client: PublicClient, functionName: F, args: unknown[]) {
  const data = encodeFunctionData({ abi: TRADE_SIMULATOR_ABI, functionName, args } as any);
  const res = await client.call({
    account: SIMULATOR_ADDRESS,
    to: SIMULATOR_ADDRESS,
    data,
    gas: 30_000_000n,
    stateOverride: override,
  });
  return decodeFunctionResult({ abi: TRADE_SIMULATOR_ABI, functionName, data: res.data ?? "0x" } as any) as any;
}

export const toUnits = (raw: bigint, decimals: number) => Number(raw) / 10 ** decimals;
export const fromUnits = (v: number, decimals: number) => BigInt(Math.floor(v * 10 ** Math.min(decimals, 18))) * 10n ** BigInt(Math.max(0, decimals - 18));

/** Raw exit-liquidity reads for a pool (no dependence on quote metadata or price, so they run alongside them). */
async function readDepth(client: PublicClient, pool: PoolRef, totalSupply: bigint) {
  if (pool.kind === "uniswap-v4") {
    const amt = totalSupply > INT128_MAX ? INT128_MAX : totalSupply;
    const [quoteOut] = await simCall(client, "depthV4", [BASE.v4PoolManager, pool.key, pool.tokenIs0, amt]);
    return { kind: "quote-out" as const, raw: quoteOut as bigint };
  }
  if (pool.kind === "uniswap-v3" || pool.kind === "aerodrome-cl") {
    const raw = await client.readContract({ address: pool.quote, abi: ERC20_ABI, functionName: "balanceOf", args: [pool.id as Address] });
    return { kind: "quote-balance" as const, raw };
  }
  const pair = pool.id as Address;
  const [[r0, r1], supply, dead, zero] = await Promise.all([
    client.readContract({ address: pair, abi: PAIR_ABI, functionName: "getReserves" }),
    client.readContract({ address: pair, abi: PAIR_ABI, functionName: "totalSupply" }),
    client.readContract({ address: pair, abi: PAIR_ABI, functionName: "balanceOf", args: [DEAD] }),
    client.readContract({ address: pair, abi: PAIR_ABI, functionName: "balanceOf", args: [ZERO] }),
  ]);
  return { kind: "v2" as const, raw: pool.tokenIs0 ? r1 : r0, supply, burned: dead + zero };
}

/** Adds quote metadata, USD price, exit-liquidity depth and LP status to a discovered pool. */
export async function analyzePool(
  client: PublicClient,
  pool: PoolRef,
  token: Address,
  totalSupply: bigint,
  prices: PriceBook,
): Promise<PoolFacts> {
  // Depth reads start together with metadata and price: one round trip for the usual WETH/USDC/ETH quotes.
  const depthP = readDepth(client, pool, totalSupply).then(
    (d) => d,
    () => undefined, // depth stays undefined
  );
  const [meta, quoteUsd, depth] = await Promise.all([prices.tokenMeta(pool.quote), prices.usdPrice(pool.quote), depthP]);
  const facts: PoolFacts = {
    ...pool,
    quoteSymbol: meta.symbol,
    quoteDecimals: meta.decimals,
    quoteUsd,
    lp: { status: pool.launchpad ? "locked-by-launchpad" : "unknown" },
  };
  if (depth) {
    facts.depthQuote = toUnits(depth.raw, meta.decimals);
    if (depth.kind === "v2" && depth.supply > 0n) {
      const burnedPct = Number((depth.burned * 10_000n) / depth.supply) / 100;
      facts.lp = { status: burnedPct >= 95 ? "burned" : "not-burned", burnedPct };
    }
  }
  if (facts.depthQuote !== undefined && quoteUsd !== undefined) facts.depthUsd = facts.depthQuote * quoteUsd;
  return facts;
}

export function isSimulatable(p: PoolFacts): boolean {
  if (p.kind === "uniswap-v4") return true;
  return p.quote.toLowerCase() === BASE.weth.toLowerCase();
}

/** Deepest simulatable pool; priced pools win over unpriced ones. */
export function pickPool(pools: PoolFacts[]): PoolFacts | undefined {
  const sims = pools.filter(isSimulatable);
  const priced = sims.filter((p) => (p.depthUsd ?? 0) > 0).sort((a, b) => b.depthUsd! - a.depthUsd!);
  if (priced.length) return priced[0];
  const deep = sims.filter((p) => (p.depthQuote ?? 0) > 0).sort((a, b) => b.depthQuote! - a.depthQuote!);
  if (deep.length) return deep[0];
  // Fresh pools with no buyers yet still get a round-trip test; prefer ETH/WETH-quoted ones.
  return sims.find((p) => p.quoteUsd !== undefined) ?? sims[0];
}

export function describeRevert(data: Hex | undefined): string | undefined {
  if (!data || data === "0x") return undefined;
  try {
    const e = decodeErrorResult({ abi: parseAbi(["error Error(string)", "error Panic(uint256)"]), data });
    return `${e.errorName}(${e.args?.map(String).join(",")})`;
  } catch {
    return `revert ${data.slice(0, 10)}`;
  }
}

const pct = (lost: bigint, base: bigint) => (base > 0n ? Number((lost * 1_000_000n) / base) / 10_000 : undefined);

export interface RawSim {
  stage: number;
  quoteIn: bigint;
  buyExpected: bigint;
  buyReceived: bigint;
  sellSent: bigint;
  sellArrived: bigint;
  quoteOut: bigint;
  buyGas: bigint;
  sellGas: bigint;
  revertData: Hex;
}

/** Pure: turns the simulator's raw result into taxes and booleans. */
export function interpretSim(r: RawSim): Omit<SimResult, "attempted" | "pool" | "poolKind" | "quoteIn" | "quoteInUsd"> {
  const stage = Number(r.stage);
  const out: ReturnType<typeof interpretSim> = {
    stage,
    canBuy: stage === 0 || stage >= 3 && stage <= 4,
    canSell: stage === 0,
    buyGas: Number(r.buyGas) || undefined,
    sellGas: Number(r.sellGas) || undefined,
    error: describeRevert(r.revertData),
  };
  if (stage === 5) out.canBuy = undefined;
  if (r.buyExpected > 0n && r.buyReceived > 0n) out.buyTaxPct = pct(r.buyExpected - r.buyReceived, r.buyExpected);
  if (r.sellSent > 0n && (stage === 0 || stage === 4)) out.sellTaxPct = pct(r.sellSent - r.sellArrived, r.sellSent);
  if (stage === 0 && r.quoteIn > 0n) out.roundTripLossPct = pct(r.quoteIn - (r.quoteOut > r.quoteIn ? r.quoteIn : r.quoteOut), r.quoteIn);
  return out;
}

export async function simulateRoundTrip(
  client: PublicClient,
  pool: PoolFacts,
  token: Address,
  simUsd: number,
): Promise<SimResult> {
  const dec = pool.quoteDecimals ?? 18;
  const depth = pool.depthQuote ?? 0;
  // Target simUsd, capped at 1% of exit liquidity; pools with no exit liquidity get a ~$1 probe.
  let amount: number;
  if (pool.quoteUsd) amount = Math.min(simUsd / pool.quoteUsd, depth > 0 ? Math.max(depth * 0.01, 1 / pool.quoteUsd) : 1 / pool.quoteUsd);
  else amount = depth > 0 ? depth * 0.005 : 10 ** -3;
  const quoteIn = fromUnits(amount, dec);
  const base: SimResult = { attempted: true, pool: pool.id, poolKind: pool.kind, quoteIn: amount, quoteInUsd: pool.quoteUsd ? amount * pool.quoteUsd : undefined };
  if (quoteIn === 0n) return { ...base, attempted: false, note: "pool too shallow to simulate" };

  let raw: RawSim;
  if (pool.kind === "uniswap-v4") raw = await simCall(client, "simV4", [BASE.v4PoolManager, pool.key, pool.tokenIs0, quoteIn]);
  else if (pool.kind === "uniswap-v3" || pool.kind === "aerodrome-cl") raw = await simCall(client, "simV3", [pool.id, token, BASE.weth, quoteIn]);
  else raw = await simCall(client, "simV2", [pool.id, token, BASE.weth, quoteIn, pool.kind === "aerodrome-v2"]);
  return { ...base, ...interpretSim(raw) };
}
