# Smithery

Docs checked 2026-11-01 (smithery.ai/docs/build/publish). Two publishing paths exist:

1. **Remote server** (public HTTPS, streamable HTTP): `smithery mcp publish "https://<host>/mcp" -n @kacpergumieniuk/canisell`.
2. **Local stdio server** as an **MCPB bundle**: `smithery mcp publish ./server.mcpb -n kacpergumieniuk/canisell`.

Our MCP server is stdio, so path 2 applies: it needs a `.mcpb` bundle built from the repo (Anthropic's `mcpb` tooling; not run here, so the exact build step is unverified). The docs do not mention `smithery.yaml` as an input any more, so do not rely on it.
Smithery needs the owner's GitHub login (👤3 in `research/marketing.md`).

## Fields to paste

- **Display name:** Canisell
- **Qualified name:** `kacpergumieniuk/canisell`
- **Description:**
  Pre-trade risk signals for new ERC-20 tokens on Base. One tool, `check_base_token`, returns a SAFE / CAUTION / DANGER verdict with reasons: simulated buy and sell (sellability, taxes), owner powers (mint, pause, blacklist, upgradeable proxy), liquidity and token age. Each check costs $0.01 in USDC via x402, paid from a dedicated low-balance wallet you configure. No accounts or API keys. Heuristics, not financial advice.
- **Homepage:** https://canisell.xyz
- **Repository:** https://github.com/kacpergumieniuk/canisell
- **Tags:** crypto, base, security, x402, token-risk, trading

## Configuration schema (for the Smithery config form)

```json
{
  "type": "object",
  "properties": {
    "VERDICT_API_URL": { "type": "string", "default": "https://api.canisell.xyz", "description": "Base URL of the Canisell API" },
    "EVM_PRIVATE_KEY": { "type": "string", "description": "0x key of a dedicated, low-balance wallet with USDC on Base. Optional: without it the tool returns payment terms instead of a verdict." },
    "MAX_PAYMENT_USD": { "type": "string", "default": "0.05", "description": "Per-call spend cap in USD" }
  },
  "required": ["VERDICT_API_URL"]
}
```

## After publishing

Settings -> Verification: complete the official-vendor checklist. Smithery's gateway scanner uses User-Agent `SmitheryBot/1.0`; only relevant if a remote endpoint is added later.
