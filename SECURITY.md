# Security Policy

This plugin signs cryptocurrency payments from a hot wallet. Security reports are taken seriously.

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Use [GitHub private vulnerability reporting](https://github.com/lemkova/opencode-x402/security/advisories/new) instead. You should get an initial response within a few days.

## Scope

In scope:

- Seed/key handling: the encrypted seed backup (`seed.enc.json`), hot-key flow through opencode's auth store, the CLI reveal path
- Payment logic: anything that could sign for more than the server's 402 challenge, redirect `payTo`, bypass budget caps, or replay signatures
- Secret leakage into chat context, logs, the spend ledger, or error messages
- Supply-chain concerns in the pinned dependency set

Out of scope:

- Vulnerabilities in Surplus Intelligence's marketplace or the x402 facilitator infrastructure (report upstream)
- Attacks requiring an already-compromised user account or root on the machine (the hot key is readable by the local user by design — see the threat model in the README)
- Social engineering of the wallet owner

## Design guarantees worth attacking

If you can break any of these claims, that is a vulnerability:

1. The seed phrase and passphrase never enter chat context or the LLM prompt.
2. Payment signatures are bounded by the server-challenged amount and recipient.
3. Budget caps are enforced before any signature is produced.
4. The tools/commands never return private key material.
