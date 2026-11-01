import { getAddress, isAddress, type Address } from "viem";
import { TtlCache } from "../cache.ts";
import { BASE, ENTRY_POINTS, KNOWN_ASSETS } from "../chain/addresses.ts";
import type { Clients } from "../chain/client.ts";
import { findCreation } from "./age.ts";
import { inspectContract } from "./contract.ts";
import { inspectCreator } from "./creator.ts";
import { discoverPools, type Discovery } from "./pools.ts";
import { ethUsd, PriceBook } from "./price.ts";
import { scoreToken } from "./score.ts";
import { analyzePool, pickPool, simulateRoundTrip } from "./simulate.ts";
import type { CreationFacts, CreatorFacts, SimResult, TokenFacts, Verdict } from "./types.ts";

export const ENGINE_VERSION = "0.1.0";
export const DISCLAIMER =
  "Automated on-chain risk signals for Base, not financial advice. A SAFE verdict means no mechanical trap was detected, not that the price will hold.";

export class InputError extends Error {
  status = 400;
}
export class NotTokenError extends Error {
  status = 422;
}
/** Upstream RPC trouble that would make the verdict unreliable: surfaced as 502 (and not charged). */
export class UpstreamError extends Error {
  status = 502;
}

// Creation facts never change: keep them for a day per isolate.
const creationCache = new TtlCache<CreationFacts>(24 * 3600 * 1000, 2000);

async function withTimeout<T>(p: Promise<T>, ms: number, label: string, errors: string[]): Promise<T | undefined> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, rej) => {
        t = setTimeout(() => rej(new Error("timeout")), ms);
      }),
    ]);
  } catch (e) {
    errors.push(`${label}: ${(e as Error).message?.slice(0, 160)}`);
    return undefined;
  } finally {
    clearTimeout(t);
  }
}

export interface VerdictResponse extends Verdict {
  address: Address;
  chain: "base";
  chainId: 8453;
  token: { name?: string; symbol?: string; decimals?: number; totalSupply?: string };
  launchpad: string | null;
  flags: {
    trading: SimResult;
    ownership: {
      note?: string;
      owner: Address | null;
      ownerSource?: string;
      renounced: boolean;
      capabilities: TokenFacts["contract"]["capabilities"];
      proxy: TokenFacts["contract"]["proxy"];
    };
    liquidity: {
      totalDepthUsd: number | null;
      pools: Array<Record<string, unknown>>;
    };
    creator: CreatorFacts;
    age: CreationFacts;
  };
  meta: { block: number; checkedAt: string; latencyMs: number; engine: string; partial: string[]; disclaimer: string };
}

export interface CheckOptions {
  simUsd: number;
}

export function parseTokenAddress(input: string): Address {
  if (!isAddress(input, { strict: false })) throw new InputError("Invalid address: expected 0x-prefixed 20-byte hex");
  return getAddress(input);
}

/** Gathers on-chain facts. Throws NotTokenError for non-ERC20 addresses. */
export async function gatherFacts(clients: Clients, address: Address, opts: CheckOptions): Promise<TokenFacts> {
  const { rpc } = clients;
  const errors: string[] = [];
  const head = Number(await rpc.getBlockNumber());

  const [contract, creation] = await Promise.all([
    inspectContract(rpc, address),
    creationCache.get(address)
      ? Promise.resolve(creationCache.get(address)!)
      : withTimeout(findCreation(clients.archive, clients.logs, address, head), 6_000, "age", errors).then((c) => {
          if (c?.createdBlock !== undefined || c?.olderThanDays !== undefined) creationCache.set(address, c);
          return c ?? {};
        }),
  ]);
  if (!contract.isContract) throw new NotTokenError("Address has no contract code on Base");
  if (contract.decimals === undefined || contract.totalSupply === undefined)
    throw new NotTokenError("Contract does not implement ERC-20 decimals()/totalSupply()");

  const prices = new PriceBook(rpc, ethUsd(rpc));
  const discovery: Discovery = (await withTimeout(discoverPools(clients, address, creation, head), 6_000, "pools", errors)) ?? {
    pools: [],
    errors: [],
    complete: false,
  };
  errors.push(...discovery.errors);
  if (discovery.pools.length === 0 && !discovery.complete)
    throw new UpstreamError(`Pool discovery incomplete (RPC errors), refusing to report "no pool": ${errors.join("; ").slice(0, 200)}`);
  const pools = (
    await Promise.all(
      discovery.pools.slice(0, 24).map((p) => withTimeout(analyzePool(rpc, p, address, contract.totalSupply!, prices), 5_000, `pool ${p.kind}`, errors)),
    )
  ).filter((p) => p !== undefined);

  // creator: launchpad-specific first, else the creation tx sender (unless it was a 4337 bundle)
  const creator: CreatorFacts = {};
  if (discovery.launchpadCreator) Object.assign(creator, discovery.launchpadCreator);
  else if (creation.userOpSender) Object.assign(creator, { address: creation.userOpSender, source: "user-op-sender" });
  else if (creation.txFrom && !(creation.txTo && ENTRY_POINTS.has(creation.txTo.toLowerCase())))
    Object.assign(creator, { address: creation.txFrom, source: "tx-sender" });

  const chosen = pickPool(pools);
  const simP: Promise<SimResult> = chosen
    ? withTimeout(simulateRoundTrip(rpc, chosen, address, opts.simUsd), 6_000, "simulation", errors).then(
        (s) => s ?? { attempted: false, note: "simulation timed out or errored" },
      )
    : Promise.resolve({ attempted: false, note: pools.length ? "no simulatable pool (v2/v3 need a WETH pair)" : "no pool" });
  const creatorP = creator.address
    ? withTimeout(inspectCreator(rpc, address, creator.address, contract.totalSupply!), 5_000, "creator", errors)
    : Promise.resolve(undefined);
  const [sim, cr] = await Promise.all([simP, creatorP]);
  if (cr) Object.assign(creator, cr);

  return {
    address,
    headBlock: head,
    knownAsset: KNOWN_ASSETS[address.toLowerCase()],
    launchpad: discovery.launchpad,
    contract,
    pools,
    sim,
    creation,
    creator,
    errors,
  };
}

