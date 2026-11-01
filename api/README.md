# Base Token Verdict API

Pay-per-call HTTP API that returns a **SAFE / CAUTION / DANGER** verdict for a Base (chain 8453) ERC-20 token, built for brand-new Clanker / Zora / Uniswap v4 launches. Each call is paid in USDC through [x402](https://x402.org); the server holds no keys (the facilitator verifies and settles).

What a check does: simulated buy + sell via `eth_call` (honeypot, taxes, round-trip loss), owner powers (mint, blacklist, pause, fee setters, upgradeable proxy), exit liquidity and LP lock, token age, creator history. The response has the verdict, a 0-100 score, reasons and structured findings. It is a heuristic, not financial advice.

Runs on Cloudflare Workers (Hono) and locally on Node.

## Endpoints

| Method | Path | Price | Notes |
| --- | --- | --- | --- |
| GET | `/v1/verdict/{address}` | $0.01 USDC | Verdict for one token |
| POST | `/v1/verdict/batch` | $0.05 USDC | Body `{"addresses": ["0x...", ...]}`, 1-10 addresses, deduplicated |
| GET | `/v1/sample` | free | Example response |
| GET | `/v1/health` | free | RPC reachability |
| GET | `/` | free | Service description |
| GET | `/openapi.json` | free | OpenAPI 3.1, prices in `x-payment-info` (x402scan format) |
| GET | `/.well-known/x402` | free | x402scan resource list (`version: 1`) |
| GET | `/llms.txt` | free | Short plain-text description for LLM tools |

Malformed requests get a 400 before the paywall; non-token addresses get 422 and failed checks are not settled (no charge). Prices are configurable (`PRICE_SINGLE`, `PRICE_BATCH`). Content is served only after the facilitator has verified and settled the payment: @x402/hono buffers the handler response, settles, and turns a failed settlement into a 402 with no body (`requireSettlement` in `src/x402.ts` enforces this as a second line of defence). Responses carry Bazaar discovery metadata so x402 Bazaar can index the service.

## Environment variables

All optional; the defaults give a working Base Sepolia (testnet payments) setup. In production set them as Worker vars in `wrangler.toml`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `X402_NETWORK` | `base-sepolia` | `base-sepolia` or `base` (mainnet), or a CAIP-2 id |
| `FACILITATOR` | `x402.org` on testnet, `payai` on mainnet | `x402.org` (testnet only), `payai`, `dexter` |
| `FACILITATOR_URL` | from `FACILITATOR` | Override the facilitator URL |
| `PAY_TO` | owner wallet in `src/config.ts` | Address that receives USDC |
| `PRICE_SINGLE` / `PRICE_BATCH` | `$0.01` / `$0.05` | Prices |
| `RPC_URL` | `https://base-rpc.publicnode.com` | Base mainnet RPC (needs state-override `eth_call`) |
| `ARCHIVE_RPC_URL` | `https://mainnet.base.org` | Archive `eth_getCode` for token age |
| `LOGS_RPC_URL` | `https://base-rpc.publicnode.com` | RPC that allows `eth_getLogs` |
| `SIM_USD` | `20` | USD size of the simulated buy |
| `CACHE_TTL_SECONDS` | `60` | Per-address result cache |
| `PUBLIC_BASE_URL` | unset | Public origin used in Bazaar metadata |
| `PORT` | `8787` | Local Node server only |

Token data always comes from Base mainnet; `X402_NETWORK` only selects where payments settle.

## Run locally

```bash
cd api
npm install
npm run dev          # or: npm start   (http://localhost:8787)

curl localhost:8787/v1/sample
curl -i localhost:8787/v1/verdict/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913   # 402 with payment requirements
npm run dev:worker   # same app in the Workers runtime via wrangler dev
```

An x402 client (for example `@x402/fetch` with a funded Base Sepolia wallet) pays the 402 automatically and retries.

## Tests

```bash
npm test             # vitest: scoring, bytecode, simulation, mocked-RPC engine, x402 402 response, MCP server
npm run typecheck    # tsc --noEmit
LIVE=1 npm run test:live   # smoke test: real USDC check against public Base RPCs (network required, no payment)
```

`npm test` skips the live test unless `LIVE=1` is set.

## MCP server (stdio)

`mcp/server.ts` exposes one tool, `check_base_token(address)`, which calls this API and returns the verdict JSON. Claude Desktop and Cursor cannot pay x402 invoices themselves, so the MCP server acts as the x402 client: it pays from a wallet you provide. Without a wallet it returns the 402 payment terms instead of a verdict.

| Env | Meaning |
| --- | --- |
| `VERDICT_API_URL` | API base URL, default `http://localhost:8787` |
| `EVM_PRIVATE_KEY` | Optional. `0x` private key of a funded USDC wallet on the API's payment network. Use a dedicated low-balance wallet; the key stays in your client config and is never written anywhere by this project |
| `MAX_PAYMENT_USD` | Per-call spend cap, default `0.05` |

Run by hand: `npm run mcp`. Client config (Claude Desktop `claude_desktop_config.json`, Cursor `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "base-token-verdict": {
      "command": "npx",
      "args": ["tsx", "/ABSOLUTE/PATH/TO/canisell/api/mcp/server.ts"],
      "env": {
        "VERDICT_API_URL": "https://base-token-verdict.<your-subdomain>.workers.dev",
        "EVM_PRIVATE_KEY": "0x...your dedicated wallet key..."
      }
    }
  }
}
```

If `npx` is not on the app's PATH, use the absolute path to `npx` or `node_modules/.bin/tsx`.

## Deploy to Cloudflare Workers

Not deployed yet. After the owner has run `npx wrangler login`:

```bash
cd api
npm install
npx wrangler whoami                      # confirm the right account

# Testnet (Base Sepolia payments, x402.org facilitator)
npx wrangler deploy

# Mainnet (Base USDC, PayAI facilitator)
npx wrangler deploy --env production
```

Check `PAY_TO` in `wrangler.toml` is the wallet you want to be paid at before deploying to production. No secrets are required. Optionally set `PUBLIC_BASE_URL` in the vars to the deployed origin. Then verify:

```bash
curl https://base-token-verdict.<subdomain>.workers.dev/v1/health
curl -i https://base-token-verdict.<subdomain>.workers.dev/v1/verdict/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913   # expect 402
```

Note: wrangler names the production environment worker `base-token-verdict-production`, so its URL differs from the testnet one.
