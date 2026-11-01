import { getAddress, isAddress, type Address } from "viem";
import { TtlCache, workersEdgeCache } from "../cache.ts";
import { BASE, ENTRY_POINTS, KNOWN_ASSETS } from "../chain/addresses.ts";
import type { Clients } from "../chain/client.ts";
import { findCreation, type CoarseAge } from "./age.ts";
import { inspectContract } from "./contract.ts";
import { inspectCreatorBasics, scanCreatorDeploys } from "./creator.ts";
import { discoverPools, type Discovery } from "./pools.ts";
import { ethUsd, PriceBook } from "./price.ts";
import { scoreToken } from "./score.ts";
import type { Timings } from "../timing.ts";
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
/** Same facts, shared by every isolate in the data center (no-op outside Workers). Exact creation facts are immutable. */
const creationEdge = workersEdgeCache<CreationFacts>(24 * 3600, "creation-v1");
/** Test hook. */
export const clearCreationCache = () => creationCache.clear();

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

/** Time boxes in ms. Required phases fail the request (502, not charged); optional ones degrade to "unknown". */
export interface Budgets {
  /** optional: exact creation block / tx (archive bisection, ~6 sequential round trips for a young token) */
  age: number;
  /** required: launchpad + factory + v4 pool discovery */
  pools: number;
  /** required per pool: depth and LP status (a pool that times out is dropped and noted) */
  analyze: number;
  /** required: the buy+sell simulation. Never shortened: it is what the verdict is for. */
  sim: number;
  /** optional: creator wallet, balance share */
  creator: number;
  /** optional: creator's recent deploys (one eth_getCode per nonce) */
  creatorHistory: number;
  /** optional phases must be done this long after the request started, whatever their own budget says */
  optionalDeadline: number;
}
export const BUDGETS: Budgets = { age: 2_500, pools: 5_000, analyze: 4_000, sim: 5_000, creator: 1_500, creatorHistory: 1_000, optionalDeadline: 3_000 };

export interface CheckOptions {
  simUsd: number;
  /** Optional per-request phase timings (Server-Timing / logs). */
  timing?: Timings;
  /** Test hook: override time boxes. */
  budgets?: Partial<Budgets>;
}

export function parseTokenAddress(input: string): Address {
  if (!isAddress(input, { strict: false })) throw new InputError("Invalid address: expected 0x-prefixed 20-byte hex");
  return getAddress(input);
}

/**
 * Gathers on-chain facts. Throws NotTokenError for non-ERC20 addresses.
 *
 * Everything independent runs at once: contract facts, ETH price, pool discovery and the age search all start
 * together (the age search only waits for the chain head). Pool discovery does not wait for the age; the creator
 * check starts as soon as the creator is known, in parallel with pool analysis and the simulation. The optional
 * checks (age, creator, creator history) are time-boxed and reported as unknown instead of holding the answer.
 */
