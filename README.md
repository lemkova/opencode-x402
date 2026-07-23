# opencode-x402

[![CI](https://github.com/lemkova/opencode-x402/actions/workflows/ci.yml/badge.svg)](https://github.com/lemkova/opencode-x402/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/runtime-bun-f9f1e1)](https://bun.sh)

**Pay for LLM inference per request with USDC — no account, no API key, no subscription.**

An [opencode](https://opencode.ai) plugin that turns a locally generated crypto wallet into a payment method over the [x402 protocol](https://x402.org) (HTTP 402 + signed stablecoin authorizations on Base). Ships preconfigured for [Surplus Intelligence](https://www.surplusintelligence.ai), an open marketplace where sellers compete to serve each model — requests route to the cheapest qualifying offer, often 90%+ below direct provider rates.

```
opencode ──▶ POST /v1/chat/completions            (no auth)
        ◀── 402 + PAYMENT-REQUIRED                (signed offer: max price for this request)
   plugin: budget check ▸ sign USDC authorization with local key
opencode ──▶ same request + PAYMENT-SIGNATURE
        ◀── 200 + PAYMENT-RESPONSE (settlement tx) + completion
```

## Features

- **Zero-setup, zero-gas payments** — generate a wallet, send it USDC on Base, chat. **No ETH, ever**: you only sign; the facilitator broadcasts and pays gas. Sole exception: the optional `upto` upgrade needs one ~$0.50 approval tx.
- **Seed-phrase custody** — 12/24-word BIP-39 wallet; on-disk backup encrypted with scrypt + AES-256-GCM under your passphrase. Secrets never enter chat context.
- **Spending guardrails** — per-request and per-day USD caps enforced locally *before* anything is signed; append-only spend ledger with settlement tx hashes.
- **`/wallet` command** — balance, funding, config, live seller order books, scheme upgrade.
- **Marketplace controls** — minimum-discount routing (default: only sellers ≥90% below direct price), per-model seller pinning, price ceilings.
- **Provider-agnostic core** — the payment loop works against any x402 v2 resource server on an eip155 network; Surplus Intelligence is the bundled preset.

## Quickstart

1. **Install** — add to `opencode.json`:

   ```json
   { "plugin": ["opencode-x402"] }
   ```

   <details><summary>From a local checkout instead</summary>

   Add a `file:` dependency in `~/.config/opencode/package.json` (`"opencode-x402": "file:/path/to/checkout"`) and create `~/.config/opencode/plugins/x402.ts`:

   ```ts
   export { X402WalletPlugin } from "opencode-x402"
   ```

   </details>

2. **Create the wallet** — `opencode auth login` → **Surplus Intelligence (x402)** → **Create new wallet**. Pick 12/24 words and a backup passphrase. The seed phrase is shown **once, in that dialog only** — write it down offline.

3. **Fund it** — send USDC on **Base** (chain 8453) to the shown address. A few dollars goes a long way. **Do not send ETH — it isn't needed.** Payments are gasless: you sign, the facilitator pays the network fee.

4. **Use it** — pick a `surplusintelligence/*` model and chat, or check in with `/wallet`.

## The `/wallet` command

| Invocation | Does |
| --- | --- |
| `/wallet` | Address, USDC/ETH balance, active scheme, routing threshold, today's spend vs caps, backup state, recent payments |
| `/wallet fund` | Funding instructions |
| `/wallet market <model>` | Live seller order book: host, $/1M in/out, % off direct |
| `/wallet config` | Management menu (reveal/rotate seed, passphrase, caps, pinning) |
| `/wallet approve-upto` | One-time on-chain Permit2 approval enabling usage-based settlement |

## Configuration

Via plugin-array options in `opencode.json` (`"plugin": [["opencode-x402", { ... }]]` — npm installs) or the options file `~/.config/opencode/x402.json` (any install; plugin-array wins on conflict).

**Wallet-level options are top-level** (they apply to every x402 provider — one wallet pays them all). **Marketplace options are scoped under the provider id**, because they are provider-specific features (minimum-discount routing, seller pinning, and price ceilings exist on Surplus Intelligence, not in the x402 protocol).

**Zero config is a complete config.** The defaults below are what you get out of the box — the router accepts **any seller** that clears the minimum discount; nothing is pinned:

```json
{
  "maxPerRequestUsd": 0.5,
  "maxPerDayUsd": 10,
  "rpcUrl": "https://mainnet.base.org",
  "preferUpto": true,

  "surplusintelligence": {
    "minDiscount": 90
  }
}
```

| Scope | Option | Default | Meaning |
| --- | --- | --- | --- |
| wallet | `maxPerRequestUsd` | `0.5` | Refuse to sign any single payment above this |
| wallet | `maxPerDayUsd` | `10` | Refuse once today's authorized total would exceed this |
| wallet | `preferUpto` | `true` | Use usage-based settlement once Permit2 approval exists |
| wallet | `rpcUrl` | `https://mainnet.base.org` | Base RPC for balance/allowance reads and `upto` signing |
| marketplace | `minDiscount` | preset (SI: `90`) | Only route to sellers ≥ N% below direct provider price (`0` disables) |
| marketplace | `sellers` | **unset — all sellers accepted** | *Opt-in restriction:* allow-list, e.g. `["zai", "api.venice.ai"]`. Setting it **rejects every seller not listed**, even cheaper ones |
| marketplace | `modelSellers` | **unset — all sellers accepted** | *Opt-in restriction:* per-model allow-lists, e.g. `{ "glm-5.2": ["zai"] }` |
| marketplace | `maxPricePer1M` | **unset — no ceiling** | *Opt-in restriction:* skip sellers priced above this many USD per 1M tokens |

Restriction options narrow routing *before* the discount filter — a narrow pin can make `minDiscount` unsatisfiable even when other sellers qualify. Leave them unset unless you specifically need to exclude sellers.

Budget caps apply to the *authorized maximum* per request — a conservative upper bound (`upto` settles less; `exact` settles exactly that).

### Other x402 providers

The payment core is provider-agnostic; Surplus Intelligence is just the bundled preset. To pay any other x402-speaking, OpenAI-compatible endpoint with the **same wallet**, export another plugin instance from your plugins file:

```ts
// ~/.config/opencode/plugins/x402.ts
import { makeX402Plugin } from "opencode-x402"

export { X402WalletPlugin } from "opencode-x402" // Surplus Intelligence preset

export const AcmeX402 = makeX402Plugin({
  id: "acme",
  name: "Acme (x402)",
  baseURL: "https://api.acme.ai/v1",
  models: { "acme-large": { name: "Acme Large" } },
  wireFormat: "legacy", // or "v2" for spec-pure servers
  registerTools: false, // /wallet + tools are already registered by the SI instance
})
```

Then `opencode auth login` → *Acme (x402)* → **Import seed phrase** (reuse the same wallet) or create a fresh one. Wallet caps and the spend ledger are shared across instances; marketplace-only features (min-discount, pinning, `/wallet market`) stay off unless the preset declares `marketplace`.

### Payment schemes

| Scheme | When | Cost behavior |
| --- | --- | --- |
| `exact` (default) | Immediately, USDC-only wallet, fully gasless | Pre-charges the server's estimate — **scales with `max_tokens`**, so agent workloads with large output limits overpay |
| `upto` (experimental — implemented and unit-tested, not yet exercised against production settlement) | After `/wallet approve-upto` (one tx, ~$0.50 Base ETH once) | Authorizes a max, settles **actual usage**; settlement gasless |

### Minimum-discount routing (Surplus Intelligence)

SI supports a `/min{N}/v1` path segment: requests only route to sellers whose **estimated buyer discount** vs direct price is ≥ N%. The plugin bakes `minDiscount` into the provider baseURL (SI preset default: `min90`). No qualifying seller → `minimum_discount_not_met` (observed live as HTTP 404; docs say 503 — the plugin matches the error code, not the status), surfaced as an actionable error including SI's "best otherwise-eligible discount". Two gotchas: the estimate includes the $0.003 x402 fee (tiny requests skew low), and seller pinning narrows the offer set *before* this filter. Order books move — a model that cleared 90% an hour ago may not now; failed routing is never charged.

### Seller routing (Surplus Intelligence)

Every marketplace model is served by competing sellers (z.ai, Venice, jatevo, Bankr, OpenRouter resellers, …). Controls, in precedence order (explicit request `provider` beats all):

- **`model@seller` suffix** — add a model id like `"glm-5.2@zai"` (or `"glm-5.2@zai,openrouter"`) under `provider.surplusintelligence.models`; the plugin strips the suffix and injects SI's `provider` body param. Accepted forms: seller id (`zai`), host (`api.z.ai`), or URL.
- **`modelSellers`** then **`sellers`** options (above).
- **`maxPricePer1M`** injects SI's `max_price_per_1m` ceiling.

Pinning failures return actionable errors (`unsupported_provider`, `no_sellers_for_model`) instead of bare 4xx. SI also supports BYOK priority providers (your own key tried first) — that requires a SIWE buyer account and is not wired into this plugin.

## Key custody & threat model

| Artifact | Where | Protection |
| --- | --- | --- |
| Seed phrase (BIP-39) | `~/.local/share/opencode/x402/seed.enc.json` | scrypt (N=2¹⁵) + AES-256-GCM under your passphrase, mode 0600 |
| Hot signing key (`m/44'/60'/0'/0/0`) | opencode's auth store | plaintext, 0600 — the day-to-day spending key |
| Address, spend ledger | `~/.local/share/opencode/x402/` | public data |

**Secrets never pass through chat.** Chat context is sent to model providers (on a marketplace: arbitrary sellers) and persisted in transcripts, so tools and `/wallet` refuse to handle seed phrases, keys, or passphrases. Secrets flow only through the `opencode auth login` dialog and the terminal CLI:

```sh
opencode-x402 reveal      # decrypt and show the seed phrase (asks passphrase)
opencode-x402 passphrase  # change or set the backup passphrase
opencode-x402 address     # print the wallet address
```

(Run via `bunx opencode-x402` for npm installs, or `~/.config/opencode/node_modules/.bin/opencode-x402` for local checkouts.)

What an attacker — including a prompt-injected agent inside your session — **can** do: burn budget up to your caps; trigger the Permit2 approval (moves no funds; every payment still needs a fresh bounded signature). What they **cannot** do through the plugin: read the seed (encrypted, never loaded by tools) or redirect funds (`payTo` and amount are bound by the server's signed 402 challenge). Residual risk: the hot key is plaintext-0600 on disk so payments can sign without prompts — anything that reads your files as your user can spend the wallet. **Keep single-digit dollars on it.**

## FAQ

**Do I need ETH for gas?** **No — never for payments.** The wallet signs an authorization off-chain; the facilitator broadcasts the USDC transfer and pays the gas. A USDC-only wallet is fully functional from the first request. ETH becomes relevant only if you opt into the experimental `upto` scheme (one ~$0.50 approval transaction, once).

**Why `minimum_discount_not_met`?** No seller currently clears your `minDiscount` for that model — order books move. Lower it, unpin, or `/wallet market <model>` to look at the book. Failed routing is never charged.

**Why did a 4-word reply cost $0.11?** The `exact` scheme pre-charges the estimate, which scales with `max_tokens` and the model's market rate. Upgrade to `upto` (`/wallet approve-upto`) to settle actual usage.

**Why is there no tx hash on some ledger rows?** Streaming responses can't carry the `PAYMENT-RESPONSE` header (settlement completes after headers are sent). Non-streamed requests record it.

**Model exists on SI but opencode rejects it?** opencode only offers models declared in config — add it under `provider.surplusintelligence.models`. SI lists ~350 via `GET /v1/models`; note that catalog ≠ routable (no active seller → 404, not charged).

## Provider notes (Surplus Intelligence)

- Canonical host `https://api.surplusintelligence.ai/v1` — `www.` redirects drop payment headers.
- Flat **$0.003 x402 facilitation fee per request** on top of the market price (SIWE/API-key accounts don't pay it).
- Wire format: SI verifies the legacy x402 envelope (`{x402Version, scheme, network, payload}`, v1 network names). The core also implements spec-pure v2 (`wireFormat: "v2"` in `createX402Fetch`) for servers that verify it.

## Development

```sh
bun install
bun run typecheck   # tsc --noEmit
bun run test        # seed crypto + routing + payment-loop edge tests vs a mock x402 server (SKIP_LIVE=1 skips network checks)
bun run smoke       # live protocol test vs SI with a throwaway unfunded wallet (spends nothing)
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the module map and ground rules, and [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## Disclaimer

This is experimental software that signs cryptocurrency transactions from a hot wallet. Use at your own risk, keep only small balances on the wallet, and audit the code before trusting it with funds. MIT licensed — see [LICENSE](LICENSE).
