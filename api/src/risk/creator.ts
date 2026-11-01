import { getContractAddress, type Address, type PublicClient } from "viem";
import { ERC20_ABI } from "./contract.ts";
import { looksLikeErc20 } from "./bytecode.ts";
import type { CreatorFacts } from "./types.ts";

const hasCode = (c: string | undefined) => !!c && c !== "0x";
/** EIP-7702 delegated EOAs keep CREATE-by-nonce semantics. */
const isEoaCode = (c: string | undefined) => !hasCode(c) || /^0xef0100/i.test(c ?? "");

type CreatorExtras = Omit<CreatorFacts, "address" | "source">;

/** Contract-or-EOA, nonce and share of supply: three reads in one round trip. */
export async function inspectCreatorBasics(client: PublicClient, token: Address, creator: Address, totalSupply: bigint): Promise<CreatorExtras> {
  const [code, nonce, bal] = await Promise.all([
    client.getCode({ address: creator }),
    client.getTransactionCount({ address: creator }),
    client.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [creator] }),
  ]);
  return {
    isContract: !isEoaCode(code),
    nonce,
    holdingPct: totalSupply > 0n ? Number((bal * 1_000_000n) / totalSupply) / 10_000 : undefined,
  };
}

/**
 * Direct-deploy history (EOAs only): how many of the contracts at the CREATE addresses of the creator's last
 * `maxNonces` nonces exist and look like ERC-20s. Launchpad deploys made through factories are not counted; a
 * full launch history needs an indexer. This is the heavy part (one eth_getCode per nonce), so callers time-box it.
 */
export async function scanCreatorDeploys(client: PublicClient, creator: Address, nonce: number, maxNonces = 30): Promise<NonNullable<CreatorFacts["recentDirectDeploys"]>> {
  const from = Math.max(0, nonce - maxNonces);
  const addrs: Address[] = [];
  for (let n = from; n < nonce; n++) addrs.push(getContractAddress({ from: creator, nonce: BigInt(n) }));
  // A failed lookup must not read as "no contract there": let the caller decide (time-box / unknown).
  const codes = await Promise.all(addrs.map((a) => client.getCode({ address: a })));
  const deployed = codes.filter((c) => hasCode(c));
  return { scannedNonces: addrs.length, contracts: deployed.length, tokens: deployed.filter((c) => looksLikeErc20(c!)).length };
}

/** Both parts in sequence (kept for callers that do not need the split). */
export async function inspectCreator(
  client: PublicClient,
  token: Address,
  creator: Address,
  totalSupply: bigint,
  maxNonces = 30,
): Promise<CreatorExtras> {
  const out = await inspectCreatorBasics(client, token, creator, totalSupply);
  if (!out.isContract && (out.nonce ?? 0) > 0) out.recentDirectDeploys = await scanCreatorDeploys(client, creator, out.nonce!, maxNonces);
  return out;
}
