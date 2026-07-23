# opencode-x402

An [opencode](https://opencode.ai) plugin that turns a locally generated crypto wallet into a payment method for LLM inference. No account, no API key, no subscription: fund the wallet with USDC on Base and every request pays for itself over the [x402 protocol](https://x402.org).

Ships preconfigured for [Surplus Intelligence](https://www.surplusintelligence.ai), an open marketplace that routes each request to the cheapest seller for the model you asked for. The payment core is provider-agnostic (any x402 v2 resource server on an eip155 network).

## How it works

```
opencode ──▶ POST /v1/chat/completions            (no auth)
        ◀── 402 + PAYMENT-REQUIRED                (signed offer: max price for this request)
   plugin: budget check ▸ sign USDC authorization with local key
opencode ──▶ same request + PAYMENT-SIGNATURE
        ◀── 200 + PAYMENT-RESPONSE (settlement tx) + completion
```

Settlement gas is sponsored by the facilitator — the wallet only needs USDC.

## Setup

1. Add the plugin (npm) to `opencode.json`, or for a local checkout add a `file:` dependency in `~/.config/opencode/package.json` plus a re-export in `~/.config/opencode/plugins/x402.ts`:

   ```json
   { "plugin": ["opencode-x402"] }
   ```

2. Run `opencode auth login`, pick **Surplus Intelligence (x402)**, then **Create new wallet — generates a seed phrase**. Choose 12 or 24 words and a backup passphrase. Your seed phrase is displayed **once** in that dialog — write it down offline.

3. Send USDC on **Base** (chain 8453) to the shown address — a few dollars goes a long way.

4. Use `/wallet` in any session, or just pick a `surplusintelligence/*` model and chat.

## `/wallet` command

- `/wallet` — address, USDC/ETH balance, active scheme, today's spend vs caps, backup state. If no wallet exists yet it walks you through setup.
- `/wallet fund` — funding instructions.
- `/wallet config` — management menu (reveal/rotate seed, change passphrase, caps, upgrade scheme).
- `/wallet approve-upto` — one-time on-chain Permit2 approval enabling usage-based settlement.

## Key custody

| Artifact | Where | Protection |
| --- | --- | --- |
| Seed phrase (BIP-39, 12/24 words) | `~/.local/share/opencode/x402/seed.enc.json` | scrypt (N=2¹⁵) + AES-256-GCM under your passphrase, mode 0600 |
| Hot signing key (derived `m/44'/60'/0'/0/0`) | opencode's auth store (`auth.json`) | plaintext, 0600 — this is the day-to-day spending key |
| Address, spend ledger | `~/.local/share/opencode/x402/` | public data |

The passphrase protects the **recovery backup**. The hot key must stay usable without prompts (payments sign automatically mid-request), so treat the whole thing as a hot wallet: small balances, budget caps on.

**Secrets never pass through chat.** Chat context is sent to model providers (on a marketplace: arbitrary sellers) and persisted in transcripts, so the plugin's tools and the `/wallet` command refuse to handle seed phrases, private keys, or passphrases. Secrets flow only through:

- the `opencode auth login` dialog (create / import seed / import raw key), and
- the terminal CLI:

  ```sh
  bunx opencode-x402 reveal      # decrypt and show the seed phrase (asks passphrase)
  bunx opencode-x402 passphrase  # change or set the backup passphrase
  bunx opencode-x402 address     # print the wallet address
  ```

  (`bunx opencode-x402` works once the package is published to npm; for a local-checkout install use `~/.config/opencode/node_modules/.bin/opencode-x402`.)

### Threat model

What an attacker (including a prompt-injected agent inside your session) **can** do:

- Burn budget by triggering paid requests — bounded by `maxPerRequestUsd` / `maxPerDayUsd`, enforced locally before anything is signed.
- Trigger the one-time Permit2 approval tool (subject to opencode's tool-permission flow). The approval only authorizes the canonical Permit2 contract; it moves no funds by itself, and every payment still requires a fresh signature bounded by the server's 402 challenge.

What they **cannot** do through the plugin:

- Read the seed phrase or private key — tools and the `/wallet` command never load or return them; the mnemonic is AES-256-GCM encrypted at rest.
- Redirect funds — the `payTo` address comes from the server's signed 402 challenge, and signatures authorize transfers only to that address for at most the challenged amount.

Residual risk you accept: the derived hot key sits in opencode's auth store (file mode 0600, plaintext) so payments can sign without prompts. Anything that can read your files as your user can spend the wallet. Keep single-digit dollars on it.

## Payment schemes

| Scheme | When | Cost behavior |
| --- | --- | --- |
| `exact` (default) | Works immediately with a USDC-only wallet — fully gasless | Pre-charges the server's estimate (scales with `max_tokens`) |
| `upto` (experimental — implemented and unit-tested, not yet exercised against production settlement) | After a one-time Permit2 approval (`/wallet approve-upto`, needs ~$0.50 Base ETH once) | Authorizes a max, settles **actual usage**; per-request settlement is gasless |

## Options

```json
{
  "plugin": [["opencode-x402", {
    "maxPerRequestUsd": 0.5,
    "maxPerDayUsd": 10,
    "minDiscount": 90,
    "rpcUrl": "https://mainnet.base.org",
    "preferUpto": true
  }]]
}
```

Budget caps apply to the *authorized maximum* per request (a conservative upper bound — `upto` settles less). When a cap would be exceeded the request fails locally before anything is signed.

### Minimum-discount routing (`minDiscount`, default 90)

SI supports a `/min{N}/v1` path segment: requests only route to marketplace sellers whose **estimated buyer discount** vs direct provider price is ≥ N% (`0`–`100`; `0` disables the segment). The plugin bakes this into the provider `baseURL` — default `min90`. If no seller qualifies, SI rejects with `minimum_discount_not_met` (observed live as HTTP 404, docs say 503 — the plugin matches the code), which the plugin surfaces as a clear error including SI's "best otherwise-eligible discount". Two gotchas: the estimate includes the $0.003 x402 fee, so tiny requests skew low; and provider pinning narrows the offer set *before* this filter. An explicit `provider.surplusintelligence.options.baseURL` in your config takes precedence.

### Sub-provider (seller) routing

Every SI model is served by competing sellers (z.ai, Venice, jatevo, Bankr, OpenRouter resellers, …). The router defaults to the cheapest healthy offer; the plugin exposes SI's buyer controls:

- **Inspect the order book**: `/wallet market <model>` — live offers with seller host, $/1M in/out, and % off direct.
- **Pin per model id**: add a model like `"glm-5.2@zai"` (or `"glm-5.2@zai,openrouter"` for an allow-list) under `provider.surplusintelligence.models` — the plugin strips the suffix and injects SI's `provider` body param. Accepted forms: provider id (`zai`), host (`api.z.ai`), or URL.
- **Pin via options**: `"providers": ["zai"]` (global allow-list) or `"modelProviders": { "glm-5.2": ["zai"] }` (per model).
- **Price ceiling**: `"maxPricePer1M": 8.0` injects SI's `max_price_per_1m`, skipping sellers above that rate.
- Precedence: explicit `provider` in the request body > `@suffix` > `modelProviders` > `providers`.
- Pinning failures come back as actionable errors (`unsupported_provider`, `no_sellers_for_model`) instead of bare 4xx.
- SI also supports **BYOK priority providers** (your own key tried first, marketplace as overflow) — that requires a SIWE buyer account and is not wired into this plugin yet.

### Options file

When the plugin is loaded from the plugins directory (the local-checkout install), opencode cannot pass plugin-array options, so the plugin also reads `~/.config/opencode/x402.json` (same keys as above; plugin-array options win when both exist).

## Provider notes (Surplus Intelligence)

- Canonical host `https://api.surplusintelligence.ai/v1` (www. redirects drop payment headers).
- SI adds a flat **$0.003 x402 facilitation fee per request** on top of the market inference price.
- ~350 models via `GET /v1/models`; the plugin preconfigures a handful — add more under `provider.surplusintelligence.models`.
- Wire format: SI's verifier expects the legacy x402 payload envelope (`{x402Version, scheme, network, payload}` with v1 network names). The payment core also implements the spec-pure v2 envelope (`wireFormat: "v2"` in `createX402Fetch`) for servers that verify it.

## Development

```sh
bun install
bun run typecheck
bun run test    # seed encryption round-trip, derivation, permissions
bun run smoke   # live protocol test against SI with a throwaway unfunded wallet (spends nothing)
```

The smoke test proves the full loop client-side: challenge decode → budget gate → exact signing → retry → server-side signature acceptance (terminating at the facilitator's balance check, since the throwaway wallet is empty).
