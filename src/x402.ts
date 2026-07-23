import { createPublicClient, http } from "viem"
import { base } from "viem/chains"
import type { PrivateKeyAccount } from "viem/accounts"
import { ExactEvmScheme, UptoEvmScheme, toClientEvmSigner, PERMIT2_ADDRESS, erc20AllowanceAbi } from "@x402/evm"
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http"
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types"
import { checkBudget, type Budget, type Ledger } from "./ledger.ts"

export const DEFAULT_BASE_RPC = "https://mainnet.base.org"

/** x402 v1 network names by CAIP-2 id, for the legacy wire format. */
const V1_NETWORK_BY_CAIP: Record<string, string> = {
  "eip155:8453": "base",
  "eip155:84532": "base-sepolia",
}

/** Structural fetch type: matches the AI SDK's FetchFunction without Bun's `preconnect` extras. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export type X402FetchOptions = {
  account: PrivateKeyAccount
  budget: Budget
  ledger: Ledger
  /** Recorded in the ledger, e.g. "surplusintelligence". */
  providerId: string
  /** Base RPC endpoint used for Permit2 allowance reads and upto signing. */
  rpcUrl?: string
  /** Prefer usage-based `upto` when a Permit2 allowance exists. Default true. */
  preferUpto?: boolean
  /** Remove the Authorization header before sending (the wallet pays; a dummy bearer could trigger 401 instead of 402). */
  dropAuthorization?: boolean
  /**
   * Header envelope dialect. "legacy" = `{x402Version, scheme, network: "base", payload}` — what production
   * facilitator stacks (incl. Surplus Intelligence) verify today; the spec-pure "v2" envelope (accepted echo)
   * is rejected there with invalid_payload. Default "legacy".
   */
  wireFormat?: "legacy" | "v2"
  log?: (level: "info" | "warn" | "error", message: string) => void
}

/**
 * Wraps fetch with the x402 v2 payment loop:
 * 402 -> decode PAYMENT-REQUIRED -> budget check -> sign accept (upto/exact) -> retry with PAYMENT-SIGNATURE.
 *
 * Provider-agnostic: works against any x402 v2 resource server on an eip155 network.
 * Amounts are interpreted as 6-decimal stablecoin units (USDC) for budgeting.
 */
