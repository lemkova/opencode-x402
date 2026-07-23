/**
 * Live smoke test against Surplus Intelligence with a throwaway, unfunded wallet.
 *
 * Proves the full client-side x402 loop without spending funds:
 *   1. bogus bearer probe          -> documents whether dropAuthorization is required
 *   2. 402 challenge               -> decoded, schemes listed
 *   3. sign exact + retry          -> server must REJECT the payment (empty wallet), not error on format
 *   4. budget cap                  -> BudgetExceededError before any signing
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { Ledger, BudgetExceededError } from "../src/ledger.ts"
import { createX402Fetch } from "../src/x402.ts"
import { SI } from "../src/si.ts"

const endpoint = `${SI.baseURL}/chat/completions`
const body = JSON.stringify({
  model: "llama-3.3-70b",
  messages: [{ role: "user", content: "Say exactly: pong" }],
  max_tokens: 8,
})
const jsonHeaders = { "Content-Type": "application/json" }

let failures = 0
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`)
  if (!ok) failures++
}

// 1. Does a bogus bearer still yield 402 (or does it 401)?
const bogus = await fetch(endpoint, {
  method: "POST",
  headers: { ...jsonHeaders, Authorization: "Bearer x402-wallet" },
  body,
})
check("bogus-bearer probe", bogus.status === 402 || bogus.status === 401, `status=${bogus.status} (401 means dropAuthorization is load-bearing)`)

const account = privateKeyToAccount(generatePrivateKey())
const ledger = new Ledger(mkdtempSync(join(tmpdir(), "x402-smoke-")))

// 2 + 3. Full loop with an empty wallet: expect a payment rejection, not a protocol error.
const paidFetch = createX402Fetch({
  account,
  budget: { maxPerRequestUsd: 0.05, maxPerDayUsd: 0.05 },
  ledger,
  providerId: SI.id,
  dropAuthorization: true,
  log: (level, message) => console.log(`  [${level}] ${message}`),
})
try {
  const res = await paidFetch(endpoint, {
    method: "POST",
    headers: { ...jsonHeaders, Authorization: "Bearer x402-wallet" },
    body,
  })
  check("sign+retry loop", false, `unexpected success: status=${res.status} ${await res.text()}`)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  check(
    "sign+retry loop",
    message.includes("payment was rejected"),
    message.slice(0, 300),
  )
}

// 4. Budget cap fires before signing.
const cappedFetch = createX402Fetch({
  account,
  budget: { maxPerRequestUsd: 0.000001, maxPerDayUsd: 1 },
  ledger,
  providerId: SI.id,
  dropAuthorization: true,
})
try {
  await cappedFetch(endpoint, { method: "POST", headers: jsonHeaders, body })
  check("budget cap", false, "no error thrown")
} catch (error) {
  check("budget cap", error instanceof BudgetExceededError, String(error).slice(0, 200))
}

process.exit(failures === 0 ? 0 : 1)
