# Listings kit (nothing here has been submitted)

Everything is ready-to-paste text. Nothing was published, submitted, or deployed, and no PR was opened.
The marketing rules from `DECISIONS.md` D11 apply to every text here: the account is labelled as a bot/automated, no spam (one submission per directory, one PR per list), we say "risk signals", and no text calls a specific token a scam.

## Placeholders to replace before submitting

The name "Canisell" is a recommendation (see `../NAMES.md`), not a decision. These values appear in several files; search and replace them together.

| Placeholder | Where it is used |
|---|---|
| `canisell` / `Canisell` | all files |
| `https://api.canisell.xyz` | API base URL (landing page `CONFIG`, `server.json`, directory texts) |
| `https://canisell.xyz` | landing page |
| `https://github.com/kacpergumieniuk/canisell` | public repo (MCP server + examples); needed by the registry, Glama, mcp.so and the awesome-mcp-servers PR |
| `canisell-mcp` | npm package of the MCP server |
| `io.github.kacpergumieniuk/canisell` | MCP registry name; must equal `mcpName` in the npm package's `package.json` |

## Prerequisites that are not done yet

1. The API is not deployed (`api/README.md`: "Not deployed yet"). Directories scan a live URL, so deploy to mainnet first (`npx wrangler deploy --env production`, owner action).
2. The MCP server is not published. Today it runs from a local path with `tsx`. It needs a public GitHub repo and an npm package (`canisell-mcp`, with a `bin` and `"mcpName": "io.github.kacpergumieniuk/canisell"` in `package.json`), published by the owner with 2FA or trusted publishing. The landing page MCP snippet assumes this package exists.
3. Discovery files are implemented: `/.well-known/x402`, `/openapi.json`, `/llms.txt` (free, see `api/src/discovery.ts`).
4. One paid test call from our own wallet is needed for Bazaar indexing (D11). It is not counted as revenue and is not repeated.

## Suggested order and files

| Order | Target | File | Needs from owner |
|---|---|---|---|
| 1 | Official MCP registry | `server.json` + steps below | GitHub login (`mcp-publisher login github`), npm publish |
| 2 | x402scan | `x402scan.md` | the form submission |
| 3 | Smithery | `smithery.md` | Smithery login (GitHub OAuth) |
| 4 | Glama | `glama.md` (+ `glama.json` for the repo root) | claim click |
| 5 | mcp.so | `mcp-so.md` | the submission |
| 6 | Awesome lists | `awesome-prs.md` | review, then open each PR from the owner's own account |
| 7 | Social | `posts.md` | post manually |

## MCP registry: `server.json`

Checked 2026-11-01 against the registry docs (`docs/modelcontextprotocol-io/quickstart.mdx`, `docs/reference/server-json/generic-server-json.md`) and validated with Ajv against the published schema `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json` (valid; description is 83 characters, limit 100). `2025-12-11` is the newest dated schema; the registry changelog lists only a draft after it.

Rules that came out of the docs:
- `name` must start with `io.github.<github-username>/` when you authenticate with GitHub, and must equal `mcpName` in the npm `package.json`.
- Add `"mcpName": "io.github.kacpergumieniuk/canisell"` to the package's `package.json` **before** `npm publish`. Without it you get "Registry validation failed for package".
- `version` in `server.json` and in the `packages` entry should match the published npm version.
- Publishing: `mcp-publisher init` (or copy this file), `mcp-publisher login github`, `mcp-publisher publish`. The CLI install method changes between releases, so use the current README at github.com/modelcontextprotocol/registry rather than a pinned command. (Not run here.)
- The server is stdio with an npm package, so `remotes` is not used. If a remote (streamable-http) MCP endpoint is added later, add a `remotes` entry.

## What was verified and what was not

Verified by reading current docs on 2026-11-01: registry `server.json` format and schema; awesome-mcp-servers contribution rules and category; xpaysh/awesome-x402 contribution rules and sections; Smithery publish options; Glama `glama.json` format (seen in other public repos).
Not verifiable from here (marked "unverified" in the individual files): the exact form fields of mcp.so, x402scan, and Glama's claim flow. Those are web UIs behind forms; the texts are written to fit common fields and the owner should adjust in the UI.
