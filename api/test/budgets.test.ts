import { beforeEach, describe, expect, it } from "vitest";
import { checkToken, clearCreationCache, NotTokenError, UpstreamError } from "../src/risk/verdict.ts";
import { BASE } from "../src/chain/addresses.ts";
import { CREATOR, isDepthCall, MINT_CODE, noPoolSpec, SIM, TOKEN, zoraSpec } from "./helpers/engineMock.ts";
import { mockClients } from "./helpers/mockRpc.ts";

const FAST = { age: 150, creator: 150, creatorHistory: 150, sim: 150, analyze: 1_000, pools: 2_000, optionalDeadline: 1_000 };
const ids = (v: { findings: Array<{ id: string }> }) => v.findings.map((f) => f.id);
const isHistoricGetCode = (method: string, params: any) => method === "eth_getCode" && params[1] !== "latest";

beforeEach(() => clearCreationCache());

describe("time boxes and partial results", () => {
  it("a hung age search does not hang the verdict: age is reported unknown", async () => {
    const t = Date.now();
    const v = await checkToken(mockClients(noPoolSpec({ hang: isHistoricGetCode })), TOKEN, { simUsd: 20, budgets: FAST });
    expect(Date.now() - t).toBeLessThan(3_000);
    expect(ids(v)).toContain("age_unknown");
    expect(v.flags.age).toEqual({});
    expect(v.meta.partial.join(" ")).toMatch(/age: timeout/);
    // the core findings are still there
    expect(ids(v)).toEqual(expect.arrayContaining(["no_pool", "owner_mint"]));
    expect(v.verdict).toBe("DANGER");
  });

  it("a hung creator lookup is reported unknown while the simulation still runs and decides", async () => {
    const v = await checkToken(
      mockClients(zoraSpec({ hang: (m, p) => m === "eth_getCode" && String(p[0]).toLowerCase() === CREATOR })),
      TOKEN,
      { simUsd: 20, budgets: FAST },
    );
    expect(ids(v)).toContain("creator_unknown");
    expect(v.flags.trading).toMatchObject({ attempted: true, stage: 0, canSell: true });
    expect(v.flags.creator).toMatchObject({ address: CREATOR, source: "zora-payout" });
    expect(v.meta.partial.join(" ")).toMatch(/creator: timeout/);
  });

  it("a hung deploy-history scan keeps the creator basics and marks only the history unknown", async () => {
    const v = await checkToken(
      mockClients(zoraSpec({ hang: (m, p) => m === "eth_getCode" && ![TOKEN, CREATOR].includes(String(p[0]).toLowerCase()) && p[1] === "latest" })),
      TOKEN,
      { simUsd: 20, budgets: FAST },
    );
    expect(ids(v)).toContain("creator_history_unknown");
    expect(ids(v)).not.toContain("creator_unknown");
    expect(v.flags.creator).toMatchObject({ address: CREATOR, nonce: 5, holdingPct: 5 });
    expect(v.flags.creator.recentDirectDeploys).toBeUndefined();
  });

  it("a hung simulation is never skipped silently: the verdict says sell-ability was not verified", async () => {
    const v = await checkToken(
      mockClients(
        zoraSpec({
          hang: (m, p) => m === "eth_call" && p[0].to.toLowerCase() === SIM && !!p[2] && !isDepthCall(p[0].data.slice(0, 10)),
        }),
      ),
      TOKEN,
      { simUsd: 20, budgets: FAST },
    );
    expect(v.flags.trading.attempted).toBe(false);
    expect(ids(v)).toContain("not_simulated");
    expect(v.meta.partial.join(" ")).toMatch(/simulation: timeout/);
  });

  it("a live launchpad pool skips the slow v4 log scan; a token with no launchpad pool still gets it", async () => {
    const zoraLog: Array<{ method: string; params: any }> = [];
    await checkToken(mockClients(zoraSpec(), zoraLog), TOKEN, { simUsd: 20, budgets: FAST });
    expect(zoraLog.filter((l) => l.method === "eth_getLogs")).toHaveLength(0);

    clearCreationCache();
    // no launchpad pool and an age that could not be determined: the scan of the latest 10k blocks still happens
    const unknownLog: Array<{ method: string; params: any }> = [];
    await checkToken(mockClients(noPoolSpec({ hang: isHistoricGetCode }), unknownLog), TOKEN, { simUsd: 20, budgets: FAST });
    expect(unknownLog.filter((l) => l.method === "eth_getLogs").length).toBeGreaterThan(0);
  });
});

describe("coarse age", () => {
  it("lets the v4 log scan start from the bracket round alone: a token under 5 h old needs no exact creation block", async () => {
    const head = 50_000_000;
    let historic = 0;
    const log: Array<{ method: string; params: any }> = [];
    const clients = mockClients(
      noPoolSpec({
        blockNumber: BigInt(head),
        // created ~3000 blocks ago
        code: (a, block) => (a === TOKEN ? (block === "latest" || parseInt(block, 16) >= head - 3_000 ? MINT_CODE : "0x") : "0x"),
        // the five bracket probes answer; the exact search after them never does
        hang: (m, p) => m === "eth_getCode" && p[1] !== "latest" && ++historic > 5,
      }),
      log,
    );
    const t = Date.now();
    const v = await checkToken(clients, TOKEN, { simUsd: 20, budgets: FAST });
    const scans = log.filter((l) => l.method === "eth_getLogs");
    expect(scans.length).toBeGreaterThan(0);
    expect(parseInt(scans[0].params[0].fromBlock, 16)).toBe(head - 9_999);
    expect(ids(v)).toContain("age_unknown"); // exact age did not arrive in its box, and says so
    expect(Date.now() - t).toBeLessThan(2_000);
  });
});

describe("transport failures are not read as facts", () => {
  it("failing token getters give an upstream error, not 'not an ERC-20'", async () => {
    const clients = mockClients(noPoolSpec({ fail: (m, p) => m === "eth_call" && p[0].to.toLowerCase() === TOKEN }));
    const err = await checkToken(clients, TOKEN, { simUsd: 20, budgets: FAST }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NotTokenError);
  });

  it("failing factory lookups are not reported as 'no pool'", async () => {
    const clients = mockClients(noPoolSpec({ fail: (m, p) => m === "eth_call" && p[0].to.toLowerCase() === BASE.v2Factory.toLowerCase() }));
    await expect(checkToken(clients, TOKEN, { simUsd: 20, budgets: FAST })).rejects.toBeInstanceOf(UpstreamError);
  });

  it("a revert (token has no owner()) is a fact, not a failure", async () => {
    const v = await checkToken(mockClients(noPoolSpec()), TOKEN, { simUsd: 20, budgets: FAST });
    expect(v.token.symbol).toBe("MOCK");
  });
});