const round = (v: number | undefined, d = 2) => (v === undefined ? undefined : Math.round(v * 10 ** d) / 10 ** d);

export function toResponse(f: TokenFacts, v: Verdict, startedAt: number): VerdictResponse {
  const priced = f.pools.filter((p) => p.depthUsd !== undefined);
  return {
    address: f.address,
    chain: "base",
    chainId: BASE.chainId,
    verdict: v.verdict,
    score: v.score,
    summary: v.summary,
    reasons: v.reasons,
    findings: v.findings,
    token: {
      name: f.contract.name,
      symbol: f.contract.symbol,
      decimals: f.contract.decimals,
      totalSupply: f.contract.totalSupply?.toString(),
    },
    launchpad: f.launchpad ?? null,
    flags: {
      trading: {
        ...f.sim,
        quoteIn: round(f.sim.quoteIn, 8),
        quoteInUsd: round(f.sim.quoteInUsd),
        buyTaxPct: round(f.sim.buyTaxPct),
        sellTaxPct: round(f.sim.sellTaxPct),
        roundTripLossPct: round(f.sim.roundTripLossPct),
      },
      ownership: {
        note:
          f.launchpad === "clanker" && f.contract.ownerSource === "admin()"
            ? "Clanker admin can only update token metadata."
            : undefined,
        owner: f.contract.owner ?? null,
        ownerSource: f.contract.ownerSource,
        renounced: f.contract.renounced,
        capabilities: f.contract.capabilities,
        proxy: f.contract.proxy,
      },
      liquidity: {
        totalDepthUsd: priced.length ? Math.round(priced.reduce((a, p) => a + p.depthUsd!, 0)) : null,
        // Empty standard-key pools are noise; keep pools with liquidity, the launchpad pool and the simulated one.
        pools: f.pools
          .filter((p) => (p.depthQuote ?? 1) > 0 || p.launchpad || p.id === f.sim.pool)
          .sort((a, b) => (b.depthUsd ?? -1) - (a.depthUsd ?? -1))
          .slice(0, 8)
          .map((p) => ({
          kind: p.kind,
          id: p.id,
          quote: p.quote,
          quoteSymbol: p.quoteSymbol,
          depthQuote: round(p.depthQuote, 6),
          depthUsd: round(p.depthUsd, 0),
          lp: p.lp,
          fee: p.key?.fee,
          tickSpacing: p.key?.tickSpacing,
          hooks: p.key?.hooks,
          launchpad: p.launchpad,
          source: p.source,
        })),
      },
      creator: f.creator,
      age: f.creation,
    },
    meta: {
      block: f.headBlock,
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      engine: ENGINE_VERSION,
      partial: f.errors,
      disclaimer: DISCLAIMER,
    },
  };
}

export async function checkToken(clients: Clients, address: Address, opts: CheckOptions): Promise<VerdictResponse> {
  const started = Date.now();
  const facts = await gatherFacts(clients, address, opts);
  return toResponse(facts, scoreToken(facts), started);
}
