# Glama

Glama indexes public GitHub MCP repositories by itself. The owner's job is to make the repo easy to index and then claim the listing.

## 1. Add `glama.json` to the repo root (file next to this one)

```json
{
  "$schema": "https://glama.ai/mcp/schemas/server.json",
  "maintainers": ["kacpergumieniuk"]
}
```
Format taken from `glama.json` files in other public MCP repos (for example `clidey/whodb`, `mnemox-ai/tradememory-protocol`). The `maintainers` list is GitHub usernames allowed to claim the server.

## 2. Add the server (Glama "Add Server" button, or wait for the crawler)

- **Repository:** https://github.com/kacpergumieniuk/canisell
- **Name:** Canisell
- **Short description (fits most fields):**
  Pre-trade risk signals for new ERC-20 tokens on Base. Hosted remote MCP server at `https://api.canisell.xyz/mcp` (Streamable HTTP, no install, no API key). Free tools: `get_token_info` (contract + ERC-20 metadata), `get_sample_verdict`, `explain_verdict_fields`. The paid `check_base_token` tool returns a SAFE / CAUTION / DANGER verdict with reasons, from a simulated buy and sell, taxes, owner powers (mint, pause, blacklist, upgradeable proxy), liquidity and token age; $0.01 in USDC per check over x402 (x402 MCP transport, or the stdio server paying from a dedicated low-balance wallet).
- **Remote URL (Glama "Connectors"):** https://api.canisell.xyz/mcp
- **Tools:** `check_base_token(address)` (paid), `get_token_info(address)`, `get_sample_verdict()`, `explain_verdict_fields()` (free).
- **Categories/tags:** crypto, finance, security, base, x402, token-risk.

## 3. Claim

After the listing exists, log in with GitHub and click "Claim". (Unverified: the exact claim UI. The 👤3 step in `research/marketing.md` says "Glama claim click".)

## Note

Glama scores servers by building and introspecting them. The remote endpoint can be introspected directly (`tools/list` needs no auth). The stdio server starts fine without a wallet (it returns payment terms), so introspection should work; if their sandbox needs a Dockerfile, add a minimal one that runs `npx -y canisell-mcp`.
