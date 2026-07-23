import type { X402ProviderPreset } from "./preset.ts"

/** Surplus Intelligence — the bundled marketplace preset. */
export const SI: X402ProviderPreset = {
  id: "surplusintelligence",
  name: "Surplus Intelligence (x402)",
  npm: "@ai-sdk/openai-compatible",
  /** Canonical API host. www. redirects drop x402 payment headers. */
  baseURL: "https://api.surplusintelligence.ai/v1",
  /** SI's verifier speaks the legacy envelope; the spec-v2 form is rejected with invalid_payload. */
  wireFormat: "legacy",
  marketplace: {
    apiOrigin: "https://api.surplusintelligence.ai",
    defaultMinDiscount: 90,
  },
  /**
   * Curated defaults; the marketplace lists ~350 models via GET /v1/models.
   * Users can add more under provider.surplusintelligence.models in opencode.json,
   * including seller-pinned ids like "glm-5.2@zai".
   */
  models: {
    "claude-opus-4.8": { name: "Claude Opus 4.8 (market)" },
    "claude-sonnet-4.6": { name: "Claude Sonnet 4.6 (market)" },
    "deepseek-v4-pro": { name: "DeepSeek V4 Pro (market)" },
    "deepseek-v4-flash": { name: "DeepSeek V4 Flash (market)" },
    "gpt-5.6-sol": { name: "GPT 5.6 Sol (market)" },
    "glm-5.2": { name: "GLM 5.2 (market)" },
    "glm-4.7-flash": { name: "GLM 4.7 Flash (market)" },
    "llama-3.3-70b": { name: "Llama 3.3 70B (market)" },
  },
}

/** USDC on Base mainnet — the asset x402 payments settle in. */
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const
