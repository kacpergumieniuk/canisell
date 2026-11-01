/**
 * Research helper: counts new pools created on Base in the last N blocks per DEX type,
 * and for Uniswap v4 groups them by hook address and by the tx `to` (launchpad factory).
 * Usage: npx tsx scripts/launch-census.ts [blocks=9000]
 */
import { createPublicClient, http, parseAbiItem, type Address } from "viem";
import { base } from "viem/chains";

const LOGS_RPC = process.env.LOGS_RPC_URL ?? "https://base-rpc.publicnode.com";
const client = createPublicClient({ chain: base, transport: http(LOGS_RPC) });
const span = BigInt(process.argv[2] ?? 9000);

const sources = {
  uniV2: {
    address: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6" as Address,
    event: parseAbiItem("event PairCreated(address indexed token0, address indexed token1, address pair, uint256 allPairsLength)"),
  },
  aerodromeV2: {
    address: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da" as Address,
    event: parseAbiItem("event PoolCreated(address indexed token0, address indexed token1, bool indexed stable, address pool, uint256)"),
  },
  uniV3: {
    address: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD" as Address,
    event: parseAbiItem("event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)"),
  },
  uniV4: {
    address: "0x498581fF718922c3f8e6A244956aF099B2652b2b" as Address,
    event: parseAbiItem("event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)"),
  },
};

const head = await client.getBlockNumber();
const fromBlock = head - span;
for (const [name, s] of Object.entries(sources)) {
  const logs = await client.getLogs({ address: s.address, event: s.event as any, fromBlock, toBlock: head });
  console.log(`${name}: ${logs.length} pools in last ${span} blocks`);
  if (name === "uniV4") {
    const byHook = new Map<string, number>();
    for (const l of logs as any[]) byHook.set(l.args.hooks, (byHook.get(l.args.hooks) ?? 0) + 1);
    console.log("  by hook:", [...byHook.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12));
    const byTo = new Map<string, number>();
    const sample = (logs as any[]).slice(-60);
    const txs = await Promise.all(sample.map((l) => client.getTransaction({ hash: l.transactionHash })));
    for (const t of txs) byTo.set(t.to ?? "create", (byTo.get(t.to ?? "create") ?? 0) + 1);
    console.log(`  tx.to of last ${sample.length}:`, [...byTo.entries()].sort((a, b) => b[1] - a[1]));
  }
}
