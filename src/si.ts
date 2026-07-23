/** Surplus Intelligence preset — the first bundled x402 provider. */
export const SI = {
  providerId: "surplusintelligence",
  name: "Surplus Intelligence (x402)",
  npm: "@ai-sdk/openai-compatible",
  /** Canonical API host. www. redirects drop x402 payment headers. */
  apiOrigin: "https://api.surplusintelligence.ai",
  baseURL: "https://api.surplusintelligence.ai/v1",
  /**
   * Curated defaults; the marketplace lists ~350 models via GET /v1/models.
   * Users can add more under provider.surplusintelligence.models in opencode.json.
   */
  defaultModels: {
    "claude-opus-4.8": { name: "Claude Opus 4.8 (market)" },
    "claude-sonnet-4.6": { name: "Claude Sonnet 4.6 (market)" },
    "deepseek-v4-pro": { name: "DeepSeek V4 Pro (market)" },
    "deepseek-v4-flash": { name: "DeepSeek V4 Flash (market)" },
    "gpt-5.6-sol": { name: "GPT 5.6 Sol (market)" },
    "glm-5.2": { name: "GLM 5.2 (market)" },
    "glm-4.7-flash": { name: "GLM 4.7 Flash (market)" },
    "llama-3.3-70b": { name: "Llama 3.3 70B (market)" },
  },
} as const

/** USDC on Base mainnet — the asset SI settles in. */
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const