export function createX402Fetch(options: X402FetchOptions): FetchLike {
  const log = options.log ?? (() => {})
  const preferUpto = options.preferUpto ?? true
  const publicClient = createPublicClient({
    chain: base,
    transport: http(options.rpcUrl ?? DEFAULT_BASE_RPC),
  })
  const signer = toClientEvmSigner(options.account, publicClient)

  // Permit2 allowance cache per asset: once sufficient, it stays sufficient until revoked.
  const allowanceOk = new Map<string, { ok: boolean; checkedAt: number }>()
  const ALLOWANCE_TTL_MS = 5 * 60 * 1000

  async function hasPermit2Allowance(accept: PaymentRequirements): Promise<boolean> {
    const asset = accept.asset as `0x${string}`
    const cached = allowanceOk.get(asset)
    if (cached && (cached.ok || Date.now() - cached.checkedAt < ALLOWANCE_TTL_MS)) return cached.ok
    try {
      const allowance = (await publicClient.readContract({
        address: asset,
        abi: erc20AllowanceAbi,
        functionName: "allowance",
        args: [options.account.address, PERMIT2_ADDRESS],
      })) as bigint
      const ok = allowance >= BigInt(accept.amount)
      allowanceOk.set(asset, { ok, checkedAt: Date.now() })
      return ok
    } catch (error) {
      log("warn", `x402: Permit2 allowance check failed, falling back to exact: ${String(error)}`)
      return false
    }
  }

  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    // Normalize once so the request can be replayed with a payment header.
    const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init)
    const bodyBytes =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : new Uint8Array(await request.clone().arrayBuffer())

    const send = (extraHeaders?: Record<string, string>) => {
      const headers = new Headers(request.headers)
      if (options.dropAuthorization) headers.delete("authorization")
      if (extraHeaders) for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v)
      return fetch(request.url, {
        method: request.method,
        headers,
        body: bodyBytes,
        redirect: request.redirect,
        signal: request.signal,
      })
    }

    const first = await send()
    if (first.status !== 402) return first

    const challengeHeader = first.headers.get("payment-required") ?? first.headers.get("x-payment-required")
    if (!challengeHeader) return first

    let challenge: PaymentRequired
    try {
      challenge = decodePaymentRequiredHeader(challengeHeader)
    } catch (error) {
      log("error", `x402: unparseable PAYMENT-REQUIRED header: ${String(error)}`)
      return first
    }

    const accept = await selectAccept(challenge, preferUpto, hasPermit2Allowance)
    if (!accept) {
      throw new Error(
        `x402: no supported payment option. Server offered: ` +
          `${challenge.accepts.map((a) => `${a.scheme}@${a.network}`).join(", ") || "none"}. ` +
          `This plugin supports exact/upto on eip155 networks.`,
      )
    }

    const amountUsd = Number(accept.amount) / 1e6
    checkBudget(options.budget, options.ledger, amountUsd)

    const scheme = accept.scheme === "upto" ? new UptoEvmScheme(signer) : new ExactEvmScheme(signer)
    const result = await scheme.createPaymentPayload(challenge.x402Version, accept, {
      extensions: challenge.extensions,
    })

    let signatureHeader: string
    if ((options.wireFormat ?? "legacy") === "legacy") {
      const legacyEnvelope = {
        x402Version: result.x402Version,
        scheme: accept.scheme,
        network: V1_NETWORK_BY_CAIP[accept.network] ?? accept.network,
        payload: result.payload,
      }
      signatureHeader = Buffer.from(JSON.stringify(legacyEnvelope)).toString("base64")
    } else {
      const payload: PaymentPayload = {
        x402Version: result.x402Version,
        resource: challenge.resource,
        accepted: accept,
        payload: result.payload,
        ...(result.extensions ? { extensions: result.extensions } : {}),
      }
      signatureHeader = encodePaymentSignatureHeader(payload)
    }

    log("info", `x402: paying up to $${amountUsd.toFixed(6)} via ${accept.scheme} for ${request.url}`)
    const paid = await send({ "PAYMENT-SIGNATURE": signatureHeader })

    if (paid.status === 402) {
      const reason = await extractServerReason(paid)
      throw new Error(
        `x402: payment was rejected by ${new URL(request.url).host}${reason ? `: ${reason}` : ""}. ` +
          `Wallet ${options.account.address} likely lacks USDC on Base (needed up to $${amountUsd.toFixed(6)}). ` +
          `Send USDC (Base, chain 8453) to that address and retry.`,
      )
    }

    if (paid.ok) {
      let txHash: string | undefined
      let payer: string | undefined
      const settleHeader = paid.headers.get("payment-response") ?? paid.headers.get("x-payment-response")
      if (settleHeader) {
        try {
          const settle = decodePaymentResponseHeader(settleHeader)
          txHash = settle.transaction
          payer = settle.payer
        } catch {
          // Legacy facilitators emit a v1-shaped settle header the strict v2 codec rejects.
          try {
            const raw = JSON.parse(Buffer.from(settleHeader, "base64").toString()) as {
              transaction?: unknown
              txHash?: unknown
              payer?: unknown
            }
            if (typeof raw.transaction === "string") txHash = raw.transaction
            else if (typeof raw.txHash === "string") txHash = raw.txHash
            if (typeof raw.payer === "string") payer = raw.payer
          } catch {
            // settlement metadata is informational only
          }
        }
      }
      options.ledger.append({
        ts: new Date().toISOString(),
        provider: options.providerId,
        model: modelFromBody(bodyBytes),
        scheme: accept.scheme,
        network: accept.network,
        maxUsd: amountUsd,
        txHash,
        payer,
      })
    }

    return paid
  }
}

async function selectAccept(
  challenge: PaymentRequired,
  preferUpto: boolean,
  hasPermit2Allowance: (accept: PaymentRequirements) => Promise<boolean>,
): Promise<PaymentRequirements | undefined> {
  const evm = challenge.accepts.filter((a) => a.network.startsWith("eip155:"))
  const upto = evm.find((a) => a.scheme === "upto")
  const exact = evm.find((a) => a.scheme === "exact")
  if (preferUpto && upto && (await hasPermit2Allowance(upto))) return upto
  return exact ?? upto
}

async function extractServerReason(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { error?: { message?: string } | string }
    if (typeof body.error === "string") return body.error
    return body.error?.message
  } catch {
    return undefined
  }
}

function modelFromBody(bodyBytes: Uint8Array | undefined): string | undefined {
  if (!bodyBytes) return undefined
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bodyBytes)) as { model?: string }
    return typeof parsed.model === "string" ? parsed.model : undefined
  } catch {
    return undefined
  }
}
