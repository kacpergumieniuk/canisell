import { getContractAddress, type Address, type PublicClient } from "viem";
import { ERC20_ABI } from "./contract.ts";
import { looksLikeErc20 } from "./bytecode.ts";
import type { CreatorFacts } from "./types.ts";

const hasCode = (c: string | undefined) => !!c && c !== "0x";
/** EIP-7702 delegated EOAs keep CREATE-by-nonce semantics. */
const isEoaCode = (c: string | undefined) => !hasCode(c) || /^0xef0100/i.test(c ?? "");

/**
 * Creator facts: contract-or-EOA, nonce, share of supply, and (EOAs only) how many of the contracts at the
 * CREATE addresses of its last `maxNonces` nonces exist and look like ERC-20s. Launchpad deploys made through
 * factories are not counted; a full launch history needs an indexer.
 */
export async function inspectCreator(
  client: PublicClient,
  token: Address,
  creator: Address,
  totalSupply: bigint,
  maxNonces = 30,
): Promise<Omit<CreatorFacts, "address" | "source">> {
  const [code, nonce, bal] = await Promise.all([
    client.getCode({ address: creator }),
    client.getTransactionCount({ address: creator }),
    client.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [creator] }),
  ]);
  const out: Omit<CreatorFacts, "address" | "source"> = {
    isContract: !isEoaCode(code),
    nonce,
    holdingPct: totalSupply > 0n ? Number((bal * 1_000_000n) / totalSupply) / 10_000 : undefined,
  };
  if (!out.isContract && nonce > 0) {
    const from = Math.max(0, nonce - maxNonces);
    const addrs: Address[] = [];
    for (let n = from; n < nonce; n++) addrs.push(getContractAddress({ from: creator, nonce: BigInt(n) }));
    const codes = await Promise.all(addrs.map((a) => client.getCode({ address: a }).catch(() => undefined)));
    const deployed = codes.filter((c) => hasCode(c));
    out.recentDirectDeploys = {
      scannedNonces: addrs.length,
      contracts: deployed.length,
      tokens: deployed.filter((c) => looksLikeErc20(c!)).length,
    };
  }
  return out;
}
