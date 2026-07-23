# Contributing

Thanks for your interest! This project is small and focused: an opencode plugin that pays for LLM inference over x402 from a locally held wallet.

## Development setup

Requirements: [Bun](https://bun.sh) ≥ 1.1.

```sh
git clone https://github.com/lemkova/opencode-x402
cd opencode-x402
bun install
bun run typecheck   # tsc --noEmit
bun run test        # seed crypto + routing tests (set SKIP_LIVE=1 to skip network checks)
bun run smoke       # full live x402 protocol test vs Surplus Intelligence (throwaway wallet, spends nothing)
```

To run your working copy inside opencode, add a `file:` dependency in `~/.config/opencode/package.json` and re-export the plugin from `~/.config/opencode/plugins/x402.ts`:

```ts
export { X402WalletPlugin } from "opencode-x402"
```

## Ground rules

- **Never handle secrets in chat paths.** Anything a tool returns or a command templates enters LLM context and session transcripts. Seed phrases, private keys, and passphrases flow only through the auth dialog or the terminal CLI. PRs that violate this are rejected regardless of convenience.
- **Payment-path changes need evidence.** If you touch `src/x402.ts` or `src/routing.ts`, include smoke-test output (it spends nothing) and, where relevant, a captured 402/response exchange.
- **Dependencies are exact-pinned.** This code signs money; version bumps should be deliberate, reviewed commits — not ranges.
- Keep the payment core (`src/x402.ts`) provider-agnostic; Surplus Intelligence specifics live in `src/si.ts` / `src/routing.ts`.

## Module map

| File | Responsibility |
| --- | --- |
| `src/x402.ts` | Generic x402 v2 payment fetch (402 → budget gate → sign → retry) |
| `src/seed.ts` | BIP-39 mnemonic generation, scrypt+AES-256-GCM seed backup |
| `src/wallet.ts` | Key validation, non-secret wallet state |
| `src/ledger.ts` | Append-only spend ledger, budget caps |
| `src/routing.ts` | SI sub-provider pinning, price ceiling, market order book |
| `src/si.ts` | Surplus Intelligence preset (host, models, USDC) |
| `src/index.ts` | Plugin wiring: auth methods, provider config, `/wallet` command, tools |
| `src/cli.ts` | Out-of-band terminal CLI for secrets (reveal/passphrase) |

## Pull requests

- One logical change per PR; conventional-commit style subjects (`fix:`, `feat:`, `docs:`…).
- CI (typecheck + unit tests) must be green.
- Update the README and `CHANGELOG.md` when behavior changes.
