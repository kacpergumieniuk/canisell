import { describe, expect, it } from "vitest";
import { toFunctionSelector, type Hex } from "viem";
import { detectCapabilities, detectMinimalProxy, extractPush4Selectors, looksLikeErc20 } from "../src/risk/bytecode.ts";

const push4 = (sig: string) => "63" + toFunctionSelector(sig).slice(2);

describe("bytecode analysis", () => {
  it("extracts PUSH4 immediates", () => {
    const code = ("0x6080" + push4("mint(address,uint256)") + "14" + push4("pause()") + "57") as Hex;
    const s = extractPush4Selectors(code);
    expect(s.has(toFunctionSelector("mint(address,uint256)"))).toBe(true);
    expect(s.has(toFunctionSelector("pause()"))).toBe(true);
  });

  it("does not read selectors hidden inside other PUSH immediates", () => {
    // PUSH32 whose data happens to contain 0x63 + a selector must not produce a match
    const hidden = push4("blacklist(address)");
    const code = ("0x7f" + hidden + "00".repeat(32 - hidden.length / 2)) as Hex;
    expect(extractPush4Selectors(code).size).toBe(0);
  });

  it("maps selectors to capabilities", () => {
    const code = ("0x" + push4("blacklist(address)") + push4("setFees(uint256,uint256)") + push4("enableTrading()")) as Hex;
    const caps = detectCapabilities(extractPush4Selectors(code));
    expect(caps.blacklist).toEqual(["blacklist(address)"]);
    expect(caps.feeSetter).toEqual(["setFees(uint256,uint256)"]);
    expect(caps.tradingToggle).toEqual(["enableTrading()"]);
    expect(caps.mint).toBeUndefined();
  });

  it("detects EIP-1167 minimal proxies", () => {
    const impl = "5dbd43785954d43c1643a0caf2ecef9e0056ff13";
    expect(detectMinimalProxy(`0x363d3d373d3d3d363d73${impl}5af43d82803e903d91602b57fd5bf3`)).toBe(
      "0x5DbD43785954D43c1643A0caf2ecEf9E0056Ff13",
    );
    expect(detectMinimalProxy("0x6080604052")).toBeNull();
  });

  it("recognises ERC-20 shaped bytecode", () => {
    const erc20 = ("0x" + push4("transfer(address,uint256)") + push4("balanceOf(address)") + push4("totalSupply()")) as Hex;
    expect(looksLikeErc20(erc20)).toBe(true);
    expect(looksLikeErc20(("0x" + push4("transfer(address,uint256)")) as Hex)).toBe(false);
  });
});
