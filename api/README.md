# Canisell API

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
| POST | `/mcp` | free tools; `check_base_token` $0.01 | Remote MCP server (Streamable HTTP, stateless), see below |

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
| `RPC_URL` | nodies, blastapi, bloxroute, publicnode | Base mainnet RPC(s), comma-separated, tried in order (needs state-override `eth_call` and Multicall3) |
| `ARCHIVE_RPC_URL` | same list + `mainnet.base.org` | Archive `eth_getCode` for token age |
| `LOGS_RPC_URL` | publicnode, bloxroute | RPC(s) that allow a 10k-block `eth_getLogs` range |
| `SIM_USD` | `20` | USD size of the simulated buy |
| `CACHE_TTL_SECONDS` | `60` | Per-address result cache |
| `PUBLIC_BASE_URL` | unset | Public origin used in Bazaar metadata |
| `PORT` | `8787` | Local Node server only |

Token data always comes from Base mainnet; `X402_NETWORK` only selects where payments settle.

## Latency

A paid call is facilitator verify, the engine, then facilitator settle; the verdict is released only after settle. Every response carries a `Server-Timing` header (`verify`, `settle`, and the engine phases `head`, `contract`, `age`, `pools`, `analyze`, `sim`, `creator`, `creator_history`, plus `cache;desc="miss|memory|shared|edge"`), and every payment attempt writes one JSON log line (`evt: "paid_request"`, with the same phases, upstream RPC request counts and the settlement outcome). Slow, rate-limited or failed upstream RPC requests log `evt: "rpc_slow_or_failed"` (the URL is never logged).

How it stays fast:

- The engine starts as soon as a request arrives with a plausible payment header, in parallel with the facilitator's `verify`; the handler reuses that run. Unpaid requests never start it.
- Concurrent contract reads are packed into Multicall3 calls and the rest into JSON-RPC batches; independent phases run at once (contract facts, ETH price, pool discovery and the age search start together; the creator check runs alongside pool analysis and the simulation).
- `RPC_URL` takes several endpoints. A 429 or timeout moves to the next one at once instead of backing off on the limited one. Free public RPCs throttle Cloudflare's egress IPs, so for steady traffic put a keyed endpoint first (`wrangler secret put RPC_URL`).
- Verdicts are cached per address for `CACHE_TTL_SECONDS` in isolate memory and in the data center's Cache API; creation facts (age) for 24 h. Cached verdicts are still released only after settlement.
- The v4 `Initialize` log scan is skipped when a launchpad (Clanker/Zora) pool is live; otherwise it starts from a coarse age answer instead of waiting for the exact creation block.
- Optional checks are time-boxed and reported as unknown (`age_unknown`, `creator_unknown`, `creator_history_unknown`, listed in `meta.partial`) instead of delaying the answer; the buy/sell simulation is never skipped or shortened. A transport failure (rate limit, timeout) while reading the token or looking up pools is an upstream error (502, not charged), never "not an ERC-20" or "no pool".

`npx tsx scripts/profile.ts 0xToken` prints every upstream RPC request and the engine phases (no payment needed); `scripts/paid-smoke.ts` prints the paid call's timings and `Server-Timing`.

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
npm test             # vitest: scoring, bytecode, simulation, mocked-RPC engine, x402 402 response, MCP servers (stdio + remote /mcp)
npm run typecheck    # tsc --noEmit
LIVE=1 npm run test:live   # smoke test: real USDC check against public Base RPCs (network required, no payment)
```

`npm test` skips the live test unless `LIVE=1` is set.

## Remote MCP server (hosted)

`https://api.canisell.xyz/mcp` is a remote MCP server on the same Worker (Streamable HTTP, stateless, JSON responses; no install, no API key, no Durable Objects). Code: `src/mcp.ts`.

| Tool | Price | What it does |
| --- | --- | --- |
| `check_base_token(address)` | $0.01 USDC (x402) | The full verdict. Uses the x402 MCP transport (`@x402/mcp`): without `_meta["x402/payment"]` it returns `isError` with the x402 `PaymentRequired` object plus plain-text instructions (the paid HTTP URL and an `@x402/fetch` snippet). No engine run, no charge. With a payment it verifies, runs the check and settles only if the check succeeded. |
| `get_token_info(address)` | free | Is it a contract / an ERC-20, plus name, symbol, decimals, total supply. One `eth_getCode` and one Multicall3 read, cached 10 minutes per address. |
| `get_sample_verdict()` | free | Cached example verdict |
| `explain_verdict_fields()` | free | What the verdict, score and fields mean, limits, prices, JSON schema |

Mainstream clients (Claude, Cursor, ChatGPT) cannot pay x402 themselves, so in those clients `check_base_token` returns the payment terms. Clients with an x402 wallet (for example `@x402/mcp` `createx402MCPClient`, or a wallet MCP proxy) pay inside MCP. The stdio server below pays from your own wallet.

Client config for clients that support remote servers (Cursor `~/.cursor/mcp.json`, Claude Code, VS Code, Windsurf):

```json
{ "mcpServers": { "canisell": { "url": "https://api.canisell.xyz/mcp" } } }
```

Claude Code: `claude mcp add --transport http canisell https://api.canisell.xyz/mcp`. For stdio-only clients (Claude Desktop config file), bridge with `mcp-remote`:

```json
{ "mcpServers": { "canisell": { "command": "npx", "args": ["-y", "mcp-remote", "https://api.canisell.xyz/mcp"] } } }
```

`GET /mcp` returns a short JSON description of the endpoint; a GET asking for an SSE stream and `DELETE` get 405 (stateless server).

Quick check with curl:

```bash
curl -s https://api.canisell.xyz/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## MCP server (stdio, pays from your wallet)

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
    "canisell": {
      "command": "npx",
      "args": ["tsx", "/ABSOLUTE/PATH/TO/canisell/api/mcp/server.ts"],
      "env": {
        "VERDICT_API_URL": "https://api.canisell.xyz",
        "EVM_PRIVATE_KEY": "0x...your dedicated wallet key..."
      }
    }
  }
}
```

If `npx` is not on the app's PATH, use the absolute path to `npx` or `node_modules/.bin/tsx`.

## Deploy to Cloudflare Workers

Production runs at https://api.canisell.xyz (Base mainnet USDC, PayAI facilitator). To deploy your own copy, after `npx wrangler login`:

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
curl https://api.canisell.xyz/v1/health
curl -i https://api.canisell.xyz/v1/verdict/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913   # expect 402
```

Note: wrangler names the production environment worker `base-token-verdict-production`, so its URL differs from the testnet one.
