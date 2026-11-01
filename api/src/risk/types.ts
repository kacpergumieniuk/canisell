import type { Address, Hex } from "viem";

export type Capability =
  | "mint"
  | "blacklist"
  | "pause"
  | "feeSetter"
  | "tradingToggle"
  | "limitSetter"
  | "feeExemption";

export type ProxyKind = "none" | "eip1967" | "eip1967-beacon" | "zeppelinos" | "eip1167-clone";

export interface ContractFacts {
  isContract: boolean;
  codeSize: number;
  name?: string;
  symbol?: string;
  decimals?: number;
  totalSupply?: bigint;
  owner?: Address;
  /** which getter returned the owner: owner() / getOwner() / admin() */
  ownerSource?: string;
  renounced: boolean;
  proxy: { kind: ProxyKind; implementation?: Address; admin?: Address };
  /** capability -> matched function signatures found in (implementation) bytecode */
  capabilities: Partial<Record<Capability, string[]>>;
}

export type PoolKind = "uniswap-v4" | "uniswap-v3" | "uniswap-v2" | "aerodrome-v2" | "aerodrome-cl";

export interface PoolKeyV4 {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

export interface PoolRef {
  kind: PoolKind;
  /** pair/pool address for v2/v3, poolId for v4 */
  id: Hex;
  quote: Address;
  tokenIs0: boolean;
  key?: PoolKeyV4;
  source: "zora" | "clanker" | "standard-key" | "factory" | "logs";
  launchpad?: Launchpad;
}

export type Launchpad = "zora" | "clanker";

export interface PoolFacts extends PoolRef {
  quoteSymbol?: string;
  quoteDecimals?: number;
  quoteUsd?: number;
  /** quote obtainable when dumping supply (v4) or quote reserve (v2/v3), in quote units */
  depthQuote?: number;
  depthUsd?: number;
  lp: { status: "burned" | "locked-by-launchpad" | "not-burned" | "unknown"; burnedPct?: number };
}

export interface SimResult {
  attempted: boolean;
  pool?: Hex;
  poolKind?: PoolKind;
  /** 0 ok, 1 buy swap reverted, 2 receive reverted, 3 sell transfer reverted, 4 sell swap reverted, 5 setup */
  stage?: number;
  quoteIn?: number;
  quoteInUsd?: number;
  canBuy?: boolean;
  canSell?: boolean;
  buyTaxPct?: number;
  sellTaxPct?: number;
  roundTripLossPct?: number;
  buyGas?: number;
  sellGas?: number;
  error?: string;
  note?: string;
}

export interface CreationFacts {
  createdBlock?: number;
  createdAt?: number; // unix seconds
  ageSeconds?: number;
  /** set when the token is older than the search window */
  olderThanDays?: number;
  creationTx?: Hex;
  txFrom?: Address;
  txTo?: Address;
  /** ERC-4337 smart account that created the token (when txTo is an EntryPoint) */
  userOpSender?: Address;
}

export interface CreatorFacts {
  address?: Address;
  source?: "tx-sender" | "user-op-sender" | "zora-payout" | "clanker-admin";
  isContract?: boolean;
  nonce?: number;
  holdingPct?: number;
  /** Best-effort history without an indexer: contracts at the CREATE addresses of the creator's last N nonces. */
  recentDirectDeploys?: { scannedNonces: number; contracts: number; tokens: number };
}

export interface TokenFacts {
  address: Address;
  headBlock: number;
  knownAsset?: string;
  launchpad?: Launchpad;
  contract: ContractFacts;
  pools: PoolFacts[];
  sim: SimResult;
  creation: CreationFacts;
  creator: CreatorFacts;
  /** sub-checks that failed or timed out */
  errors: string[];
}

export type VerdictLabel = "SAFE" | "CAUTION" | "DANGER";

export interface Finding {
  id: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  penalty: number;
  message: string;
}

export interface Verdict {
  verdict: VerdictLabel;
  score: number;
  summary: string;
  reasons: string[];
  findings: Finding[];
}
