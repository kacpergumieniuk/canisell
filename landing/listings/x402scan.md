# x402scan

x402scan (x402scan.com) lists x402 resources that sellers register by URL. The registration page title is "Add API", but its content did not load for the research fetch, so the exact fields are **unverified**: expect a URL field, and expect it to read the resource's 402 response (and probably `/.well-known/x402` or an OpenAPI document, both now served by the API).

## Before submitting

1. API deployed on Base mainnet (`--env production`), `PUBLIC_BASE_URL` set to the public origin so the Bazaar metadata carries the right URLs.
2. `curl -i https://api.canisell.xyz/v1/verdict/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` returns 402 with the `PAYMENT-REQUIRED` header (this was checked against the local server on 2026-11-01; the 402 body is `{"error":"Payment required"}` and the terms are in the header).
3. One paid test call from our own wallet (D11: counted separately, not repeated).

## What to enter

- **URL:** `https://api.canisell.xyz/v1/verdict/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (a real token address so the validator gets a valid 402). Register the batch route too if the form takes one URL per resource: `POST https://api.canisell.xyz/v1/verdict/batch`.
- **Name:** Canisell
- **Description (<= 500 chars):**
  Pre-trade risk verdict for a Base ERC-20 (built for new Clanker, Zora and Uniswap v4 launches). Simulates a buy and sell (sellability, taxes, round-trip loss), checks owner powers (mint, blacklist, pause, fee setters, upgradeable proxy), exit liquidity, LP lock and token age. Returns SAFE / CAUTION / DANGER, a 0-100 score and reasons. $0.01 per check, $0.05 per batch of 10, USDC on Base. Heuristics, not financial advice.
- **Tags:** base, token-risk, honeypot, uniswap-v4, clanker, zora (the same tags the paid routes already carry)
- **Price:** $0.01 single, $0.05 batch (10 addresses)
- **Free endpoints worth linking:** `/`, `/v1/health`, `/v1/sample`
