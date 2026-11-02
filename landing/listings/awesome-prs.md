# Awesome-list PRs

Opened: xpaysh/awesome-x402#2100 (Canisell, 2026-11-02, no review yet). Recall-Kitchen/awesome-x402-mcp-services excludes token screens, so Canisell is not listed there (Readmd #137 and Prescan #138 were opened instead).

Rules from `DECISIONS.md` D11 and `research/marketing.md`: one PR per list, each checked by hand for fit, opened from the owner's own account, no mass PRs, no follow-up pings. Each PR below should disclose that the text was drafted with an AI assistant and reviewed by the owner.
Wait until the API is live, the repo is public and the npm package is published; every list wants a working link.
Targets were checked on 2026-11-01. Maintainer responsiveness varies, so none of these is guaranteed to merge.

---

## 1. punkpeye/awesome-mcp-servers (best fit, do first)

- **Repo:** https://github.com/punkpeye/awesome-mcp-servers
- **Why it fits:** it is the largest MCP server list. Its `CONTRIBUTING.md` scope is "servers with a public GitHub repository that you install and run yourself", which is what our stdio server is. A remote-only server would belong in `awesome-remote-mcp-servers` instead, which we now also qualify for: the remote endpoint `https://api.canisell.xyz/mcp` is live since 2026-11-02 (draft for that list not written yet). The "Finance & Fintech" section already lists crypto and x402 servers (for example a pay-per-call x402 token-safety entry), so a token-risk server is not out of place.
- **Prerequisite:** entries in the list carry a Glama score badge and the repo has a `check-glama.yml` workflow, so list the server on Glama first (`glama.md`) and add the badge.
- **Section:** Finance & Fintech. Keep alphabetical order per `CONTRIBUTING.md` (the section is not perfectly sorted today; place the line by repo name and match neighbours).
- **Legend:** 📇 TypeScript, ☁️ calls a cloud service. Add 🏠 if you want to mark it as a local process; the existing entries mix both.
- **PR title:** `Add kacpergumieniuk/canisell`. (The `🤖🤖🤖` suffix opts into the agent fast-track; add it only if an automated agent, not the owner, opens the PR, and say so in the description.)
- **Line to add:**

```markdown
- [kacpergumieniuk/canisell](https://github.com/kacpergumieniuk/canisell) [![kacpergumieniuk/canisell MCP server](https://glama.ai/mcp/servers/kacpergumieniuk/canisell/badges/score.svg)](https://glama.ai/mcp/servers/kacpergumieniuk/canisell) 📇 ☁️ - Pre-trade risk signals for new ERC-20 tokens on Base: SAFE / CAUTION / DANGER verdict with reasons from a simulated buy and sell, taxes, owner powers, liquidity and token age. $0.01 per check, paid in USDC over x402 from a dedicated wallet.
```

- **PR description:**

```markdown
Adds Canisell, an MCP server (stdio, TypeScript) with one tool, `check_base_token(address)`.

What it does: for a Base (chain 8453) ERC-20 it returns a SAFE / CAUTION / DANGER verdict, a 0-100 score and reasons, based on a simulated buy and sell (sellability, taxes), owner powers (mint, pause, blacklist, upgradeable proxy), liquidity and token age. The output is automated risk signals, not financial advice.

Setup: `npx -y canisell-mcp`. Each check costs $0.01 in USDC via the x402 protocol, so there are no accounts or API keys; the server pays from a dedicated low-balance wallet configured in env and has a per-call cap (default $0.05). Without a wallet it returns the payment terms.

Section: Finance & Fintech. Public repo, Glama listing linked in the badge.

Disclosure: this PR text was drafted with an AI assistant and reviewed and submitted by the project owner.
```

---

## 2. xpaysh/awesome-x402

- **Repo:** https://github.com/xpaysh/awesome-x402
- **Why it fits:** a curated list of x402 resources (about 300 stars) with a "Security & Audits" section that already holds x402-adjacent safety APIs, including a Base token/honeypot guard. Canisell is an x402-paid API with a published price, Bazaar metadata and an x402 payment path in its MCP server, so it is directly about x402, which their quality standards require ("x402-specific content").
- **Caveat:** the repo's last push was 2026-07-28 and it shows about 1000 open issues/PRs, so review may be slow. It has a direct competitor entry in the same section; do not mention it in the PR.
- **Format rules (from its `CONTRIBUTING.md`):** `- [Resource Name](https://example.com) - Brief description.` One resource per PR. Add at the **bottom of the category**. Title `Add [Resource Name]`. HTTPS links only, no shorteners. Description is one or two sentences, starts with a capital, ends with a period, no emoji, neutral tone, no marketing words. The PR description follows their What / Why / Quality / Category template.
- **Section:** Security & Audits.
- **PR title:** `Add Canisell`
- **Line to add:**

```markdown
- [Canisell](https://canisell.xyz) - Pay-per-call x402 API on Base that returns a SAFE / CAUTION / DANGER risk verdict for new ERC-20 tokens, with an MCP tool; $0.01 per check in USDC, no accounts or API keys. ([MCP](https://github.com/kacpergumieniuk/canisell)) ([Sample](https://api.canisell.xyz/v1/sample))
```

- **PR description:**

