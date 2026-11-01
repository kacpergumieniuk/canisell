/** JSON Schemas used for Bazaar discovery metadata and documentation. */
export const ADDRESS_SCHEMA = {
  type: "string",
  pattern: "^0x[0-9a-fA-F]{40}$",
  description: "ERC-20 token contract address on Base mainnet (chain id 8453)",
  example: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
} as const;

export const VERDICT_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    address: ADDRESS_SCHEMA,
    chain: { type: "string", const: "base" },
    verdict: { type: "string", enum: ["SAFE", "CAUTION", "DANGER"] },
    score: { type: "integer", minimum: 0, maximum: 100, description: "100 = no risk signals" },
    summary: { type: "string", description: "One-line plain-English verdict" },
    reasons: { type: "array", items: { type: "string" }, description: "Most severe first" },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          severity: { type: "string", enum: ["critical", "high", "medium", "low", "info"] },
          penalty: { type: "number" },
          message: { type: "string" },
        },
      },
    },
    token: {
      type: "object",
      properties: { name: { type: "string" }, symbol: { type: "string" }, decimals: { type: "integer" }, totalSupply: { type: "string" } },
    },
    launchpad: { type: ["string", "null"], description: "clanker | zora | null" },
    flags: {
      type: "object",
      properties: {
        trading: {
          type: "object",
          description: "Simulated buy then sell via eth_call with state overrides",
          properties: {
            canBuy: { type: "boolean" },
            canSell: { type: "boolean" },
            buyTaxPct: { type: "number" },
            sellTaxPct: { type: "number" },
            roundTripLossPct: { type: "number" },
            poolKind: { type: "string" },
          },
        },
        ownership: {
          type: "object",
          properties: {
            owner: { type: ["string", "null"] },
            renounced: { type: "boolean" },
            capabilities: { type: "object", description: "mint/blacklist/pause/feeSetter/tradingToggle/limitSetter -> matched signatures" },
            proxy: { type: "object", properties: { kind: { type: "string" }, implementation: { type: "string" } } },
          },
        },
        liquidity: {
          type: "object",
          properties: { totalDepthUsd: { type: ["number", "null"] }, pools: { type: "array", items: { type: "object" } } },
        },
        creator: { type: "object" },
        age: { type: "object", properties: { ageSeconds: { type: "number" }, createdBlock: { type: "number" } } },
      },
    },
    meta: { type: "object" },
  },
  required: ["address", "verdict", "score", "summary", "reasons", "flags"],
} as const;

export const BATCH_INPUT_SCHEMA = {
  type: "object",
  properties: {
    addresses: { type: "array", items: ADDRESS_SCHEMA, minItems: 1, maxItems: 10 },
  },
  required: ["addresses"],
} as const;

export const BATCH_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        anyOf: [
          VERDICT_OUTPUT_SCHEMA,
          { type: "object", properties: { address: { type: "string" }, error: { type: "string" } }, required: ["address", "error"] },
        ],
      },
    },
  },
  required: ["results"],
} as const;
