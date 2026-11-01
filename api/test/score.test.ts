import { describe, expect, it } from "vitest";
import { scoreToken } from "../src/risk/score.ts";
import { cleanFacts, pool } from "./helpers/facts.ts";

const ids = (v: ReturnType<typeof scoreToken>) => v.findings.map((f) => f.id);

describe("scoreToken", () => {
  it("clean, liquid, renounced token is SAFE", () => {
    const v = scoreToken(cleanFacts());
    expect(v.verdict).toBe("SAFE");
    expect(v.score).toBeGreaterThanOrEqual(90);
    expect(ids(v)).toContain("roundtrip_ok");
  });

  it("failed sell simulation is a honeypot: DANGER with score <= 10", () => {
    const f = cleanFacts();
    f.sim = { ...f.sim, stage: 4, canSell: false, roundTripLossPct: undefined, error: "Error(TRANSFER_FROM_FAILED)" };
    const v = scoreToken(f);
    expect(v.verdict).toBe("DANGER");
    expect(v.score).toBeLessThanOrEqual(10);
    expect(v.reasons[0]).toMatch(/sell failed.*honeypot/i);
  });

  it("blocked sell transfer (stage 3) is also DANGER", () => {
    const f = cleanFacts();
    f.sim = { ...f.sim, stage: 3, canSell: false, roundTripLossPct: undefined };
    expect(scoreToken(f).verdict).toBe("DANGER");
  });

  it("failed buy is heavily penalised but not critical", () => {
    const f = cleanFacts();
    f.sim = { ...f.sim, stage: 1, canBuy: false, canSell: false, roundTripLossPct: undefined };
    const v = scoreToken(f);
    expect(ids(v)).toContain("cannot_buy");
    expect(v.verdict).not.toBe("SAFE");
  });

  it("sell tax >= 50% is DANGER, 10-50% is high, 3-10% is medium", () => {
    const tax = (sellTaxPct: number) => {
      const f = cleanFacts();
      f.sim = { ...f.sim, sellTaxPct };
      return scoreToken(f);
    };
    expect(tax(60).verdict).toBe("DANGER");
    expect(ids(tax(25))).toContain("high_tax");
    expect(ids(tax(5))).toContain("tax");
  });

  it("extreme round-trip loss through a hook is DANGER and mentions the same-tx caveat", () => {
    const hooked = pool({ key: { ...pool().key!, hooks: "0x2222222222222222222222222222222222222222" } });
    const f = cleanFacts({ pools: [hooked] });
    f.sim = { ...f.sim, roundTripLossPct: 99.9 };
    const v = scoreToken(f);
    expect(v.verdict).toBe("DANGER");
    expect(v.reasons[0]).toMatch(/same-transaction/);
    expect(ids(v)).toContain("unknown_hook");
  });

  it("active owner with mint + blacklist + fee setter is not SAFE", () => {
    const f = cleanFacts();
    f.contract = {
      ...f.contract,
      renounced: false,
      owner: "0x3333333333333333333333333333333333333333",
      capabilities: { mint: ["mint(address,uint256)"], blacklist: ["blacklist(address)"], feeSetter: ["setFee(uint256)"] },
    };
    const v = scoreToken(f);
    expect(v.verdict).toBe("DANGER");
    expect(ids(v)).toEqual(expect.arrayContaining(["owner_mint", "owner_blacklist", "owner_fees"]));
  });

  it("owner capabilities are ignored once ownership is renounced", () => {
    const f = cleanFacts();
    f.contract = { ...f.contract, capabilities: { mint: ["mint(address,uint256)"], pause: ["pause()"] } };
    expect(scoreToken(f).verdict).toBe("SAFE");
  });

  it("upgradeable proxy is penalised even when renounced", () => {
    const f = cleanFacts();
    f.contract = { ...f.contract, proxy: { kind: "eip1967", implementation: "0x4444444444444444444444444444444444444444" } };
    expect(ids(scoreToken(f))).toContain("upgradeable");
  });

  it("EIP-1167 clones are not treated as upgradeable", () => {
    const f = cleanFacts();
    f.contract = { ...f.contract, proxy: { kind: "eip1167-clone", implementation: "0x4444444444444444444444444444444444444444" } };
    expect(ids(scoreToken(f))).not.toContain("upgradeable");
  });

  it("no pool at all is DANGER", () => {
    const v = scoreToken(cleanFacts({ pools: [], sim: { attempted: false, note: "no pool" } }));
    expect(v.verdict).toBe("DANGER");
    expect(ids(v)).toContain("no_pool");
  });

  it("liquidity tiers", () => {
    const at = (usd: number) => ids(scoreToken(cleanFacts({ pools: [pool({ depthUsd: usd })] })));
    expect(at(500)).toContain("liquidity_tiny");
    expect(at(5_000)).toContain("liquidity_low");
    expect(at(20_000)).toContain("liquidity_modest");
    expect(at(1_000_000)).toContain("liquidity_ok");
  });

  it("LP not burned on a v2 pair is flagged; launchpad-locked LP is not", () => {
    expect(ids(scoreToken(cleanFacts({ pools: [pool({ kind: "uniswap-v2", lp: { status: "not-burned", burnedPct: 0 } })] })))).toContain(
      "lp_not_burned",
    );
    expect(ids(scoreToken(cleanFacts({ pools: [pool({ launchpad: "clanker", lp: { status: "locked-by-launchpad" } })] })))).toContain(
      "lp_locked",
    );
  });

  it("creator concentration, serial deployer and fresh wallet", () => {
    const v = scoreToken(cleanFacts({ creator: { holdingPct: 35, isContract: false, nonce: 2, recentDirectDeploys: { scannedNonces: 30, contracts: 6, tokens: 5 } } }));
    expect(ids(v)).toEqual(expect.arrayContaining(["creator_whale", "serial_deployer", "fresh_creator"]));
  });

  it("very new tokens get an age penalty", () => {
    expect(ids(scoreToken(cleanFacts({ creation: { ageSeconds: 600 } })))).toContain("age_new");
    expect(ids(scoreToken(cleanFacts({ creation: { olderThanDays: 30 } })))).toContain("age_old");
  });

  it("known blue-chip assets are SAFE but still list issuer controls", () => {
    const f = cleanFacts({ knownAsset: "USDC (Circle)" });
    f.contract = { ...f.contract, renounced: false, capabilities: { blacklist: ["blacklist(address)"] }, proxy: { kind: "zeppelinos" } };
    const v = scoreToken(f);
    expect(v.verdict).toBe("SAFE");
    expect(v.reasons.join(" ")).toMatch(/blacklist/);
    expect(v.findings.every((x) => x.penalty === 0)).toBe(true);
  });

  it("is deterministic", () => {
    expect(scoreToken(cleanFacts())).toEqual(scoreToken(cleanFacts()));
  });
});
