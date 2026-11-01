import {
  createPublicClient,
  fallback,
  http,
  type Abi,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
  type StateOverride,
} from "viem";
import { base } from "viem/chains";

export interface ContractCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

export type CallResult<T = unknown> = { ok: true; value: T } | { ok: false; error: string };

export interface ReceiptLite {
  transactionHash: Hex;
  from: Address;
  to: Address | null;
  contractAddress: Address | null;
  logs: { address: Address; topics: Hex[]; logIndex: number }[];
}

/**
 * The narrow slice of chain access the risk engine needs. Production wraps viem; tests pass a
 * hand-written fake so every risk module can run without a network.
 */
export interface ChainReader {
  blockNumber(): Promise<bigint>;
  getCode(address: Address, blockNumber?: bigint): Promise<Hex | undefined>;
  getCodes(addresses: Address[], blockNumber?: bigint): Promise<(Hex | undefined)[]>;
  getStorageAt(address: Address, slot: Hex): Promise<Hex | undefined>;
  getBalance(address: Address): Promise<bigint>;
  getTransactionCount(address: Address): Promise<number>;
  /** Batched read-only calls (multicall3). Never throws; per-call failures are returned. */
  readMany(calls: ContractCall[]): Promise<CallResult[]>;
  /** Raw eth_call with optional state overrides; throws on revert. */
  call(args: { from?: Address; to: Address; data: Hex; stateOverride?: StateOverride; gas?: bigint }): Promise<Hex>;
  getBlockReceipts(blockNumber: bigint): Promise<ReceiptLite[]>;
  getLogs(args: { address: Address; topics: (Hex | null)[]; fromBlock: bigint; toBlock: bigint }): Promise<Log[]>;
}

export function createViemReader(rpcUrls: string[], logsRpcUrl: string): ChainReader {
  const transport =
    rpcUrls.length === 1
      ? http(rpcUrls[0], { batch: { batchSize: 25, wait: 5 }, timeout: 10_000, retryCount: 1 })
      : fallback(
          rpcUrls.map((u) => http(u, { batch: { batchSize: 25, wait: 5 }, timeout: 10_000, retryCount: 1 })),
          { rank: false },
        );
  const client: PublicClient = createPublicClient({
    chain: base,
    transport,
    batch: { multicall: { batchSize: 4096, wait: 5 } },
  }) as PublicClient;
  const logsClient: PublicClient = createPublicClient({
    chain: base,
    transport: http(logsRpcUrl, { timeout: 10_000, retryCount: 1 }),
  }) as PublicClient;

  return {
    blockNumber: () => client.getBlockNumber({ cacheTime: 1_000 }),
    getCode: (address, blockNumber) =>
      client.getCode(blockNumber === undefined ? { address } : { address, blockNumber }),
    getCodes: (addresses, blockNumber) =>
      Promise.all(
        addresses.map((address) =>
          client.getCode(blockNumber === undefined ? { address } : { address, blockNumber }),
        ),
      ),
    getStorageAt: (address, slot) => client.getStorageAt({ address, slot }),
    getBalance: (address) => client.getBalance({ address }),
    getTransactionCount: (address) => client.getTransactionCount({ address }),
    async readMany(calls) {
      if (calls.length === 0) return [];
      const res = await client.multicall({ contracts: calls as any, allowFailure: true });
      return res.map((r: any) =>
        r.status === "success"
          ? { ok: true as const, value: r.result }
          : { ok: false as const, error: String(r.error?.shortMessage ?? r.error?.message ?? r.error) },
      );
    },
    async call({ from, to, data, stateOverride, gas }) {
      const res = await client.call({ account: from, to, data, stateOverride, gas });
      return (res.data ?? "0x") as Hex;
    },
    async getBlockReceipts(blockNumber) {
      const raw = (await client.request({
        method: "eth_getBlockReceipts" as any,
        params: [`0x${blockNumber.toString(16)}`] as any,
      })) as any[];
      return (raw ?? []).map((r) => ({
        transactionHash: r.transactionHash,
        from: r.from,
        to: r.to ?? null,
        contractAddress: r.contractAddress ?? null,
        logs: (r.logs ?? []).map((l: any) => ({ address: l.address, topics: l.topics, logIndex: Number(l.logIndex) })),
      }));
    },
    getLogs: ({ address, topics, fromBlock, toBlock }) =>
      logsClient.request({
        method: "eth_getLogs",
        params: [{ address, topics: topics as any, fromBlock: `0x${fromBlock.toString(16)}`, toBlock: `0x${toBlock.toString(16)}` }],
      }) as unknown as Promise<Log[]>,
  };
}
