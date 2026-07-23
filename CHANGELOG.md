# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning: [SemVer](https://semver.org/).

## [Unreleased]

### Added

- `makeX402Plugin(preset)` factory: wire any x402-speaking OpenAI-compatible endpoint to the shared wallet; Surplus Intelligence is now just the bundled preset (`X402WalletPlugin`)
- Seed backups are never overwritten: re-creating a wallet renames the previous `seed.enc.json` to `seed.enc.json.bak-<timestamp>`
- Edge-case test suite driven by an in-process mock x402 server (deterministic, offline, CI-safe): malformed challenges/amounts, budget caps, retry containment, both wire formats, Authorization stripping, concurrency, streaming, CLI failure modes

### Changed

- **Breaking (options):** marketplace options moved under the provider id (`{"surplusintelligence": {...}}`); seller allow-lists renamed `providers` → `sellers` and `modelProviders` → `modelSellers` to avoid confusion with x402 providers. Wallet-level options (`maxPerRequestUsd`, `maxPerDayUsd`, `rpcUrl`, `preferUpto`) stay top-level.
- Marketplace features (min-discount routing, seller pinning, `/wallet market`, routing-error enrichment) activate only for presets that declare `marketplace`

### Fixed

- **Budget bypass:** a malformed `amount` in a 402 challenge parsed to `NaN`, and NaN comparisons silently skipped both spending caps; amounts are now strictly validated (base-10 integer) before anything is signed
- **Daily-cap poisoning:** a non-finite ledger row disabled `todayTotalUsd()` permanently; totals now skip non-finite values and appends sanitize them
- Hex-valid but curve-invalid private keys (e.g. all zeros) no longer crash the auth flow — import fails cleanly, the loader logs and disables payments
- `/wallet` status degrades gracefully when the Base RPC is unreachable instead of throwing
- `/wallet approve-upto` is idempotent: detects an existing Permit2 allowance and skips the transaction
- Stale `Content-Length` headers are dropped after seller-routing body rewrites
- Duplicate `/wallet` tool registration is impossible when multiple presets load — the first instance claims the shared UI
- CLI prints clean single-line errors (wrong passphrase, non-TTY stdin) instead of stack traces; unparseable market data no longer rejects the tool

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
