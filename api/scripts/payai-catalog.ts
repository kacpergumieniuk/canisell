/**
 * Ask the PayAI facilitator to catalogue a paid resource in its Bazaar (/discovery/resources) without moving funds.
 *
 *   npx tsx scripts/payai-catalog.ts <url> [GET|POST] [jsonBody]
 *
 * PayAI catalogues the bazaar declaration it sees on /verify as well as /settle
 * (https://docs.payai.network/x402/facilitators/bazaar.md). This script fetches the unpaid 402, signs the payment
 * with a fresh random key that holds no funds, and sends it to the facilitator's /verify. Verification moves no
 * funds, and a zero-balance payer cannot settle anything. It prints the verify result and the decoded
 * EXTENSION-RESPONSES header, then the listing status.
 */
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const FACILITATOR = "https://facilitator.payai.network";
const [url, method = "GET", body] = process.argv.slice(2);
if (!url) throw new Error("usage: payai-catalog.ts <url> [GET|POST] [jsonBody]");

const client = new x402Client();
registerExactEvmScheme(client, { signer: privateKeyToAccount(generatePrivateKey()) });
const http = new x402HTTPClient(client);

const init: RequestInit = { method, headers: { accept: "application/json", "content-type": "application/json" } };
if (body) init.body = body;
const unpaid = await fetch(url, init);
if (unpaid.status !== 402) throw new Error(`expected 402 from ${url}, got ${unpaid.status}`);
const required = http.getPaymentRequiredResponse((n) => unpaid.headers.get(n), await unpaid.json().catch(() => ({})));
const paymentPayload = await client.createPaymentPayload(required);

const res = await fetch(`${FACILITATOR}/verify`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    x402Version: paymentPayload.x402Version,
    paymentPayload,
    paymentRequirements: paymentPayload.accepted,
  }),
});
const ext = res.headers.get("EXTENSION-RESPONSES");
console.log(`verify: ${res.status} ${(await res.text()).slice(0, 300)}`);
console.log(`extension-responses: ${ext ? Buffer.from(ext, "base64").toString() : "(none)"}`);

await new Promise((r) => setTimeout(r, 8000));
const status = await fetch(`${FACILITATOR}/discovery/listing-status?resource=${encodeURIComponent(required.resource.url)}`);
console.log(`listing-status ${status.status}: ${(await status.text()).slice(0, 600)}`);
