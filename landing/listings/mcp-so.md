# mcp.so

Unverified process: mcp.so has a submit form in its UI (the docs for it are not public, and a community tool posts to `https://mcp.so/api/submit-project`). Open mcp.so, use "Submit", and paste the fields below. The owner decides whether to submit; nothing was sent.
The marketing plan also mentions a GitHub issue as an alternative route (`research/marketing.md` week 1, item 7). Do one of them, not both.

## Fields

- **Type:** MCP Server (remote Streamable HTTP + stdio)
- **Server URL:** https://api.canisell.xyz/mcp
- **Name:** Canisell
- **URL / repo:** https://github.com/kacpergumieniuk/canisell
- **Short description (one line):** Pre-trade risk verdicts (SAFE / CAUTION / DANGER) for new ERC-20 tokens on Base, paid per call in USDC over x402.
- **Long description:**
  Canisell is a hosted remote MCP server at `https://api.canisell.xyz/mcp` (Streamable HTTP, no install, no API key). Free tools: `get_token_info` (is it a contract / ERC-20, name, symbol, decimals, supply), `get_sample_verdict` and `explain_verdict_fields`. The paid tool is `check_base_token`: give it a Base token address and it returns a SAFE / CAUTION / DANGER verdict, a 0-100 score, and the reasons behind it. The check simulates a buy and a sell (can it be sold, buy/sell tax, round-trip loss), looks at owner powers (mint, pause, blacklist, fee setters, upgradeable proxy), liquidity and LP lock status, and token age.
  It costs $0.01 per check, paid in USDC on Base through the x402 protocol, so there are no accounts or API keys. Clients with an x402 wallet pay inside MCP (x402 MCP transport); others get the payment terms and the paid HTTP URL. The optional stdio server pays from a dedicated low-balance wallet you put in its config, with a per-call cap (default $0.05).
  Output is automated risk signals, not financial advice. Base mainnet only.
- **Tags:** crypto, base, security, x402, token-risk
- **Config example (remote):**

```json
{ "mcpServers": { "canisell": { "url": "https://api.canisell.xyz/mcp" } } }
```

Stdio-only clients: `npx -y mcp-remote https://api.canisell.xyz/mcp`.

- **Config example (stdio, pays from your wallet; needs the npm package, not published yet):**

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
