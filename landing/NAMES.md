# Product name proposals

Checked 2026-11-01. The working name in the code today is "Base Token Verdict" / `base-token-verdict`
(`api/wrangler.toml`, `SERVICE_NAME` in `api/src/x402.ts`, MCP server name in `api/mcp/server.ts`).
It is descriptive but generic, contains "Base" (a Coinbase mark, so a poor brand to own), and would be hard to rank for.

## How availability was checked

- **npm**: `npm view <name> name` (E404 = unclaimed). Also checked the likely MCP package names.
- **.xyz**: RDAP at `rdap.centralnic.com/xyz/domain/<name>.xyz` (HTTP 404 = not registered).
- **.dev**: RDAP at `pubapi.registry.google/rdap/domain/<name>.dev` (HTTP 404 = not registered).
- `whois` is installed but is useless for these TLDs here (the IANA fallback is returned, no registry data), so RDAP was used instead.
- GitHub user/org page (`github.com/<name>`, 404 = free) and a web search for existing crypto products with the same name.

"Looks free" is not "is free": nothing was reserved, and a registrar may still show a premium price or a recent registration. Check at purchase time.

## Candidates

| Name | .xyz | .dev | npm `<name>` | npm `<name>-mcp` | GitHub name | Notes |
|---|---|---|---|---|---|---|
| **Canisell** | free | free | free | free | free | Reads as "can I sell?", which is the first question a bot has to answer about a new token. 8 letters. No existing crypto product found in a web search. Slightly awkward to say aloud. |
| **Sellsim** | free | free | free | not checked | free | Literally "simulated sell". Short, clear, but narrows the product to one check, while the verdict also covers owner powers, liquidity and age. |
| **Exitverdict** | free | free | free | not checked | free | Says both parts (exit and verdict). 11 letters, longer to type, weaker as a brand. |

Rejected after checking (something already taken): `sellcheck`, `exitcheck`, `tokenprobe`, `exitlens`, `sellproof`, `tradeprobe`, `exitgate`, `sellable`, `tollgate`, `tokenlens`, `launchlens` (.xyz or .dev registered, or npm name in use); `exitprobe` (npm taken). `rugprobe` is free everywhere but was dropped: "rug" frames every token as a scam, which conflicts with the "risk signals, never call a token a scam" rule in DECISIONS.md D11.

## Recommendation: Canisell

- It names the job in one word-phrase, so it works as a tool name in an agent's tool list (`check_base_token` stays the tool name; that is already descriptive).
- All of `canisell.xyz`, `canisell.dev`, npm `canisell`, `canisell-mcp`, `@canisell/mcp` and the GitHub name `canisell` looked unclaimed.
- Nothing in it says "scam" or promises safety.

Suggested layout once bought: `canisell.xyz` (landing page, Cloudflare Pages), `api.canisell.xyz` (the Worker), npm `canisell-mcp`, GitHub `kacpergumieniuk/canisell`, MCP registry name `io.github.kacpergumieniuk/canisell`.
The landing page and `listings/` use these placeholders; each lives in one place (see `listings/README.md`).

## What adopting the name touches (not done here, the API folder was left alone)

- `api/wrangler.toml` `name`, `api/src/x402.ts` `SERVICE_NAME`, `api/mcp/server.ts` server name (`base-token-verdict`), `api/package.json` name, the README title.
- A `bin` entry and `mcpName` in the MCP package's `package.json` (needed for the official registry, see `listings/server.json`).
