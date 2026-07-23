# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning: [SemVer](https://semver.org/).

## [Unreleased]

### Added

- `makeX402Plugin(preset)` factory: wire any x402-speaking OpenAI-compatible endpoint to the shared wallet; Surplus Intelligence is now just the bundled preset (`X402WalletPlugin`)
- Seed backups are never overwritten: re-creating a wallet renames the previous `seed.enc.json` to `seed.enc.json.bak-<timestamp>`

### Changed

- **Breaking (options):** marketplace options moved under the provider id (`{"surplusintelligence": {...}}`); seller allow-lists renamed `providers` → `sellers` and `modelProviders` → `modelSellers` to avoid confusion with x402 providers. Wallet-level options (`maxPerRequestUsd`, `maxPerDayUsd`, `rpcUrl`, `preferUpto`) stay top-level.
- Marketplace features (min-discount routing, seller pinning, `/wallet market`, routing-error enrichment) activate only for presets that declare `marketplace`

## [0.1.0] - 2026-07-23

### Added

- x402 v2 payment fetch: automatic 402 → sign → retry with `exact` (EIP-3009) and experimental `upto` (Permit2) schemes; legacy and spec-v2 wire formats
- Wallet lifecycle via `opencode auth login`: create (12/24-word BIP-39 seed, shown once), import seed, import raw key
- Encrypted seed backup at rest (scrypt N=2¹⁵ + AES-256-GCM, optional passphrase) with terminal CLI (`reveal`, `passphrase`, `address`)
- `/wallet` command + `x402_wallet` tool: status/balances, funding help, config, live seller order book (`market`), one-time Permit2 approval (`approve-upto`)
- Budget caps (`maxPerRequestUsd`, `maxPerDayUsd`) enforced before signing; append-only JSONL spend ledger with settlement tx hashes
- Surplus Intelligence preset: canonical host, curated model list, minimum-discount routing (`minDiscount`, default 90) via `/min{N}/v1`
- Sub-provider (seller) controls: `model@provider` suffix, `providers`/`modelProviders` allow-lists, `maxPricePer1M` ceiling, actionable routing errors
- Options file `~/.config/opencode/x402.json` for installs that cannot pass plugin-array options
