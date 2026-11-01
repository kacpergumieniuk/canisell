import { getAddress, toEventSelector, type Address, type PublicClient } from "viem";
import { BLOCK_TIME_SECONDS, ENTRY_POINTS } from "../chain/addresses.ts";

/** Same signature in EntryPoint v0.6/v0.7/v0.8; topic[2] is the smart-account sender. */
const USER_OP_EVENT = toEventSelector(
  "UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
);
import type { CreationFacts } from "./types.ts";

/** Bracket probes, in blocks back from head: 1h, 5h, 1d, 7d, 30d. */
const BRACKETS = [1_800, 9_000, 43_200, 302_400, 1_296_000];

/** What the first (bracket) round already tells, long before the exact creation block is known. */
export interface CoarseAge {
  /** code existed 30 days ago (the search window): older than anything we resolve exactly */
  olderThan30d: boolean;
  /** otherwise: the token did not exist this many blocks ago, i.e. it was created within that many blocks of head */
  createdWithinBlocks?: number;
}
/** Wider rounds mean fewer sequential round trips (a day-old token needs 3 instead of 4); JSON-RPC batching keeps it one HTTP request. */
const PROBES_PER_ROUND = 15;

async function hasCodeAt(client: PublicClient, address: Address, block: number): Promise<boolean> {
  const code = await client.getCode({ address, blockNumber: BigInt(block) });
  return !!code && code !== "0x";
}

/**
 * Finds the first block where `token` has code, using archive eth_getCode on `archive` (k-ary search,
 * PROBES_PER_ROUND parallel probes per round, which JSON-RPC batching turns into one request).
 * Then resolves the creation tx through the first log the token emitted in that block; block, log and
 * transaction lookups go through `rpc` (a one-block eth_getLogs is allowed on every provider).
 */
export async function findCreation(
  archive: PublicClient,
  rpc: PublicClient,
  token: Address,
  head: number,
  /** Called as soon as the bracket round is back (one round trip), before the exact search. */
  onCoarse?: (coarse: CoarseAge) => void,
): Promise<CreationFacts> {
  const probes = await Promise.all(BRACKETS.map((d) => hasCodeAt(archive, token, Math.max(0, head - d))));
  const firstMissing = probes.findIndex((has) => !has);
  if (firstMissing === -1) {
    onCoarse?.({ olderThan30d: true });
    return { olderThanDays: 30 };
  }
  onCoarse?.({ olderThan30d: false, createdWithinBlocks: BRACKETS[firstMissing] });

  let lo = Math.max(0, head - BRACKETS[firstMissing]); // no code
  let hi = firstMissing === 0 ? head : head - BRACKETS[firstMissing - 1]; // has code
  while (hi - lo > 1) {
    const step = (hi - lo) / (PROBES_PER_ROUND + 1);
    const points = [...new Set(Array.from({ length: PROBES_PER_ROUND }, (_, i) => Math.round(lo + step * (i + 1))))].filter(
      (b) => b > lo && b < hi,
    );
    if (points.length === 0) break;
    const res = await Promise.all(points.map((b) => hasCodeAt(archive, token, b)));
    let newLo = lo;
    let newHi = hi;
    for (let i = 0; i < points.length; i++) {
      if (res[i]) {
        newHi = points[i];
        break;
      }
      newLo = points[i];
    }
    lo = newLo;
    hi = newHi;
  }

  const createdBlock = hi;
  const facts: CreationFacts = { createdBlock, ageSeconds: (head - createdBlock) * BLOCK_TIME_SECONDS };
  const [block, firstLogs] = await Promise.all([
    rpc.getBlock({ blockNumber: BigInt(createdBlock) }).catch(() => undefined),
    rpc.getLogs({ address: token, fromBlock: BigInt(createdBlock), toBlock: BigInt(createdBlock) }).catch(() => []),
  ]);
  if (block) {
    facts.createdAt = Number(block.timestamp);
    facts.ageSeconds = Math.max(0, Math.floor(Date.now() / 1000) - facts.createdAt);
  }
  const hash = firstLogs[0]?.transactionHash;
  if (hash) {
    facts.creationTx = hash;
    const tx = await rpc.getTransaction({ hash }).catch(() => undefined);
    if (tx) {
      facts.txFrom = getAddress(tx.from);
      facts.txTo = tx.to ? getAddress(tx.to) : undefined;
      // ERC-4337: tx.from is the bundler; the creator is the sender of the user op that emitted the token logs.
      if (facts.txTo && ENTRY_POINTS.has(facts.txTo.toLowerCase())) {
        const receipt = await rpc.getTransactionReceipt({ hash }).catch(() => undefined);
        const firstTokenLog = firstLogs[0]?.logIndex ?? 0;
        const op = receipt?.logs.find(
          (l) => l.topics[0] === USER_OP_EVENT && l.address.toLowerCase() === facts.txTo!.toLowerCase() && l.logIndex > firstTokenLog,
        );
        if (op?.topics[2]) facts.userOpSender = getAddress(`0x${op.topics[2].slice(26)}`);
      }
    }
  }
  return facts;
}
