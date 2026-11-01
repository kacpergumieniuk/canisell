import { describe, expect, it } from "vitest";
import { encodeErrorResult, parseAbi } from "viem";
import { interpretSim, pickPool, type RawSim } from "../src/risk/simulate.ts";
import { pool } from "./helpers/facts.ts";

const raw = (over: Partial<RawSim> = {}): RawSim => ({
  stage: 0,
  quoteIn: 1000n,
  buyExpected: 10_000n,
  buyReceived: 10_000n,
  sellSent: 10_000n,
  sellArrived: 10_000n,
  quoteOut: 980n,
  buyGas: 100_000n,
  sellGas: 90_000n,
  revertData: "0x",
  ...over,
});

describe("interpretSim", () => {
  it("clean round trip", () => {
    const r = interpretSim(raw());
    expect(r).toMatchObject({ canBuy: true, canSell: true, buyTaxPct: 0, sellTaxPct: 0, roundTripLossPct: 2 });
  });

  it("measures transfer taxes from balance deltas", () => {
    const r = interpretSim(raw({ buyReceived: 9_000n, sellSent: 9_000n, sellArrived: 8_100n, quoteOut: 700n }));
    expect(r.buyTaxPct).toBe(10);
    expect(r.sellTaxPct).toBe(10);
    expect(r.roundTripLossPct).toBe(30);
  });

  it("sell revert means cannot sell and decodes the reason", () => {
    const revertData = encodeErrorResult({ abi: parseAbi(["error Error(string)"]), errorName: "Error", args: ["blacklisted"] });
    const r = interpretSim(raw({ stage: 4, quoteOut: 0n, revertData }));
    expect(r.canBuy).toBe(true);
    expect(r.canSell).toBe(false);
    expect(r.roundTripLossPct).toBeUndefined();
    expect(r.error).toBe("Error(blacklisted)");
  });

  it("buy revert means cannot buy", () => {
    const r = interpretSim(raw({ stage: 1, buyExpected: 0n, buyReceived: 0n, sellSent: 0n, sellArrived: 0n, quoteOut: 0n, revertData: "0xdeadbeef" }));
    expect(r).toMatchObject({ canBuy: false, canSell: false, error: "revert 0xdeadbeef" });
  });
});

describe("pickPool", () => {
  it("prefers the deepest priced pool", () => {
    const a = pool({ id: "0x01", depthUsd: 1_000 });
    const b = pool({ id: "0x02", depthUsd: 9_000 });
    expect(pickPool([a, b])?.id).toBe("0x02");
  });

  it("skips v2/v3 pools that are not WETH-quoted (cannot fund them)", () => {
    const usdcV2 = pool({ id: "0x03", kind: "uniswap-v2", quote: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", depthUsd: 1e6 });
    const v4 = pool({ id: "0x04", depthUsd: 10 });
    expect(pickPool([usdcV2, v4])?.id).toBe("0x04");
  });

  it("still picks an empty fresh pool so the round trip gets tested", () => {
    expect(pickPool([pool({ id: "0x05", depthQuote: 0, depthUsd: 0 })])?.id).toBe("0x05");
  });
});
