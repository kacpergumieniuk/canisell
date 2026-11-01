import type { PoolFacts, TokenFacts } from "../../src/risk/types.ts";

export const TOKEN = "0x1111111111111111111111111111111111111111" as const;

export function pool(over: Partial<PoolFacts> = {}): PoolFacts {
  return {
    kind: "uniswap-v4",
    id: "0xabc0000000000000000000000000000000000000000000000000000000000000",
    quote: "0x0000000000000000000000000000000000000000",
    tokenIs0: false,
    key: {
      currency0: "0x0000000000000000000000000000000000000000",
      currency1: TOKEN,
      fee: 3000,
      tickSpacing: 60,
      hooks: "0x0000000000000000000000000000000000000000",
    },
    source: "standard-key",
    quoteSymbol: "ETH",
    quoteDecimals: 18,
    quoteUsd: 3000,
    depthQuote: 50,
    depthUsd: 150_000,
    lp: { status: "burned" },
    ...over,
  };
}

/** A clean, liquid, renounced token with a successful round trip. Tests mutate copies of this. */
export function cleanFacts(over: Partial<TokenFacts> = {}): TokenFacts {
  const p = pool();
  return {
    address: TOKEN,
    headBlock: 50_000_000,
    contract: {
      isContract: true,
      codeSize: 5000,
      name: "Test",
      symbol: "TST",
      decimals: 18,
      totalSupply: 10n ** 27n,
      renounced: true,
      ownerSource: "owner()",
      owner: "0x0000000000000000000000000000000000000000",
      proxy: { kind: "none" },
      capabilities: {},
    },
    pools: [p],
    sim: {
      attempted: true,
      pool: p.id,
      poolKind: "uniswap-v4",
      stage: 0,
      canBuy: true,
      canSell: true,
      buyTaxPct: 0,
      sellTaxPct: 0,
      roundTripLossPct: 0.7,
    },
    creation: { ageSeconds: 10 * 86400 },
    creator: {},
    errors: [],
    ...over,
  };
}
