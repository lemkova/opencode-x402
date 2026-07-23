/** Dev check: body-rewrite semantics for sub-provider routing. */
import { applyRouting, formatMarket } from "../src/routing.ts"

let failures = 0
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}
const enc = new TextEncoder()
const rewrite = (body: object, cfg: Parameters<typeof applyRouting>[1]): Record<string, unknown> =>
  JSON.parse(new TextDecoder().decode(applyRouting(enc.encode(JSON.stringify(body)), cfg)!))

// @suffix: single provider
let out = rewrite({ model: "glm-5.2@zai", messages: [] }, {})
check("suffix single", out["model"] === "glm-5.2" && out["provider"] === "zai", JSON.stringify(out))

// @suffix: allow-list
out = rewrite({ model: "glm-5.2@zai,openrouter", messages: [] }, {})
check("suffix list", out["model"] === "glm-5.2" && JSON.stringify(out["provider"]) === '["zai","openrouter"]')

// modelProviders beats global providers
out = rewrite({ model: "glm-5.2", messages: [] }, { providers: ["venice"], modelProviders: { "glm-5.2": ["zai"] } })
check("modelProviders precedence", out["provider"] === "zai")

// global providers fallback
out = rewrite({ model: "other-model", messages: [] }, { providers: ["venice"], modelProviders: { "glm-5.2": ["zai"] } })
check("global fallback", out["provider"] === "venice")

// explicit body.provider wins over everything
out = rewrite({ model: "glm-5.2@zai", provider: "venice", messages: [] }, { providers: ["openrouter"] })
check("explicit body wins", out["provider"] === "venice" && out["model"] === "glm-5.2")

// price ceiling injected, not overridden
out = rewrite({ model: "m", messages: [] }, { maxPricePer1M: 8 })
check("price ceiling injected", out["max_price_per_1m"] === 8)
out = rewrite({ model: "m", max_price_per_1m: 2, messages: [] }, { maxPricePer1M: 8 })
check("price ceiling not overridden", out["max_price_per_1m"] === 2)

// no config, no suffix -> unchanged bytes (same reference)
const bytes = enc.encode(JSON.stringify({ model: "m", messages: [] }))
check("no-op keeps reference", applyRouting(bytes, {}) === bytes)

// non-JSON body untouched
const raw = enc.encode("not json")
check("non-json untouched", applyRouting(raw, { providers: ["zai"] }) === raw)

// live: market order book renders (skipped in CI via SKIP_LIVE=1 — depends on SI uptime)
if (process.env["SKIP_LIVE"] !== "1") {
  const market = await formatMarket("https://api.surplusintelligence.ai", "glm-5.2")
  console.log("---\n" + market + "\n---")
  check("market live", market.includes("Order book") && market.includes("#1"))
}

process.exit(failures === 0 ? 0 : 1)
