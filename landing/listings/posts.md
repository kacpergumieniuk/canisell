# Posts for manual publishing (nothing has been posted)

Post these by hand from the brand account. D11 rules: the account is labelled as automated/bot (X "Automated" label linked to the owner's account, Farcaster bio says automated), one account per platform, no unsolicited replies or mentions, no keyword-triggered replies, say "risk signals", never call a specific token a scam, no fake users or payments.
Post only after the API is live, the page is deployed and the npm package exists; every post links to something that must work. Replace `https://canisell.xyz` and the repo URL if the name or domains change.
Character counts are shown for X (limit 280; links count as 23).

---

## X posts (5, post on different days, not in one burst)

**1. Launch (launch day)**  
Canisell is live: an API that gives SAFE / CAUTION / DANGER with reasons for new ERC-20 tokens on Base.

It simulates a buy and a sell, and checks taxes, owner powers, liquidity and age.

$0.01 per check in USDC over x402. No accounts, no API keys.

https://canisell.xyz

**2. What a check looks at**  
What one Canisell check looks at for a Base token:

- can a simulated buy and sell both go through
- buy / sell tax and round-trip loss
- owner powers: mint, pause, blacklist, upgradeable proxy
- exit liquidity and LP lock
- token age

Output is risk signals, not advice.

**3. Free endpoint**  
The response format is public. No payment needed to see it:

curl https://api.canisell.xyz/v1/sample

You get the verdict, a 0-100 score, reasons sorted by severity, and the structured findings. The sample is an established token, so it shows what a clean result looks like.

**4. MCP**  
There is an MCP server too. It adds a `check_base_token` tool to Claude Desktop and Cursor.

Those clients can't pay x402 invoices, so the server pays from a wallet you configure. Use a dedicated low-balance one; there's a per-call cap (default $0.05).

npx -y canisell-mcp

**5. Limits (post a few days later)**  
What Canisell doesn't do: it's heuristics, not an audit or financial advice. Base only. It's a snapshot, so an owner who keeps their powers can change a token after the check. The simulated buy is about $20, so big orders can see more slippage.

---

## Launch thread (X, 5 posts)

**1/5**  
We built a small pay-per-call API for one question a trading bot has to answer about a new Base token: can it be sold, and what could go wrong if it can? Canisell returns SAFE / CAUTION / DANGER with the reasons. A thread on how it works.

**2/5**  
Each check runs a simulated buy and sell with eth_call state overrides, so tax and sellability are measured, not guessed from source code. It also reads owner powers (mint, pause, blacklist, fee setters, upgradeable proxy), liquidity and LP lock status, and token age.

**3/5**  
Payment uses x402. The first request gets an HTTP 402 with the price and payment terms; an x402 client signs a USDC authorization and retries. $0.01 per token, $0.05 for a batch of 10. No accounts, no keys. Failed checks aren't settled, so you aren't charged for them.

**4/5**  
Verdict bands: SAFE is a score of 75 or more, CAUTION is 45 to 74, DANGER is below 45 or any critical signal (a failed sell, a tax of 50% or more, no pool). SAFE means no mechanical trap was found at that block. It does not say the price will hold.

**5/5**  
Free to try: /v1/sample shows the full response format. Quickstart, MCP config and pricing are on https://canisell.xyz. Limits are on the page too: heuristics, not advice, Base only. This account is automated; the project owner is linked in the profile.

---

## Farcaster (one cast, 320-byte limit; channel: /base or /dev, pick one, post once)

Canisell is live. It's an API that returns SAFE / CAUTION / DANGER with reasons for new ERC-20 tokens on Base: simulated buy and sell, taxes, owner powers, liquidity, token age. $0.01 per check in USDC via x402, no accounts or API keys. There's an MCP tool for Claude Desktop and Cursor. https://canisell.xyz
