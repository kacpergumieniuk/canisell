import type { Finding, TokenFacts, Verdict, VerdictLabel } from "./types.ts";

export const THRESHOLDS = { safe: 75, caution: 45 } as const;

const fmtUsd = (v: number) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}k` : `$${v.toFixed(0)}`);
const fmtAge = (s: number) => (s < 3600 ? `${Math.round(s / 60)} min` : s < 86400 ? `${(s / 3600).toFixed(1)} h` : `${(s / 86400).toFixed(1)} days`);

/** Deterministic rules: facts in, findings + score + label out. No I/O. */
export function scoreToken(f: TokenFacts): Verdict {
  const findings: Finding[] = [];
  const add = (id: string, severity: Finding["severity"], penalty: number, message: string) =>
    findings.push({ id, severity, penalty, message });
  const c = f.contract;
  const ownerActive = !c.renounced;
  const sim = f.sim;
  const simPool = f.pools.find((p) => p.id === sim.pool);
  const hooked = !!simPool?.key && BigInt(simPool.key.hooks) !== 0n;
  const hookNote = hooked ? " Simulated as a same-transaction buy then sell through a v4 hook; some anti-MEV hooks penalize this more than a later sale." : "";

  // --- sell-ability and taxes
  if (sim.attempted && sim.stage !== undefined) {
    if (sim.stage === 1 || sim.stage === 2) add("cannot_buy", "high", 40, `Simulated buy failed${sim.error ? ` (${sim.error})` : ""}; trading may be disabled or restricted.`);
    else if (sim.stage === 3 || sim.stage === 4) add("cannot_sell", "critical", 100, `Simulated sell failed${sim.error ? ` (${sim.error})` : ""}: likely honeypot.`);
    else if (sim.stage === 5) add("sim_error", "medium", 10, "Buy/sell simulation could not run on the selected pool.");
    const tax = Math.max(sim.buyTaxPct ?? 0, sim.sellTaxPct ?? 0);
    if (tax >= 50) add("extreme_tax", "critical", 100, `Transfer tax of ${tax.toFixed(1)}% (buy ${sim.buyTaxPct?.toFixed(1) ?? "?"}%, sell ${sim.sellTaxPct?.toFixed(1) ?? "?"}%).`);
    else if (tax >= 10) add("high_tax", "high", 30, `High transfer tax: buy ${sim.buyTaxPct?.toFixed(1)}%, sell ${sim.sellTaxPct?.toFixed(1)}%.`);
    else if (tax >= 3) add("tax", "medium", 10, `Transfer tax: buy ${sim.buyTaxPct?.toFixed(1)}%, sell ${sim.sellTaxPct?.toFixed(1)}%.`);
    const rt = sim.roundTripLossPct;
    if (rt !== undefined) {
      if (rt >= 50) add("roundtrip_extreme", "critical", 100, `Buying then selling loses ${rt.toFixed(1)}% (fees, hook taxes and slippage).${hookNote}`);
      else if (rt >= 20) add("roundtrip_high", "high", 25, `Buying then selling loses ${rt.toFixed(1)}%.${hookNote}`);
      else if (rt >= 10) add("roundtrip_medium", "medium", 10, `Buying then selling loses ${rt.toFixed(1)}%.`);
      else add("roundtrip_ok", "info", 0, `Buy and sell simulated OK; round trip costs ${rt.toFixed(1)}%.`);
    }
  } else if (f.pools.length > 0) {
    add("not_simulated", "medium", 15, `Sell-ability not verified${sim.note ? ` (${sim.note})` : ""}.`);
  }

  // --- liquidity
  if (f.pools.length === 0) {
    add("no_pool", "critical", 100, "No pool found on Uniswap v2/v3/v4 or Aerodrome: cannot be traded on supported DEXes.");
  } else {
    const usd = f.pools.map((p) => p.depthUsd ?? 0).reduce((a, b) => a + b, 0);
    const priced = f.pools.some((p) => p.depthUsd !== undefined);
    if (priced) {
      if (usd < 1_000) add("liquidity_tiny", "high", 30, `Exit liquidity only ~${fmtUsd(usd)}.`);
      else if (usd < 10_000) add("liquidity_low", "medium", 15, `Low exit liquidity (~${fmtUsd(usd)}).`);
      else if (usd < 50_000) add("liquidity_modest", "low", 5, `Modest exit liquidity (~${fmtUsd(usd)}).`);
      else add("liquidity_ok", "info", 0, `Exit liquidity ~${fmtUsd(usd)}.`);
    } else add("liquidity_unpriced", "low", 5, "Liquidity could not be priced in USD.");
    const main = f.pools.reduce((a, b) => ((b.depthUsd ?? 0) > (a.depthUsd ?? 0) ? b : a));
    if (main.lp.status === "not-burned") add("lp_not_burned", "medium", 15, `Only ${main.lp.burnedPct?.toFixed(0)}% of LP tokens are burned; liquidity can be pulled unless locked elsewhere.`);
    else if (main.lp.status === "unknown") add("lp_unknown", "low", 5, "LP lock status unknown (position NFT); liquidity may be removable.");
    else if (main.lp.status === "locked-by-launchpad") add("lp_locked", "info", 0, `Liquidity is locked by the ${main.launchpad} launchpad.`);
    else add("lp_burned", "info", 0, "LP tokens are burned.");
    if (main.kind === "uniswap-v4" && main.key && BigInt(main.key.hooks) !== 0n && !main.launchpad)
      add("unknown_hook", "low", 5, "Pool uses an unrecognized Uniswap v4 hook that can alter swaps.");
  }

  // --- owner privileges
  const caps = c.capabilities;
  if (ownerActive) {
    if (caps.mint) add("owner_mint", "high", 25, "Owner-controlled contract can mint new tokens.");
    if (caps.blacklist) add("owner_blacklist", "high", 25, "Contract can blacklist holders.");
    if (caps.feeSetter) add("owner_fees", "high", 20, "Owner can change transfer taxes.");
    if (caps.pause) add("owner_pause", "medium", 15, "Transfers can be paused.");
    if (caps.tradingToggle) add("owner_trading", "medium", 15, "Owner controls a trading on/off switch.");
    if (caps.limitSetter) add("owner_limits", "low", 5, "Owner can change max-transaction/wallet limits.");
    if (c.owner) add("owner_active", "info", 0, `Owner ${c.owner} has not renounced (${c.ownerSource}).`);
  } else if (c.ownerSource !== "none") add("renounced", "info", 0, "Ownership renounced.");
  if (c.proxy.kind === "eip1967" || c.proxy.kind === "eip1967-beacon" || c.proxy.kind === "zeppelinos")
    add("upgradeable", "high", 25, "Upgradeable proxy: the token code can be replaced by its admin.");

  // --- creator
  const cr = f.creator;
  if (cr.holdingPct !== undefined) {
    if (cr.holdingPct >= 20) add("creator_whale", "high", 20, `Creator holds ${cr.holdingPct.toFixed(1)}% of supply.`);
    else if (cr.holdingPct >= 5) add("creator_holds", "medium", 10, `Creator holds ${cr.holdingPct.toFixed(1)}% of supply.`);
  }
  const deploys = cr.recentDirectDeploys;
  if (deploys && deploys.tokens >= 3)
    add("serial_deployer", "medium", 10, `Creator deployed ${deploys.tokens} other tokens in its last ${deploys.scannedNonces} transactions.`);
  if (cr.isContract === false && cr.nonce !== undefined && cr.nonce <= 3)
    add("fresh_creator", "low", 5, `Creator wallet is fresh (${cr.nonce} transactions).`);

  // --- age
  const age = f.creation.ageSeconds;
  if (age !== undefined) {
    if (age < 3600) add("age_new", "low", 10, `Token is ${fmtAge(age)} old.`);
    else if (age < 86400) add("age_day", "low", 5, `Token is ${fmtAge(age)} old.`);
    else add("age", "info", 0, `Token is ${fmtAge(age)} old.`);
  } else if (f.creation.olderThanDays) add("age_old", "info", 0, `Token is older than ${f.creation.olderThanDays} days.`);

  // --- known blue chips
  if (f.knownAsset) {
    const notes = findings.filter((x) => x.penalty > 0).map((x) => x.message);
    return {
      verdict: "SAFE",
      score: 95,
      summary: `Known asset: ${f.knownAsset}. Issuer controls are expected for this asset.`,
      reasons: [`Recognized blue-chip asset: ${f.knownAsset}.`, ...notes],
      findings: findings.map((x) => ({ ...x, penalty: 0 })),
    };
  }

  const critical = findings.some((x) => x.severity === "critical");
  const score = Math.max(0, Math.min(100, 100 - findings.reduce((a, x) => a + x.penalty, 0)));
  const verdict: VerdictLabel = critical || score < THRESHOLDS.caution ? "DANGER" : score < THRESHOLDS.safe ? "CAUTION" : "SAFE";
  const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || b.penalty - a.penalty);
  const top = findings.find((x) => x.penalty > 0);
  const summary =
    verdict === "SAFE"
      ? "No blocking risks found: buy and sell simulate cleanly and no abusive owner controls detected."
      : verdict === "CAUTION"
        ? `Tradeable but risky: ${top?.message ?? "see reasons"}`
        : `Avoid: ${top?.message ?? "see reasons"}`;
  return { verdict, score: critical ? Math.min(score, 10) : score, summary, reasons: findings.map((x) => x.message), findings };
}
