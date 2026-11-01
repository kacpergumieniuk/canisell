import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, parseAbi, toFunctionSelector, type Hex } from "viem";
import { BASE } from "../../src/chain/addresses.ts";
import { PM_ABI, ZORA_COIN_ABI } from "../../src/risk/pools.ts";
import { sel, type CallHandler, type MockSpec } from "./mockRpc.ts";

export const TOKEN = "0x1111111111111111111111111111111111111111";
export const OWNER = "0x3333333333333333333333333333333333333333";
export const CREATOR = "0x5555555555555555555555555555555555555555";
export const SIM = "0x5151515151515151515151515151515151515151";
export const ZORA_HOOK = "0x777777777777777777777777777777777777beef";

const ERC20 = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function owner() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
]);
const push4 = (signature: string) => "63" + toFunctionSelector(signature).slice(2);
export const MINT_CODE = ("0x6080" + push4("mint(address,uint256)")) as Hex;
const addr = (a: string) => encodeAbiParameters([{ type: "address" }], [a as `0x${string}`]);
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

/** ERC-20 getters for TOKEN, an active owner, and a 5% creator balance. */
export const tokenCalls: CallHandler = (a) => {
  if (a.to !== TOKEN) return undefined;
  switch (a.selector) {
    case sel("name()"):
      return encodeFunctionResult({ abi: ERC20, functionName: "name", result: "Mock" });
    case sel("symbol()"):
      return encodeFunctionResult({ abi: ERC20, functionName: "symbol", result: "MOCK" });
    case sel("decimals()"):
      return encodeFunctionResult({ abi: ERC20, functionName: "decimals", result: 18 });
    case sel("totalSupply()"):
      return encodeFunctionResult({ abi: ERC20, functionName: "totalSupply", result: 10n ** 27n });
    case sel("owner()"):
      return addr(OWNER);
    case sel("balanceOf(address)"):
      return encodeFunctionResult({ abi: ERC20, functionName: "balanceOf", result: 5n * 10n ** 25n });
  }
  return undefined;
};

/** ETH/USD feed and empty v2/v3/Aerodrome factories; every v4 slot reads as `slot0Word`. */
export function chainCalls(slot0Word: Hex): CallHandler {
  return (a) => {
    if (a.to === BASE.chainlinkEthUsd.toLowerCase())
      return encodeAbiParameters(
        [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }],
        [1n, 3000n * 10n ** 8n, 0n, 0n, 1n],
      );
    if ([BASE.v2Factory, BASE.v3Factory, BASE.aeroV2Factory, BASE.aeroClFactory].some((f) => f.toLowerCase() === a.to)) return addr(ZERO_ADDR);
    if (a.to === BASE.v4PoolManager.toLowerCase()) {
      const { args } = decodeFunctionData({ abi: PM_ABI, data: a.data });
      return encodeFunctionResult({ abi: PM_ABI, functionName: "extsload", result: (args[0] as Hex[]).map(() => slot0Word) });
    }
    return undefined;
  };
}

const simResult = (stage: number) =>
  encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "stage", type: "uint8" },
          { name: "quoteIn", type: "uint256" },
          { name: "buyExpected", type: "uint256" },
          { name: "buyReceived", type: "uint256" },
          { name: "sellSent", type: "uint256" },
          { name: "sellArrived", type: "uint256" },
          { name: "quoteOut", type: "uint256" },
          { name: "buyGas", type: "uint256" },
          { name: "sellGas", type: "uint256" },
          { name: "revertData", type: "bytes" },
        ],
      },
    ],
    [{ stage, quoteIn: 10n ** 15n, buyExpected: 1000n, buyReceived: 1000n, sellSent: 1000n, sellArrived: 1000n, quoteOut: 10n ** 15n, buyGas: 1n, sellGas: 1n, revertData: "0x" }],
  );

export const isDepthCall = (selector: string) => selector === toFunctionSelector("depthV4(address,(address,address,uint24,int24,address),bool,uint256)");

/** Old token, mint-capable owner, no pool anywhere: the verdict path that needs the (slow) log scan. */
export function noPoolSpec(extra: Partial<MockSpec> = {}): MockSpec {
  return {
    code: (a) => (a === TOKEN ? MINT_CODE : "0x"),
    call: (a) => tokenCalls(a) ?? chainCalls(("0x" + "0".repeat(64)) as Hex)(a),
    ...extra,
  };
}

/** A Zora-style launchpad token whose v4 pool is live and whose simulation passes (stage 0). */
export function zoraSpec(extra: Partial<MockSpec> = {}): MockSpec {
  const live = chainCalls(("0x" + "0".repeat(63) + "1") as Hex);
  return {
    code: (a) => (a === TOKEN ? MINT_CODE : "0x"),
    txCount: 5,
    call: (a) => {
      const t = tokenCalls(a);
      if (t !== undefined) return t;
      if (a.to === TOKEN && a.selector === sel("getPoolKey()"))
        return encodeFunctionResult({
          abi: ZORA_COIN_ABI,
          functionName: "getPoolKey",
          result: { currency0: BASE.weth, currency1: TOKEN, fee: 10000, tickSpacing: 200, hooks: ZORA_HOOK },
        });
      if (a.to === TOKEN && a.selector === sel("payoutRecipient()")) return addr(CREATOR);
      if (a.to === SIM && a.override) return isDepthCall(a.selector) ? encodeAbiParameters([{ type: "uint256" }, { type: "bytes" }], [10n ** 18n, "0x"]) : simResult(0);
      return live(a);
    },
    ...extra,
  };
}