```markdown
## Add Canisell

**What:** A pay-per-call API (x402, USDC on Base, $0.01 per check and $0.05 per batch of 10) that returns a SAFE / CAUTION / DANGER verdict with reasons for new ERC-20 tokens on Base. It simulates a buy and sell, and reports taxes, owner powers (mint, pause, blacklist, upgradeable proxy), liquidity and token age. An MCP server exposes it as the `check_base_token` tool for Claude Desktop and Cursor.

**Why:** It is a working example of an x402-paid, key-less API for trading bots and agents, with the x402 payment handled by the standard SDK (`@x402/hono` on the server, `@x402/fetch` / `@x402/mcp` on the client side) and Bazaar discovery metadata on both paid routes. The free `/v1/sample` endpoint shows the exact response.

**Quality Checklist:**
- [x] Actively maintained (new project, engine 0.1.0)
- [x] Documented: README with endpoints, prices, env vars and MCP config
- [x] Directly related to x402
- [x] Links work: site, repo, `/v1/sample`
- [x] Follows the contribution format (one resource, bottom of the category)

**Category:** Security & Audits

Limits are stated on the site: heuristic risk signals, not financial advice, Base only.
Disclosure: drafted with an AI assistant, reviewed and submitted by the owner.
```

---

## 3. hive-intel/awesome-crypto-mcp-servers (lower priority, optional)

- **Repo:** https://github.com/hive-intel/awesome-crypto-mcp-servers
- **Why it might fit:** a crypto-specific MCP list with a "Security and Risk" section (GoPlus and similar pre-trade checkers are there), so the audience is right: people who connect crypto tools to AI agents.
- **Caveats, read before sending:** it is maintained by a company (Hive Intelligence) and describes itself as "intentionally selective"; its tracker says they stopped broad outbound PR campaigns. It was last pushed 2026-06-04 and shows 34 open items. Its entry style is a longer description with a "high-risk" note for tools that move funds. Our tool does not move funds itself, but it does sign USDC payments from a configured wallet, so say that plainly. Skip this one if the first two get no response; do not chase.
- **Section:** Security and Risk.
- **PR title:** `Add Canisell to Security and Risk`
- **Line to add:**

```markdown
- [Canisell](https://github.com/kacpergumieniuk/canisell) - Pre-trade risk signals for new ERC-20 tokens on Base via the `check_base_token` MCP tool: SAFE / CAUTION / DANGER verdict with reasons from a simulated buy and sell, taxes, owner powers (mint, pause, blacklist, upgradeable proxy), liquidity and token age. Each check costs $0.01 in USDC over x402, paid from a dedicated low-balance wallet configured in the server env (spend cap per call); it does not hold or move other funds. Heuristics, not financial advice.
```

- **PR description:**

```markdown
Adds Canisell to "Security and Risk".

It covers a narrow case that complements broader screening tools: new Base ERC-20 tokens, with a simulated buy and sell, owner powers, liquidity and token age in one verdict. Setup is `npx -y canisell-mcp`; payment is $0.01 per check in USDC via x402, from a dedicated low-balance wallet in env, with a per-call cap. The wallet is only used to sign payment authorizations for the API; the tool does not trade or transfer anything else.

Output is automated risk signals, not financial advice.
Disclosure: drafted with an AI assistant, reviewed and submitted by the owner.
```

---

## Not recommended (checked)

- **Recall-Kitchen/awesome-x402-mcp-services:** its README explicitly says it is "not a directory of crypto trading bots, token screens, payment routers". Do not submit.
- **punkpeye/awesome-remote-mcp-servers:** remote-only; we have no hosted MCP endpoint yet. Revisit if one is added.
- **sindresorhus/awesome:** excludes blockchain-related lists (per another maintainer's notes); not applicable.
- **badkk/awesome-crypto-mcp-servers:** last push 2025-03, looks unmaintained.

---

## 3. punkpeye/awesome-remote-mcp-servers (ready; waiting for Glama connectors)

- **Repo:** https://github.com/punkpeye/awesome-remote-mcp-servers (about 2.4k stars, merges daily).
- **Blocker (2026-11-02):** CI requires a Glama connector page. Glama mirrors the official MCP registry, where `xyz.canisell/canisell`, `/prescan` and `/readmd` were published on 2026-11-02, but the pages still returned 404 that evening. Check `https://glama.ai/mcp/connectors/xyz.canisell/canisell` before opening.
- **Rules:** star the repo first (required), one server per entry, alphabetical within the category, description is one sentence up to 120 characters, auth marker 🔓 (no auth). Title may end with `🤖🤖🤖` (agent fast-track) when opened by an agent.
- **Entries** (one PR each):

**Canisell (Finance)**

```markdown
- [Canisell](https://canisell.xyz) `https://api.canisell.xyz/mcp`
  [![Canisell MCP connector](https://glama.ai/mcp/connectors/xyz.canisell/canisell/badges/score.svg)](https://glama.ai/mcp/connectors/xyz.canisell/canisell)
  🔓 - Can I sell this Base token? Simulated buy and sell, taxes, owner powers, liquidity; $0.01 per check via x402.
```

**Prescan (Security)**

```markdown
- [Prescan](https://prescan.canisell.xyz) `https://prescan.canisell.xyz/mcp`
  [![Prescan MCP connector](https://glama.ai/mcp/connectors/xyz.canisell/prescan/badges/score.svg)](https://glama.ai/mcp/connectors/xyz.canisell/prescan)
  🔓 - Prompt-injection, MCP tool-poisoning and x402 pay-safety pre-checks for agents; free preview, x402 per call.
```

**Readmd (Search & Data Extraction)**

```markdown
- [Readmd](https://readmd.canisell.xyz) `https://readmd.canisell.xyz/mcp`
  [![Readmd MCP connector](https://glama.ai/mcp/connectors/xyz.canisell/readmd/badges/score.svg)](https://glama.ai/mcp/connectors/xyz.canisell/readmd)
  🔓 - Any web page as clean Markdown with metadata, outline and token counts; free preview, $0.001 per page via x402.
```
