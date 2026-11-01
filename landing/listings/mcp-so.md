# mcp.so

Unverified process: mcp.so has a submit form in its UI (the docs for it are not public, and a community tool posts to `https://mcp.so/api/submit-project`). Open mcp.so, use "Submit", and paste the fields below. The owner decides whether to submit; nothing was sent.
The marketing plan also mentions a GitHub issue as an alternative route (`research/marketing.md` week 1, item 7). Do one of them, not both.

## Fields

- **Type:** MCP Server (stdio)
- **Name:** Canisell
- **URL / repo:** https://github.com/kacpergumieniuk/canisell
- **Short description (one line):** Pre-trade risk verdicts (SAFE / CAUTION / DANGER) for new ERC-20 tokens on Base, paid per call in USDC over x402.
- **Long description:**
  Canisell exposes one MCP tool, `check_base_token`. Give it a Base token address and it returns a SAFE / CAUTION / DANGER verdict, a 0-100 score, and the reasons behind it. The check simulates a buy and a sell (can it be sold, buy/sell tax, round-trip loss), looks at owner powers (mint, pause, blacklist, fee setters, upgradeable proxy), liquidity and LP lock status, and token age.
  It costs $0.01 per check, paid in USDC on Base through the x402 protocol, so there are no accounts or API keys. Because Claude Desktop and Cursor cannot pay by themselves, the MCP server pays from a dedicated low-balance wallet you put in its config; a per-call cap (default $0.05) applies. Without a wallet it returns the payment terms.
  Output is automated risk signals, not financial advice. Base mainnet only.
- **Tags:** crypto, base, security, x402, token-risk
- **Config example:**

```json
{
  "mcpServers": {
    "canisell": {
      "command": "npx",
      "args": ["-y", "canisell-mcp"],
      "env": {
        "VERDICT_API_URL": "https://api.canisell.xyz",
        "EVM_PRIVATE_KEY": "0x...dedicated low-balance wallet..."
      }
    }
  }
}
```
