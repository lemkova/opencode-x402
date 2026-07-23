import { SI } from "./si.ts"

/**
 * SI sub-provider (seller) routing controls, applied by rewriting the request body
 * before the payment loop runs:
 * - `model@provider` suffix in the model id (comma-separated allow-list): "glm-5.2@zai,openrouter"
 * - per-model and global provider allow-lists from plugin options
 * - `max_price_per_1m` price ceiling (skips sellers above it)
 * Precedence: explicit body.provider > @suffix > modelProviders[model] > providers.
 */
export type RoutingConfig = {
  providers?: string[]
  modelProviders?: Record<string, string[]>
  maxPricePer1M?: number
}

export function applyRouting(bodyBytes: Uint8Array | undefined, config: RoutingConfig): Uint8Array | undefined {
  if (!bodyBytes) return bodyBytes
  let body: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bodyBytes))
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return bodyBytes
    body = parsed as Record<string, unknown>
  } catch {
    return bodyBytes
  }
  if (typeof body["model"] !== "string") return bodyBytes

  let model = body["model"]
  let pinned: string[] | undefined
  let changed = false
  const at = model.lastIndexOf("@")
  if (at > 0) {
    pinned = model
      .slice(at + 1)
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
    model = model.slice(0, at)
    body["model"] = model
    changed = true
    if (pinned.length === 0) pinned = undefined
  }

  if (body["provider"] === undefined) {
    const allowList = pinned ?? config.modelProviders?.[model] ?? config.providers
    if (allowList && allowList.length > 0) {
      body["provider"] = allowList.length === 1 ? allowList[0] : allowList
      changed = true
    }
  }
  if (body["max_price_per_1m"] === undefined && config.maxPricePer1M !== undefined && config.maxPricePer1M > 0) {
    body["max_price_per_1m"] = config.maxPricePer1M
    changed = true
  }

  return changed ? new TextEncoder().encode(JSON.stringify(body)) : bodyBytes
}

type MarketOffer = {
  rank?: number
  seller?: string
  seller_base_url?: string
  effective_input_per_1m?: number | null
  effective_output_per_1m?: number | null
  direct_input_per_1m?: number | null
  direct_output_per_1m?: number | null
  reference_provider?: string
}

/** Render the live order book (sub-providers) for a model. Public endpoint, no auth. */
export async function formatMarket(model: string): Promise<string> {
  const response = await fetch(`${SI.apiOrigin}/api/markets/${encodeURIComponent(model)}`)
  if (!response.ok) return `No market data for "${model}" (HTTP ${response.status}). Check the model id via GET /v1/models.`
  const data = (await response.json()) as { model?: string; offers?: MarketOffer[] }
  const offers = data.offers ?? []
  if (offers.length === 0) return `No active seller offers for "${model}" right now.`

  const usd = (micro: number | null | undefined) => (micro == null ? "?" : `$${(micro / 1e6).toFixed(4)}`)
  const lines = offers.map((offer) => {
    let host = "unknown"
    try {
      if (offer.seller_base_url) host = new URL(offer.seller_base_url).host
    } catch {
      // keep "unknown"
    }
    const effIn = offer.effective_input_per_1m
    const effOut = offer.effective_output_per_1m
    const dirIn = offer.direct_input_per_1m
    const dirOut = offer.direct_output_per_1m
    let discount = ""
    if (effIn != null && dirIn != null && dirIn + (dirOut ?? 0) > 0) {
      const pct = 100 * (1 - (effIn + (effOut ?? 0)) / (dirIn + (dirOut ?? 0)))
      discount = `  ${pct.toFixed(1)}% off direct`
    }
    return `  #${offer.rank ?? "?"}  ${host}  in ${usd(effIn)}/1M  out ${usd(effOut)}/1M${discount}`
  })
  return [
    `Order book for ${data.model ?? model} (${offers.length} offer${offers.length === 1 ? "" : "s"}; router picks cheapest healthy):`,
    ...lines,
    `Pin a seller: use model id "${data.model ?? model}@<provider>" (e.g. @zai, @api.venice.ai) or the "providers" plugin option.`,
  ].join("\n")
}
