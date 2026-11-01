import type { Address } from "viem";

/** Base mainnet (chain id 8453) contract addresses. */
export const BASE = {
  chainId: 8453,
  weth: "0x4200000000000000000000000000000000000006",
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  usdbc: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
  native: "0x0000000000000000000000000000000000000000",
  chainlinkEthUsd: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
  v4PoolManager: "0x498581fF718922c3f8e6A244956aF099B2652b2b",
  v4PositionManager: "0x7C5f5A4bBd8fD63184577525326123B519429bDc",
  v2Factory: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6",
  v3Factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
  aeroV2Factory: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da",
  aeroClFactory: "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A",
  clankerV4Factory: "0xE85A59c628F7d27878ACeB4bf3b35733630083a9",
  zoraFactory: "0x777777751622c0d3258f214F9DF38E35BF45baF3",
} as const satisfies Record<string, Address | number>;

export const ENTRY_POINTS = new Set(
  [
    "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789", // v0.6
    "0x0000000071727De22E5E9d8BAf0edAc6f37da032", // v0.7
    "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108", // v0.8
  ].map((a) => a.toLowerCase()),
);

export const BURN_ADDRESSES = new Set(
  ["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dEaD"].map((a) =>
    a.toLowerCase(),
  ),
);

/** Large, well-known assets. Their issuer controls are real but expected; verdict is SAFE with notes. */
export const KNOWN_ASSETS: Record<string, string> = {
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "USDC (Circle)",
  "0x4200000000000000000000000000000000000006": "WETH",
  "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca": "USDbC (bridged USDC)",
  "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": "cbBTC (Coinbase)",
  "0x50c5725949a6f0c72e6c4a641f24049a917db0cb": "DAI",
  "0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22": "cbETH (Coinbase)",
  "0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452": "wstETH",
  "0x940181a94a35a4569e4529a3cdfb74e38fd98631": "AERO",
  "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2": "USDT",
  "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42": "EURC (Circle)",
};

/** Simulator is injected (state override) at this address; it is also the eth_call `from`, so tx.origin == msg.sender. */
export const SIMULATOR_ADDRESS = "0x5151515151515151515151515151515151515151" as Address;

export const BLOCK_TIME_SECONDS = 2;
