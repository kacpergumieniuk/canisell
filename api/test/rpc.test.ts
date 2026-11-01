import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, parseAbi, toFunctionSelector, type Hex } from "viem";
import { BASE } from "../src/chain/addresses.ts";
import { inspectContract, SLOTS } from "../src/risk/contract.ts";
import { PM_ABI } from "../src/risk/pools.ts";
import { checkToken, NotTokenError, UpstreamError } from "../src/risk/verdict.ts";
import { mockClient, mockClients, sel, ZERO_WORD, type CallHandler } from "./helpers/mockRpc.ts";

const TOKEN = "0x1111111111111111111111111111111111111111";
const OWNER = "0x3333333333333333333333333333333333333333";
const IMPL = "0x4444444444444444444444444444444444444444";
const ERC20 = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function owner() view returns (address)",
]);
const push4 = (sig: string) => "63" + toFunctionSelector(sig).slice(2);
const word = (addr: string) => ("0x" + addr.slice(2).padStart(64, "0")) as Hex;
const addrResult = (a: string) => encodeAbiParameters([{ type: "address" }], [a as `0x${string}`]);

/** ERC-20 basics for TOKEN (+ optional owner); everything else reverts unless `extra` answers. */
function tokenCalls(opts: { owner?: string; extra?: CallHandler } = {}): CallHandler {
  return (a) => {
    const extra = opts.extra?.(a);
    if (extra !== undefined) return extra;
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
        return opts.owner ? addrResult(opts.owner) : undefined;
    }
    return undefined;
  };
}

describe("inspectContract (mocked RPC)", () => {
  it("finds owner, mint and blacklist capabilities", async () => {
    const code = ("0x6080" + push4("mint(address,uint256)") + push4("blacklist(address)") + push4("transfer(address,uint256)")) as Hex;
    const c = mockClient({ code: (a) => (a === TOKEN ? code : "0x"), call: tokenCalls({ owner: OWNER }) });
    const f = await inspectContract(c, TOKEN);
    expect(f).toMatchObject({ isContract: true, symbol: "MOCK", decimals: 18, owner: OWNER, ownerSource: "owner()", renounced: false });
    expect(f.capabilities.mint).toEqual(["mint(address,uint256)"]);
    expect(f.capabilities.blacklist).toEqual(["blacklist(address)"]);
  });

  it("treats owner == 0x0 as renounced", async () => {
    const c = mockClient({ code: () => "0x6080", call: tokenCalls({ owner: "0x0000000000000000000000000000000000000000" }) });
    expect((await inspectContract(c, TOKEN)).renounced).toBe(true);
  });

  it("detects an EIP-1967 proxy and scans the implementation bytecode", async () => {
    const implCode = ("0x" + push4("pause()") + push4("unpause()")) as Hex;
    const c = mockClient({
      code: (a) => (a === TOKEN ? "0x6080604052" : a === IMPL ? implCode : "0x"),
      storage: (a, slot) => (a === TOKEN && slot === SLOTS.eip1967Impl ? word(IMPL) : ZERO_WORD),
      call: tokenCalls({ owner: OWNER }),
    });
    const f = await inspectContract(c, TOKEN);
    expect(f.proxy).toMatchObject({ kind: "eip1967", implementation: IMPL });
    expect(f.capabilities.pause).toEqual(["pause()", "unpause()"]);
  });

  it("reports EOAs as non-contracts", async () => {
    const f = await inspectContract(mockClient({}), TOKEN);
    expect(f.isContract).toBe(false);
  });
});

