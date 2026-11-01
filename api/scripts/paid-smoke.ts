/**
 * End-to-end paid call against a deployed API: pays the 402 with a real wallet and prints the verdict and settlement.
 *
 *   PAYER_KEY=0x... API_URL=https://... npx tsx scripts/paid-smoke.ts [tokenAddress]
 *
 * Use a dedicated low-balance wallet on the API's payment network (Base Sepolia by default).
 * The key is read from env only and never printed.
 */
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const key = process.env.PAYER_KEY as `0x${string}` | undefined;
const api = (process.env.API_URL ?? "http://localhost:8787").replace(/\/$/, "");
const token = process.argv[2] ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // USDC on Base
if (!key) throw new Error("PAYER_KEY is not set");

const account = privateKeyToAccount(key);
const client = new x402Client();
registerExactEvmScheme(client, { signer: account });
const http = new x402HTTPClient(client);
const url = `${api}/v1/verdict/${token}`;

const t0 = Date.now();
const first = await fetch(url, { headers: { accept: "application/json" } });
console.log(`unpaid: ${first.status} in ${Date.now() - t0} ms`);
if (first.status !== 402) throw new Error(`expected 402, got ${first.status}`);
const tSign = Date.now();
const required = http.getPaymentRequiredResponse((n) => first.headers.get(n), await first.json());
const headers = http.encodePaymentSignatureHeader(await client.createPaymentPayload(required));

console.log(`client: signing took ${Date.now() - tSign} ms`);
const started = Date.now();
const paid = await fetch(url, { headers: { accept: "application/json", ...headers } });
const body = await paid.text();
console.log(`paid: ${paid.status} in ${Date.now() - started} ms (payer ${account.address})`);
console.log(`server-timing: ${paid.headers.get("Server-Timing") ?? "(none)"}`);
const receipt = paid.headers.get("PAYMENT-RESPONSE");
if (receipt) console.log("settlement:", JSON.stringify(http.getPaymentSettleResponse((n) => paid.headers.get(n))));
if (paid.status !== 200) console.log("body:", body.slice(0, 300));
try {
  const v = JSON.parse(body);
  console.log(`verdict: ${v.verdict} score=${v.score} — ${v.summary}`);
} catch {
  console.log(body.slice(0, 500));
}
if (paid.status !== 200) process.exit(1);
