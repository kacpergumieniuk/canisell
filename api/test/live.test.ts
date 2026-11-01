/**
 * Live smoke test against Base mainnet public RPCs. Skipped unless LIVE=1:
 *   npm run test:live
 */
import { describe, expect, it } from "vitest";
import { makeClients } from "../src/chain/client.ts";
import { loadConfig } from "../src/config.ts";
import { checkToken } from "../src/risk/verdict.ts";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

describe.skipIf(process.env.LIVE !== "1")("live: USDC on Base", () => {
  it("returns a SAFE verdict with real on-chain facts within a few seconds", async () => {
    const cfg = loadConfig(process.env);
    const started = Date.now();
    const v = await checkToken(makeClients(cfg), USDC, { simUsd: cfg.simUsd });
    const ms = Date.now() - started;
    console.log(JSON.stringify({ verdict: v.verdict, score: v.score, ms, reasons: v.reasons, trading: v.flags.trading, partial: v.meta.partial }, null, 2));

    expect(v.token.symbol).toBe("USDC");
    expect(v.token.decimals).toBe(6);
    expect(v.verdict).toBe("SAFE");
    // Circle's controls are detected even though the asset is allowlisted
    expect(v.flags.ownership.capabilities.blacklist?.length).toBeGreaterThan(0);
    expect(v.flags.ownership.capabilities.pause?.length).toBeGreaterThan(0);
    expect(v.flags.ownership.proxy.kind).not.toBe("none");
    // a real buy+sell round trip through the deepest WETH pool
    expect(v.flags.trading).toMatchObject({ attempted: true, stage: 0, canBuy: true, canSell: true });
    expect(v.flags.trading.roundTripLossPct!).toBeLessThan(5);
    expect(v.flags.liquidity.totalDepthUsd!).toBeGreaterThan(1_000_000);
    expect(v.flags.age.olderThanDays).toBe(30);
    expect(ms).toBeLessThan(15_000);
  }, 30_000);
});