describe("checkToken end-to-end (mocked RPC)", () => {
  /** Old token (code at every probed block), no pools anywhere, owner with mint power. */
  const noPoolCalls = (extra?: CallHandler) =>
    tokenCalls({
      owner: OWNER,
      extra: (a) => {
        const r = extra?.(a);
        if (r !== undefined) return r;
        const to = a.to;
        if (to === BASE.chainlinkEthUsd.toLowerCase())
          return encodeAbiParameters(
            [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }],
            [1n, 3000n * 10n ** 8n, 0n, 0n, 1n],
          );
        if ([BASE.v2Factory, BASE.v3Factory, BASE.aeroV2Factory, BASE.aeroClFactory].some((f) => f.toLowerCase() === to))
          return addrResult("0x0000000000000000000000000000000000000000");
        if (to === BASE.v4PoolManager.toLowerCase()) {
          const { args } = decodeFunctionData({ abi: PM_ABI, data: a.data });
          return encodeFunctionResult({ abi: PM_ABI, functionName: "extsload", result: (args[0] as Hex[]).map(() => ZERO_WORD) });
        }
        return undefined;
      },
    });
  const mintCode = ("0x6080" + push4("mint(address,uint256)")) as Hex;

  it("token without any pool and with an active minting owner gets DANGER", async () => {
    const clients = mockClients({ code: (a) => (a === TOKEN ? mintCode : "0x"), call: noPoolCalls() });
    const v = await checkToken(clients, TOKEN, { simUsd: 20 });
    expect(v.verdict).toBe("DANGER");
    expect(v.findings.map((f) => f.id)).toEqual(expect.arrayContaining(["no_pool", "owner_mint"]));
    expect(v.flags.age.olderThanDays).toBe(30);
    expect(v.flags.trading.attempted).toBe(false);
  });

  it("runs the simulator on a discovered v4 pool via eth_call with a code override", async () => {
    let simCalled = false;
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
        [{ stage, quoteIn: 10n ** 15n, buyExpected: 1000n, buyReceived: 1000n, sellSent: 1000n, sellArrived: 1000n, quoteOut: 0n, buyGas: 1n, sellGas: 0n, revertData: "0xdeadbeef" }],
      );
    const SIM = "0x5151515151515151515151515151515151515151";
    const clients = mockClients({
      code: (a) => (a === TOKEN ? mintCode : "0x"),
      call: noPoolCalls((a) => {
        // every standard v4 key is "initialized"
        if (a.to === BASE.v4PoolManager.toLowerCase()) {
          const { args } = decodeFunctionData({ abi: PM_ABI, data: a.data });
          return encodeFunctionResult({ abi: PM_ABI, functionName: "extsload", result: (args[0] as Hex[]).map(() => ("0x" + "0".repeat(63) + "1") as Hex) }); // sqrtPriceX96 = 1
        }
        if (a.to === SIM && a.override) {
          if (a.selector === toFunctionSelector("depthV4(address,(address,address,uint24,int24,address),bool,uint256)"))
            return encodeAbiParameters([{ type: "uint256" }, { type: "bytes" }], [10n ** 18n, "0x"]);
          simCalled = true;
          return simResult(4); // sell reverted
        }
        return undefined;
      }),
    });
    const v = await checkToken(clients, TOKEN, { simUsd: 20 });
    expect(simCalled).toBe(true);
    expect(v.flags.trading).toMatchObject({ attempted: true, stage: 4, canSell: false, error: "revert 0xdeadbeef" });
    expect(v.verdict).toBe("DANGER");
    expect(v.findings[0].id).toBe("cannot_sell");
  });

  it("refuses to answer 'no pool' when pool discovery itself failed", async () => {
    // extsload reverts -> discovery incomplete -> 502-class error instead of a false DANGER
    const failing = mockClients({
      code: (a) => (a === TOKEN ? mintCode : "0x"),
      call: (a) => (a.to === BASE.v4PoolManager.toLowerCase() ? undefined : noPoolCalls()(a)),
    });
    await expect(checkToken(failing, TOKEN, { simUsd: 20 })).rejects.toBeInstanceOf(UpstreamError);
  });

  it("rejects addresses without code", async () => {
    await expect(checkToken(mockClients({}), TOKEN, { simUsd: 20 })).rejects.toBeInstanceOf(NotTokenError);
  });
});
