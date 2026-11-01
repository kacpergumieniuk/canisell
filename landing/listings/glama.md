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
  Pre-trade risk signals for new ERC-20 tokens on Base. The `check_base_token` tool returns a SAFE / CAUTION / DANGER verdict with reasons, from a simulated buy and sell, taxes, owner powers (mint, pause, blacklist, upgradeable proxy), liquidity and token age. Pays per call in USDC over x402 ($0.01 per check); runs with a dedicated low-balance wallet, no accounts or API keys.
- **Tools:** `check_base_token(address)`.
- **Categories/tags:** crypto, finance, security, base, x402, token-risk.

## 3. Claim

After the listing exists, log in with GitHub and click "Claim". (Unverified: the exact claim UI. The 👤3 step in `research/marketing.md` says "Glama claim click".)

## Note

Glama scores servers by building and introspecting them. The stdio server starts fine without a wallet (it returns payment terms), so introspection should work; if their sandbox needs a Dockerfile, add a minimal one that runs `npx -y canisell-mcp`.