export async function gatherFacts(clients: Clients, address: Address, opts: CheckOptions): Promise<TokenFacts> {
  const { rpc } = clients;
  const b: Budgets = { ...BUDGETS, ...opts.budgets };
  const errors: string[] = [];
  const unknown: NonNullable<TokenFacts["unknown"]> = [];
  const T = opts.timing;
  const t0 = Date.now();
  const track = <X>(name: string, p: Promise<X>) => (T ? T.track(name, p) : p);
  /** Remaining time for an optional phase: its own budget, capped by the shared deadline (never below 250 ms). */
  const boxed = (ms: number) => Math.max(250, Math.min(ms, t0 + b.optionalDeadline - Date.now()));
  // Side promises must never surface as unhandled rejections when the main flow bails out early.
  const quiet = <X>(p: Promise<X>) => (p.catch(() => {}), p);

  const headP = quiet(track("head", rpc.getBlockNumber().then(Number)));
  const contractP = quiet(track("contract", inspectContract(rpc, address)));
  // The ETH/USD feed read starts now instead of after the age search.
  const prices = new PriceBook(rpc, ethUsd(rpc));

  // Creation facts never change: memory first, then the data center's Cache API, then the archive search.
  let resolveCoarse: (c: CoarseAge | undefined) => void = () => {};
  const coarseP = new Promise<CoarseAge | undefined>((r) => (resolveCoarse = r));
  const fromCache = async (): Promise<CreationFacts | undefined> => creationCache.get(address) ?? (await creationEdge.get(address));
  const creationP: Promise<CreationFacts> = quiet(
    fromCache()
      .then((cached) => {
        if (cached) {
          resolveCoarse(cached.olderThanDays ? { olderThan30d: true } : undefined);
          return cached;
        }
        return headP
          .then((head) => track("age", withTimeout(findCreation(clients.archive, rpc, address, head, resolveCoarse), b.age, "age", errors)))
          .then((c) => {
            if (c?.createdBlock !== undefined || c?.olderThanDays !== undefined) {
              creationCache.set(address, c);
              T?.background.push(creationEdge.put(address, c));
              return c;
            }
            unknown.push("age");
            return c ?? {};
          });
      })
      .catch((e) => {
        errors.push(`age: ${(e as Error).message?.slice(0, 160)}`);
        unknown.push("age");
        return {} as CreationFacts;
      })
      .finally(() => resolveCoarse(undefined)), // no coarse answer (cache hit with exact facts, timeout, error): do not leave anyone waiting
  );

  const discoveryP = quiet(
    withTimeout(track("pools", discoverPools(clients, address, { head: headP, creation: creationP, coarse: coarseP })), b.pools, "pools", errors),
  );

  const contract = await contractP;
  if (!contract.isContract) throw new NotTokenError("Address has no contract code on Base");
  if (contract.decimals === undefined || contract.totalSupply === undefined)
    throw new NotTokenError("Contract does not implement ERC-20 decimals()/totalSupply()");
  const totalSupply = contract.totalSupply;

  const discovery: Discovery = (await discoveryP) ?? { pools: [], errors: [], complete: false };
  errors.push(...discovery.errors);
  if (discovery.pools.length === 0 && !discovery.complete)
    throw new UpstreamError(`Pool discovery incomplete (RPC errors), refusing to report "no pool": ${errors.join("; ").slice(0, 200)}`);

  // creator: launchpad-specific first, else the creation tx sender (unless it was a 4337 bundle).
  // Starts as soon as the address is known and runs alongside pool analysis and the simulation.
  const creatorP = quiet(
    (async (): Promise<CreatorFacts> => {
      const creator: CreatorFacts = {};
      if (discovery.launchpadCreator) Object.assign(creator, discovery.launchpadCreator);
      else {
        const creation = await creationP;
        if (creation.userOpSender) Object.assign(creator, { address: creation.userOpSender, source: "user-op-sender" });
        else if (creation.txFrom && !(creation.txTo && ENTRY_POINTS.has(creation.txTo.toLowerCase())))
          Object.assign(creator, { address: creation.txFrom, source: "tx-sender" });
      }
      if (!creator.address) return creator;
      const basics = await withTimeout(track("creator", inspectCreatorBasics(rpc, address, creator.address, totalSupply)), boxed(b.creator), "creator", errors);
      if (!basics) {
        unknown.push("creator");
        return creator;
      }
      Object.assign(creator, basics);
      if (!basics.isContract && (basics.nonce ?? 0) > 0) {
        const history = await withTimeout(track("creator_history", scanCreatorDeploys(rpc, creator.address, basics.nonce!)), boxed(b.creatorHistory), "creator history", errors);
        if (history) creator.recentDirectDeploys = history;
        else unknown.push("creator-history");
      }
      return creator;
    })().catch((e) => {
      errors.push(`creator: ${(e as Error).message?.slice(0, 160)}`);
      unknown.push("creator");
      return {} as CreatorFacts;
    }),
  );

  const pools = (
    await track(
      "analyze",
      Promise.all(
        discovery.pools.slice(0, 24).map((p) => withTimeout(analyzePool(rpc, p, address, totalSupply, prices), b.analyze, `pool ${p.kind}`, errors)),
      ),
    )
  ).filter((p) => p !== undefined);

  const chosen = pickPool(pools);
  const sim: SimResult = chosen
    ? ((await withTimeout(track("sim", simulateRoundTrip(rpc, chosen, address, opts.simUsd)), b.sim, "simulation", errors)) ?? {
        attempted: false,
        note: "simulation timed out or errored",
      })
    : { attempted: false, note: pools.length ? "no simulatable pool (v2/v3 need a WETH pair)" : "no pool" };

  const [creator, creation, head] = await Promise.all([creatorP, creationP, headP]);

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
    unknown: unknown.length ? unknown : undefined,
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
