import { toFunctionSelector, type Address, type Hex, getAddress } from "viem";
import type { Capability } from "./types.ts";

/**
 * Walks EVM bytecode and returns every 4-byte immediate pushed with PUSH4 (0x63).
 * Solidity dispatchers compare calldata selectors against PUSH4 constants, so this is
 * a good (heuristic) list of the external functions a contract implements.
 * PUSH data is skipped correctly, so bytes inside other immediates are not misread as opcodes.
 */
export function extractPush4Selectors(code: Hex): Set<string> {
  const out = new Set<string>();
  const hex = code.startsWith("0x") ? code.slice(2) : code;
  const n = hex.length / 2;
  let i = 0;
  while (i < n) {
    const op = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (op >= 0x60 && op <= 0x7f) {
      const len = op - 0x5f;
      if (op === 0x63 && i + 4 < n) out.add("0x" + hex.slice((i + 1) * 2, (i + 5) * 2).toLowerCase());
      i += 1 + len;
    } else {
      i += 1;
    }
  }
  return out;
}

/** EIP-1167 minimal proxy: 363d3d373d3d3d363d73<impl>5af43d82803e903d91602b57fd5bf3 */
export function detectMinimalProxy(code: Hex): Address | null {
  const m = /^0x363d3d373d3d3d363d73([0-9a-fA-F]{40})5af43d82803e903d91602b57fd5bf3$/.exec(code);
  return m ? getAddress("0x" + m[1]) : null;
}

/** Owner-controlled capabilities and the function signatures that indicate them. */
export const CAPABILITY_SIGNATURES: Record<Capability, string[]> = {
  mint: [
    "mint(address,uint256)",
    "mint(uint256)",
    "mintTo(address,uint256)",
    "issue(uint256)",
    "configureMinter(address,uint256)",
  ],
  blacklist: [
    "blacklist(address)",
    "addToBlacklist(address)",
    "setBlacklist(address,bool)",
    "blacklistAddress(address,bool)",
    "addBlackList(address)",
    "setBlacklisted(address,bool)",
    "isBlacklisted(address)",
    "addBots(address[])",
    "setBots(address[],bool)",
    "setBot(address,bool)",
    "blockBots(address[])",
    "isBot(address)",
    "bots(address)",
  ],
  pause: ["pause()", "unpause()", "setPaused(bool)", "setPause(bool)"],
  feeSetter: [
    "setFee(uint256)",
    "setFees(uint256,uint256)",
    "setTax(uint256)",
    "setTaxes(uint256,uint256)",
    "setBuyFee(uint256)",
    "setSellFee(uint256)",
    "setBuyTax(uint256)",
    "setSellTax(uint256)",
    "updateFees(uint256,uint256)",
    "updateBuyFees(uint256,uint256,uint256)",
    "updateSellFees(uint256,uint256,uint256)",
    "setTaxFeePercent(uint256)",
    "setLiquidityFeePercent(uint256)",
    "setFeePercent(uint256)",
    "setTransferFee(uint256)",
  ],
  tradingToggle: [
    "enableTrading()",
    "openTrading()",
    "startTrading()",
    "setTradingEnabled(bool)",
    "setTrading(bool)",
    "toggleTrading()",
  ],
  limitSetter: [
    "setMaxTxAmount(uint256)",
    "setMaxTxPercent(uint256)",
    "setMaxWalletSize(uint256)",
    "setMaxWallet(uint256)",
    "updateMaxTxnAmount(uint256)",
    "updateMaxWalletAmount(uint256)",
    "setCooldownEnabled(bool)",
  ],
  feeExemption: ["excludeFromFee(address)", "excludeFromFees(address,bool)", "setExcludeFromFees(address,bool)"],
};

const SELECTOR_INDEX: Array<[string, Capability, string]> = Object.entries(CAPABILITY_SIGNATURES).flatMap(
  ([cap, sigs]) => sigs.map((s) => [toFunctionSelector(s), cap as Capability, s] as [string, Capability, string]),
);

const ERC20_CORE = ["transfer(address,uint256)", "balanceOf(address)", "totalSupply()"].map((s) => toFunctionSelector(s));
export function looksLikeErc20(code: Hex): boolean {
  const sels = extractPush4Selectors(code);
  return ERC20_CORE.every((s) => sels.has(s));
}

export function detectCapabilities(selectors: Set<string>): Partial<Record<Capability, string[]>> {
  const found: Partial<Record<Capability, string[]>> = {};
  for (const [sel, cap, sig] of SELECTOR_INDEX) {
    if (selectors.has(sel)) (found[cap] ??= []).push(sig);
  }
  return found;
}
