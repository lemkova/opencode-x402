/**
 * Edge-case suite for the payment loop, driven by an in-process mock x402 server.
 * Fully deterministic and offline (no external network) — safe for CI.
 *
 * Covers: pass-through, malformed challenges, malformed amounts (budget-bypass
 * regression), budget caps (request + daily), retry containment, wire-format
 * envelopes (legacy + v2), Authorization stripping, settle-header capture,
 * concurrency, streaming bodies, non-EVM offers, and CLI failure modes.
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { Ledger, BudgetExceededError } from "../src/ledger.ts"
import { createX402Fetch, type FetchLike, type X402FetchOptions } from "../src/x402.ts"
import { BASE_USDC } from "../src/si.ts"

let failures = 0
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64")

const PAY_TO = "0x8581784D3E598cCa3482375CFF2409Ac9DD8c402"
const exactAccept = (amount: string) => ({
  scheme: "exact",
  network: "eip155:8453",
  asset: BASE_USDC,
  amount,
  payTo: PAY_TO,
  maxTimeoutSeconds: 60,
  extra: { name: "USD Coin", version: "2" },
})
const challenge = (accepts: unknown[]) =>
  b64({
    x402Version: 2,
    error: "Payment required",
    resource: { url: "http://mock/v1/chat/completions", mimeType: "application/json" },
    accepts,
  })
const with402 = (accepts: unknown[], extra?: Record<string, string>) =>
  new Response(JSON.stringify({ error: "payment required" }), {
    status: 402,
    headers: { "PAYMENT-REQUIRED": challenge(accepts), "Content-Type": "application/json", ...extra },
  })

// Per-path request counters + captured payment envelopes.
const hits = new Map<string, number>()
const captured = new Map<string, Record<string, unknown>>()

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname
    hits.set(path, (hits.get(path) ?? 0) + 1)
    const signature = req.headers.get("payment-signature")

    switch (path) {
      case "/ok":
        return Response.json({ fine: true })
      case "/no-header":
        return new Response("payment required, no challenge", { status: 402 })
      case "/bad-header":
        return new Response("nope", { status: 402, headers: { "PAYMENT-REQUIRED": "!!!not-base64-json!!!" } })
      case "/empty-accepts":
        return with402([])
      case "/solana-only":
        return with402([{ ...exactAccept("1000"), network: "solana:mainnet" }])
      case "/nan-amount":
        return with402([exactAccept("not-a-number")])
      case "/huge-amount":
        return with402([exactAccept("999000000")]) // $999
      case "/always-402":
        return with402([exactAccept("1000")])
      case "/pay": {
        if (!signature) {
          if (req.headers.get("authorization")) return new Response("auth header must be stripped", { status: 500 })
          return with402([exactAccept("400000")]) // $0.40
        }
        captured.set(path, JSON.parse(Buffer.from(signature, "base64").toString()) as Record<string, unknown>)
        return Response.json(
          { id: "cmpl-mock", choices: [{ message: { content: "paid" } }] },
          {
            headers: {
              "PAYMENT-RESPONSE": b64({
                success: true,
                transaction: "0xmocktx",
                network: "eip155:8453",
                payer: "0xpayer",
              }),
            },
          },
        )
      }
      case "/pay-v2": {
        if (!signature) return with402([exactAccept("1000")])
        captured.set(path, JSON.parse(Buffer.from(signature, "base64").toString()) as Record<string, unknown>)
        return Response.json({ ok: true })
      }
      case "/pay-stream": {
        if (!signature) return with402([exactAccept("1000")])
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: chunk1\n\n"))
            controller.enqueue(new TextEncoder().encode("data: chunk2\n\n"))
            controller.close()
          },
        })
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } })
      }
      default:
        return new Response("not found", { status: 404 })
    }
  },
})
const origin = `http://localhost:${server.port}`

const account = privateKeyToAccount(generatePrivateKey())
const makeFetch = (overrides?: Partial<X402FetchOptions>) =>
  createX402Fetch({
    account,
    budget: { maxPerRequestUsd: 0.5, maxPerDayUsd: 0.6 },
    ledger: new Ledger(mkdtempSync(join(tmpdir(), "x402-edge-"))),
    providerId: "mock",
    dropAuthorization: true,
    ...overrides,
  })
const post = (payFetch: FetchLike, path: string, headers?: Record<string, string>) =>
  payFetch(`${origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ model: "mock-model", messages: [{ role: "user", content: "hi" }] }),
  })
const expectThrow = async (name: string, promise: Promise<unknown>, match: string | (new (...a: never[]) => Error)) => {
  try {
    await promise
    check(name, false, "expected an error, got success")
  } catch (error) {
    const ok =
      typeof match === "string" ? String(error).includes(match) : error instanceof match
    check(name, ok, String(error).slice(0, 140))
  }
}

// 1. Non-402 passes through untouched.
const okRes = await post(makeFetch(), "/ok")
check("pass-through 200", okRes.ok && (hits.get("/ok") ?? 0) === 1)

// 2. 402 without a challenge header is returned as-is (caller sees the 402).
check("402 w/o challenge returned", (await post(makeFetch(), "/no-header")).status === 402)

// 3. Unparseable challenge header: no crash, original 402 returned.
check("unparseable challenge returned", (await post(makeFetch(), "/bad-header")).status === 402)

// 4/5. No usable offer -> clear error.
await expectThrow("empty accepts", post(makeFetch(), "/empty-accepts"), "no supported payment option")
await expectThrow("non-EVM only", post(makeFetch(), "/solana-only"), "no supported payment option")

// 6. Malformed amount must NOT bypass the budget (NaN regression).
await expectThrow("malformed amount refused", post(makeFetch(), "/nan-amount"), "malformed amount")

// 7. Per-request cap.
await expectThrow("per-request cap", post(makeFetch(), "/huge-amount"), BudgetExceededError)

// 8. Paid flow, legacy envelope: exactly 2 requests, correct wire shape, ledger + settle capture.
{
  const ledger = new Ledger(mkdtempSync(join(tmpdir(), "x402-edge-")))
  const payFetch = createX402Fetch({
    account,
    budget: { maxPerRequestUsd: 0.5, maxPerDayUsd: 0.6 },
    ledger,
    providerId: "mock",
    dropAuthorization: true,
  })
  const res = await post(payFetch, "/pay", { Authorization: "Bearer should-be-stripped" })
  const envelope = captured.get("/pay")!
  const payload = envelope["payload"] as { signature?: string; authorization?: { from?: string; value?: string; to?: string } }
  check("paid 200", res.ok && (hits.get("/pay") ?? 0) === 2)
  check(
    "legacy envelope shape",
    envelope["x402Version"] === 2 && envelope["scheme"] === "exact" && envelope["network"] === "base" && !("accepted" in envelope),
    JSON.stringify(Object.keys(envelope)),
  )
  check(
    "authorization binds amount+payee+signer",
    payload.authorization?.value === "400000" && payload.authorization?.to === PAY_TO && payload.authorization?.from === account.address && /^0x[0-9a-fA-F]{130}$/.test(payload.signature ?? ""),
  )
  const rows = ledger.tail(10)
  check("ledger row w/ settle tx", rows.length === 1 && rows[0]!.maxUsd === 0.4 && rows[0]!.txHash === "0xmocktx")

  // 9. Daily cap: next $0.40 would exceed the $0.60/day budget.
  await expectThrow("daily cap accumulates", post(payFetch, "/pay"), BudgetExceededError)
}

// 10. v2 wire format carries the accepted echo.
{
  const payFetch = makeFetch({ wireFormat: "v2" })
  await post(payFetch, "/pay-v2")
  const envelope = captured.get("/pay-v2")!
  const accepted = envelope["accepted"] as { network?: string; scheme?: string } | undefined
  check("v2 envelope shape", accepted?.scheme === "exact" && accepted?.network === "eip155:8453" && !("scheme" in envelope))
}

// 11. Exactly one retry on persistent 402 — no loops, clear rejection error.
{
  await expectThrow("persistent 402 rejects", post(makeFetch(), "/always-402"), "payment was rejected")
  check("retry containment (2 requests)", hits.get("/always-402") === 2, `hits=${hits.get("/always-402")}`)
}

// 12. Concurrency: parallel payments both settle, both ledgered.
{
  const ledger = new Ledger(mkdtempSync(join(tmpdir(), "x402-edge-")))
  const payFetch = createX402Fetch({
    account,
    budget: { maxPerRequestUsd: 0.5, maxPerDayUsd: 5 },
    ledger,
    providerId: "mock",
  })
  const [a, b] = await Promise.all([post(payFetch, "/pay"), post(payFetch, "/pay")])
  check("concurrent payments", a.ok && b.ok && ledger.tail(10).length === 2)
}

// 13. Streaming bodies pass through intact after payment.
{
  const res = await post(makeFetch(), "/pay-stream")
  const text = await res.text()
  check("streamed body intact", res.ok && text.includes("chunk1") && text.includes("chunk2"))
}

// 14. GET request with 402: pays and retries without a body.
{
  const payFetch = makeFetch()
  const res = await payFetch(`${origin}/pay`, { method: "GET" })
  check("GET pay flow", res.ok)
}

// 15. CLI failure modes: clean single-line errors, no stack traces, correct exits.
{
  const isolated = { ...process.env, XDG_DATA_HOME: mkdtempSync(join(tmpdir(), "x402-cli-")) }
  const help = Bun.spawnSync(["bun", "src/cli.ts", "help"], { env: isolated })
  check("cli help exits 0", help.exitCode === 0)
  const address = Bun.spawnSync(["bun", "src/cli.ts", "address"], { env: isolated })
  const addressErr = address.stderr.toString()
  check("cli no-seed clean error", address.exitCode === 1 && addressErr.includes("No seed backup") && !addressErr.includes("at "), addressErr.trim().slice(0, 80))
  const reveal = Bun.spawnSync(["bun", "src/cli.ts", "reveal"], { env: isolated, stdin: "ignore" })
  check("cli reveal no-seed clean error", reveal.exitCode === 1 && !reveal.stderr.toString().includes("throw"))
}

server.stop(true)
process.exit(failures === 0 ? 0 : 1)
