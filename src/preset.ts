/**
 * An x402 provider preset: everything the generic wallet/payment core needs to
 * offer one OpenAI-compatible, x402-paid endpoint inside opencode.
 *
 * The payment loop itself (402 -> budget gate -> sign -> retry) is provider-agnostic.
 * Marketplace features (minimum-discount routing, seller pinning, order books) are
 * opt-in via `marketplace` — plain x402 servers don't have them.
 */
export type X402ProviderPreset = {
  /** opencode provider id, e.g. "surplusintelligence". Also the auth-store key and the options-file section name. */
  id: string
  /** Display name shown in `opencode auth login` and the model picker. */
  name: string
  /** OpenAI-compatible API base URL (including /v1). */
  baseURL: string
  /** AI SDK package for the provider. Default "@ai-sdk/openai-compatible". */
  npm?: string
  /** Models offered by default; users can extend via provider.<id>.models in opencode.json. */
  models?: Record<string, { name: string }>
  /**
   * x402 PAYMENT-SIGNATURE envelope dialect. "legacy" = v1-style `{x402Version, scheme, network, payload}`
   * (what most production facilitator stacks verify today); "v2" = the spec-pure envelope.
   * Default "legacy".
   */
  wireFormat?: "legacy" | "v2"
  /**
   * Marketplace capabilities (Surplus Intelligence-style). Enables:
   * minimum-discount routing (`/min{N}` path segment), seller pinning / price
   * ceiling body params, the `/wallet market` order book, and marketplace error
   * enrichment. Leave unset for plain x402 servers.
   */
  marketplace?: {
    /** API origin without path, e.g. "https://api.surplusintelligence.ai". */
    apiOrigin: string
    /** Default minimum seller discount (0 disables). Overridable per install via options. */
    defaultMinDiscount?: number
  }
  /**
   * Register the `/wallet` command and `x402_wallet` tool from this instance.
   * Default true. Set false on secondary providers so names don't collide —
   * the wallet, ledger, and caps are shared across all instances anyway.
   */
  registerTools?: boolean
}
