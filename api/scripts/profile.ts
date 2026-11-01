/**
 * Profiles the verdict engine against live Base RPCs (no payment involved): prints every outbound
 * JSON-RPC HTTP request with its start offset and duration, then the engine's own phase timings.
 *
 *   npx tsx scripts/profile.ts 0xToken [0xToken2 ...]
 *   RUNS=2 npx tsx scripts/profile.ts 0x...     # repeat to see warm numbers
 */
import { makeClients } from "../src/chain/client.ts";
import { loadConfig } from "../src/config.ts";
import { Timings } from "../src/timing.ts";
import { checkToken, parseTokenAddress } from "../src/risk/verdict.ts";

const cfg = loadConfig(process.env);
const realFetch = globalThis.fetch;
let t0 = 0;
const rows: string[] = [];
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input?.url ?? input);
  const started = performance.now();
  let methods = "";
  try {
    const body = JSON.parse(String(init?.body ?? "null"));
    methods = (Array.isArray(body) ? body : [body]).map((b: any) => b?.method + (b?.method === "eth_getCode" ? `@${b.params?.[1]}` : "")).join(",");
  } catch {}
  try {
    const res = await realFetch(input, init);
    rows.push(`  +${Math.round(started - t0)}ms  ${Math.round(performance.now() - started)}ms  ${res.status}  ${new URL(url).host}  ${methods.slice(0, 110)}`);
    return res;
  } catch (e) {
    rows.push(`  +${Math.round(started - t0)}ms  ${Math.round(performance.now() - started)}ms  ERR  ${new URL(url).host}  ${methods.slice(0, 110)}`);
    throw e;
  }
}) as typeof fetch;

for (const raw of process.argv.slice(2)) {
  for (let run = 1; run <= Number(process.env.RUNS ?? 1); run++) {
    rows.length = 0;
    const timing = new Timings();
    t0 = performance.now();
    try {
      const v = await checkToken(makeClients(cfg), parseTokenAddress(raw), { simUsd: cfg.simUsd, timing });
      console.log(`\n${raw} run ${run}: ${v.verdict} (${v.token.symbol}) engine ${Math.round(performance.now() - t0)} ms, ${rows.length} http requests, partial=${JSON.stringify(v.meta.partial)}`);
    } catch (e) {
      console.log(`\n${raw} run ${run}: ERROR ${(e as Error).message.slice(0, 160)}`);
    }
    console.log("  phases:", timing.header());
    if (process.env.QUIET !== "1") console.log(rows.join("\n"));
  }
}
