# Canisell

Pay-per-call risk verdicts (SAFE / CAUTION / DANGER) for newly launched ERC-20 tokens on Base, paid in USDC over [x402](https://x402.org). No accounts, no API keys.

- Site: https://canisell.xyz
- API: https://api.canisell.xyz ([OpenAPI](https://api.canisell.xyz/openapi.json), [free sample](https://api.canisell.xyz/v1/sample), [llms.txt](https://api.canisell.xyz/llms.txt))
- $0.01 per token, $0.05 per batch of up to 10.

```bash
curl -i https://api.canisell.xyz/v1/verdict/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913   # 402 with payment terms
```

Pay with any x402 client (for example `@x402/fetch`). Results are automated risk signals, not financial advice.

## Repo

- `api/`: the API (Hono, Cloudflare Workers), the MCP server and tests. See [api/README.md](api/README.md).
- `landing/`: the static site at canisell.xyz and listing texts.
