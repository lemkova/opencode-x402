## What

<!-- One-paragraph summary of the change and why. -->

## Checklist

- [ ] `bun run typecheck` and `bun run test` pass locally
- [ ] Payment-path change (`src/x402.ts` / `src/routing.ts`)? Attach `bun run smoke` output (spends nothing)
- [ ] No secrets (seed phrases, keys, passphrases) can reach chat context, logs, or the ledger
- [ ] README / CHANGELOG updated if behavior changed
