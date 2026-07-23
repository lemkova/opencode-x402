import { tool, type Plugin } from "@opencode-ai/plugin"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createPublicClient, createWalletClient, erc20Abi, formatEther, formatUnits, http } from "viem"
import { base } from "viem/chains"
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts"
import { PERMIT2_ADDRESS, createPermit2ApprovalTx } from "@x402/evm"
import { dataDir, normalizePrivateKey, rememberAddress, rememberedAddress } from "./wallet.ts"
import { hotKeyFromMnemonic, isValidMnemonic, loadSeedFile, newMnemonic, saveSeedEncrypted, seedFilePath } from "./seed.ts"
import { Ledger, type Budget } from "./ledger.ts"
import { createX402Fetch, DEFAULT_BASE_RPC, type FetchLike } from "./x402.ts"
import { BASE_USDC, SI } from "./si.ts"
import { applyRouting, formatMarket, type RoutingConfig } from "./routing.ts"
import type { X402ProviderPreset } from "./preset.ts"

export type { X402ProviderPreset } from "./preset.ts"
export { SI } from "./si.ts"
export { createX402Fetch, type X402FetchOptions, type FetchLike } from "./x402.ts"

/** Options file for shim-loaded installs (plugin-array options are unavailable there). */
export function optionsFilePath(): string {
  const base = process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config")
  return join(base, "opencode", "x402.json")
}

function loadFileOptions(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(optionsFilePath(), "utf8"))
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** Process-wide: the first plugin instance registers the shared /wallet UI (tools + command). */
let walletUiClaimed = false

function toList(value: unknown): string[] | undefined {
  if (typeof value === "string" && value.trim().length > 0) return [value.trim()]
  if (Array.isArray(value)) {
    const list = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim())
    return list.length > 0 ? list : undefined
  }
  return undefined
}

/**
 * Build an opencode plugin for one x402-paid provider.
 *
 * The wallet (seed backup, hot key location, spend ledger, budget caps) is shared
 * across every instance — one wallet pays all x402 providers. Marketplace features
 * activate only when the preset declares `marketplace`.
 *
 * Options resolution (wallet-level keys are top-level; marketplace keys live under
 * the provider id):
 *
 * ```jsonc
 * // opencode.json plugin-array options or ~/.config/opencode/x402.json
 * {
 *   "maxPerRequestUsd": 0.5,
 *   "maxPerDayUsd": 10,
 *   "rpcUrl": "https://mainnet.base.org",
 *   "preferUpto": true,
 *   "surplusintelligence": {          // <- preset.id, marketplace providers only
 *     "minDiscount": 90,
 *     "sellers": ["zai"],
 *     "modelSellers": { "glm-5.2": ["zai"] },
 *     "maxPricePer1M": 8
 *   }
 * }
 * ```
 */
export function makeX402Plugin(preset: X402ProviderPreset): Plugin {
  return async ({ client }, rawPluginOptions) => {
    // Precedence: opencode.json plugin-array options > ~/.config/opencode/x402.json > defaults.
    const options: Record<string, unknown> = { ...loadFileOptions(), ...rawPluginOptions }

    // Wallet-level options (generic across all x402 providers).
    const maxPerRequestUsd = typeof options["maxPerRequestUsd"] === "number" ? options["maxPerRequestUsd"] : 0.5
    const maxPerDayUsd = typeof options["maxPerDayUsd"] === "number" ? options["maxPerDayUsd"] : 10
    const rpcUrl = typeof options["rpcUrl"] === "string" ? options["rpcUrl"] : DEFAULT_BASE_RPC
    const preferUpto = options["preferUpto"] !== false

    // Provider-scoped options (marketplace features; only meaningful when the preset supports them).
    const scopedRaw = options[preset.id]
    const scoped: Record<string, unknown> =
      typeof scopedRaw === "object" && scopedRaw !== null && !Array.isArray(scopedRaw)
        ? (scopedRaw as Record<string, unknown>)
        : {}

    const marketplace = preset.marketplace
    const rawMinDiscount = scoped["minDiscount"]
    const minDiscount = !marketplace
      ? 0
      : typeof rawMinDiscount === "number" &&
          Number.isInteger(rawMinDiscount) &&
          rawMinDiscount >= 0 &&
          rawMinDiscount <= 100
        ? rawMinDiscount
        : (marketplace.defaultMinDiscount ?? 0)
    const baseURL =
      marketplace && minDiscount > 0 ? `${marketplace.apiOrigin}/min${minDiscount}/v1` : preset.baseURL

    const modelSellers: Record<string, string[]> = {}
    const rawModelSellers = scoped["modelSellers"]
    if (typeof rawModelSellers === "object" && rawModelSellers !== null) {
      for (const [model, value] of Object.entries(rawModelSellers)) {
        const list = toList(value)
        if (list) modelSellers[model] = list
      }
    }
    const routing: RoutingConfig = marketplace
      ? {
          providers: toList(scoped["sellers"]),
          modelProviders: modelSellers,
          maxPricePer1M: typeof scoped["maxPricePer1M"] === "number" ? scoped["maxPricePer1M"] : undefined,
        }
      : {}

    const budget: Budget = { maxPerRequestUsd, maxPerDayUsd }
    const ledger = new Ledger(dataDir())
    const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) })
    // First instance claims the shared /wallet UI; later instances skip so tool
    // names never collide even when a custom preset forgets registerTools: false.
    const registerTools = (preset.registerTools ?? true) && !walletUiClaimed
    if (registerTools) walletUiClaimed = true

    const setupGuide = [
      "No x402 wallet configured yet. To create one (takes ~1 minute):",
      "",
      "  1. In a terminal, run: opencode auth login",
      `  2. Pick "${preset.name}", then "Create new wallet - generates a seed phrase"`,
      "  3. Choose 12 or 24 words and set a passphrase (encrypts the on-disk backup)",
      "  4. Your seed phrase is shown ONCE in that dialog - write it down offline",
      "  5. Send USDC on Base (chain 8453) to the shown address",
      "",
      "Then run /wallet again to see the address and balance.",
      "Security: seed phrases and passphrases are never handled in chat - only in the auth dialog or the `opencode-x402` CLI.",
    ].join("\n")

    /** Set once the auth loader runs. Needed by the approve-upto action (signs a transaction). */
    let account: PrivateKeyAccount | undefined

    const log = (level: "info" | "warn" | "error", message: string) =>
      client.app
        .log({ body: { service: "opencode-x402", level, message } })
        .catch(() => {})

    async function walletStatus(): Promise<string> {
      const seed = loadSeedFile()
      const address = account?.address ?? rememberedAddress() ?? seed?.address
      if (!address) return setupGuide
      let usdc: bigint | undefined
      let eth: bigint | undefined
      let allowance: bigint | undefined
      let rpcError: string | undefined
      try {
        ;[usdc, eth, allowance] = await Promise.all([
          publicClient.readContract({ address: BASE_USDC, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
          publicClient.getBalance({ address }),
          publicClient.readContract({
            address: BASE_USDC,
            abi: erc20Abi,
            functionName: "allowance",
            args: [address, PERMIT2_ADDRESS],
          }),
        ])
      } catch (error) {
        rpcError = error instanceof Error ? error.message : String(error)
      }
      const recent = ledger
        .tail(5)
        .map((e) => `  ${e.ts}  ${e.model ?? "?"}  ${e.scheme}  <= $${e.maxUsd.toFixed(6)}${e.txHash ? `  tx=${e.txHash}` : ""}`)
        .join("\n")
      const backup = seed
        ? seed.protected
          ? `encrypted seed backup (${seed.words} words, passphrase-protected): ${seedFilePath()}`
          : `encrypted seed backup (${seed.words} words, NO passphrase - set one: opencode-x402 passphrase): ${seedFilePath()}`
        : "none (wallet was imported as a raw private key - no seed backup exists)"
      return [
        `Address: ${address}  (Base mainnet)`,
        rpcError
          ? `On-chain lookups unavailable (RPC ${rpcUrl}): ${rpcError.slice(0, 160)}`
          : [
              `USDC: ${formatUnits(usdc!, 6)}`,
              `ETH (gas; only needed once for the optional upto approval): ${formatEther(eth!)}`,
              `Scheme: ${allowance! > 0n ? "upto ready - settles actual usage" : "exact (pre-charges estimate) - upgrade via /wallet approve-upto"}`,
            ].join("\n"),
        marketplace
          ? `Routing (${preset.id}): min${minDiscount} (only sellers priced >=${minDiscount}% below direct provider rates; 0 disables)`
          : `Provider: ${preset.name} (plain x402 - no marketplace routing)`,
        `Spend today (authorized max): $${ledger.todayTotalUsd().toFixed(6)} of $${budget.maxPerDayUsd.toFixed(2)} daily cap (per-request $${budget.maxPerRequestUsd.toFixed(2)})`,
        `Backup: ${backup}`,
        recent ? `Recent payments:\n${recent}` : "No payments recorded yet.",
      ].join("\n")
    }

    return {
      config: async (config) => {
        const providers = (config.provider ??= {})
        const existing = providers[preset.id] ?? {}
        providers[preset.id] = {
          npm: preset.npm ?? "@ai-sdk/openai-compatible",
          name: preset.name,
          ...existing,
          options: { baseURL, ...existing.options },
          models: { ...preset.models, ...existing.models },
        }
        if (registerTools) {
          const commands = (config.command ??= {})
          commands["wallet"] ??= {
            description: "x402 wallet: balance, funding, config",
            template: [
              'Handle this x402 wallet request. Route based on the argument "$ARGUMENTS":',
              '- empty or "status": call the x402_wallet tool with action "status"',
              '- "config": action "config"',
              '- "fund": action "fund"',
              '- "approve" or "approve-upto": action "approve-upto"',
              '- "market <model>": action "market" with the model id (shows live seller order book)',
              "- anything else: action \"status\", then answer the user's question from the output.",
              "Relay the tool output faithfully (keep addresses and commands verbatim, in code spans).",
              "SECURITY: never ask for, accept, or repeat seed phrases, private keys, or passphrases in chat.",
              "If the user tries to paste one, tell them to stop and use `opencode auth login` or the `opencode-x402` CLI instead.",
            ].join("\n"),
          }
        }
      },

      auth: {
        provider: preset.id,
        loader: async (getAuth) => {
          const auth = await getAuth()
          const privateKey = auth && "key" in auth ? normalizePrivateKey(auth.key) : undefined
          if (!privateKey) return {}
          try {
            account = privateKeyToAccount(privateKey)
          } catch (error) {
            log("error", `stored private key is invalid (not on curve): ${String(error)}`)
            return {}
          }
          rememberAddress(account.address)
          const payFetch = createX402Fetch({
            account,
            budget,
            ledger,
            providerId: preset.id,
            rpcUrl,
            preferUpto,
            dropAuthorization: true,
            wireFormat: preset.wireFormat,
            log,
          })
          // Rewrite bodies for seller routing (marketplace only), then surface routing failures as actionable errors.
          const routedFetch: FetchLike = async (input, init) => {
            if (
              marketplace &&
              init?.body !== undefined &&
              (typeof init.body === "string" || init.body instanceof Uint8Array)
            ) {
              const bytes = typeof init.body === "string" ? new TextEncoder().encode(init.body) : init.body
              const rewritten = applyRouting(bytes, routing)
              if (rewritten !== bytes) init = { ...init, body: rewritten }
            }
            const response = await payFetch(input, init)
            if (marketplace && (response.status === 503 || response.status === 400 || response.status === 404)) {
              const body = await response.clone().text().catch(() => "")
              // Observed live as 404 (docs say 503) - match the code, not the status.
              if (minDiscount > 0 && body.includes("minimum_discount_not_met")) {
                const detail = /Best otherwise-eligible[^"]*/.exec(body)?.[0]
                throw new Error(
                  `${preset.name} found no seller meeting the min${minDiscount}% estimated discount for this model (minimum_discount_not_met). ` +
                    `${detail ? detail + ". " : ""}` +
                    `Note: the estimate includes the per-request x402 fee (tiny requests skew low), and seller pinning narrows the offer set before this filter. ` +
                    `Unpin, lower "minDiscount" under "${preset.id}" in ${optionsFilePath()}, or run /wallet market <model>.`,
                )
              }
              if (body.includes("unsupported_provider"))
                throw new Error(
                  `${preset.name} rejected the pinned seller(s) (400 unsupported_provider). ` +
                    `Check the "@seller" model suffix / "sellers" option against the supported list in the error body: ${body.slice(0, 300)}`,
                )
              if (body.includes("no_sellers_for_model"))
                throw new Error(
                  `${preset.name} has no active offer from the pinned seller(s) for this model (404 no_sellers_for_model). ` +
                    `Unpin (remove "@seller" / "sellers") to let the router use any seller, or run /wallet market <model> to see the live order book.`,
                )
            }
            return response
          }
          return { apiKey: "x402-wallet", fetch: routedFetch }
        },
        methods: [
          {
            type: "oauth",
            label: "Create new wallet - generates a seed phrase",
            prompts: [
              {
                type: "select",
                key: "words",
                message: "Seed phrase length",
                options: [
                  { label: "12 words", value: "12", hint: "standard" },
                  { label: "24 words", value: "24", hint: "maximum entropy" },
                ],
              },
              {
                type: "text",
                key: "passphrase",
                message: "Passphrase to encrypt the on-disk seed backup (recommended; empty = unprotected)",
              },
            ],
            authorize: async (inputs) => {
              const words = inputs?.["words"] === "24" ? 24 : 12
              const passphrase = inputs?.["passphrase"] ?? ""
              const mnemonic = newMnemonic(words)
              const file = saveSeedEncrypted(mnemonic, passphrase)
              const hot = hotKeyFromMnemonic(mnemonic)
              rememberAddress(hot.address)
              return {
                url: `https://basescan.org/address/${hot.address}`,
                instructions:
                  `Write down your ${words}-word seed phrase NOW - it is shown only this once:\n\n` +
                  `  ${mnemonic}\n\n` +
                  `Address (fund with USDC on Base, chain 8453): ${hot.address}\n` +
                  `Encrypted backup: ${seedFilePath()} (${file.protected ? "passphrase-protected" : "NOT passphrase-protected"})\n` +
                  `Recover the phrase later with: opencode-x402 reveal\n` +
                  `This is a hot wallet - keep only small amounts on it.`,
                method: "auto" as const,
                callback: async () => ({ type: "success" as const, key: hot.privateKey }),
              }
            },
          },
          {
            type: "api",
            label: "Import seed phrase (12/24 words)",
            prompts: [
              {
                type: "text",
                key: "mnemonic",
                message: "Seed phrase (words separated by spaces)",
                validate: (value: string) => (isValidMnemonic(value) ? undefined : "Not a valid BIP-39 mnemonic"),
              },
              {
                type: "text",
                key: "passphrase",
                message: "Passphrase to encrypt the on-disk seed backup (empty = unprotected)",
              },
            ],
            authorize: async (inputs) => {
              const mnemonic = inputs?.["mnemonic"] ?? ""
              if (!isValidMnemonic(mnemonic)) return { type: "failed" as const }
              saveSeedEncrypted(mnemonic, inputs?.["passphrase"] ?? "")
              const hot = hotKeyFromMnemonic(mnemonic)
              rememberAddress(hot.address)
              return { type: "success" as const, key: hot.privateKey }
            },
          },
          {
            type: "api",
            label: "Import raw private key (no seed backup)",
            prompts: [
              {
                type: "text",
                key: "privateKey",
                message: "EVM private key (0x + 64 hex chars) of a Base wallet holding USDC",
                validate: (value: string) =>
                  normalizePrivateKey(value) ? undefined : "Expected 64 hex chars, optionally 0x-prefixed",
              },
            ],
            authorize: async (inputs) => {
              const privateKey = normalizePrivateKey(inputs?.["privateKey"])
              if (!privateKey) return { type: "failed" as const }
              try {
                rememberAddress(privateKeyToAccount(privateKey).address)
              } catch {
                // hex-valid but not a usable secp256k1 key (e.g. zero, >= curve order)
                return { type: "failed" as const }
              }
              return { type: "success" as const, key: privateKey }
            },
          },
        ],
      },

      ...(registerTools
        ? {
            tool: {
              x402_wallet: tool({
                description:
                  "x402 payment wallet operations. Actions: 'status' (address, balances, spend - the default), " +
                  "'fund' (funding instructions), 'config' (management options), " +
                  "'market' (live seller order book for a model - pass the model arg), " +
                  "'approve-upto' (one-time on-chain Permit2 approval enabling usage-based settlement; sends a transaction, needs a little Base ETH). " +
                  "Never handles seed phrases or passphrases.",
                args: {
                  action: tool.schema.enum(["status", "fund", "config", "approve-upto", "market"]).optional(),
                  model: tool.schema.string().optional().describe("Model id for the 'market' action, e.g. glm-5.2"),
                },
                async execute(args) {
                  const action = args.action ?? "status"
                  if (action === "status") return walletStatus()
                  if (action === "market") {
                    if (!marketplace) return `${preset.name} is a plain x402 provider - there is no marketplace order book.`
                    return args.model
                      ? formatMarket(marketplace.apiOrigin, args.model)
                      : "Which model? Usage: /wallet market <model-id> (e.g. /wallet market glm-5.2)."
                  }

                  const address = account?.address ?? rememberedAddress() ?? loadSeedFile()?.address
                  if (!address) return setupGuide

                  if (action === "fund")
                    return [
                      `Send USDC on Base (chain 8453) to: ${address}`,
                      `Explorer: https://basescan.org/address/${address}`,
                      `USDC contract: ${BASE_USDC}. Inference costs fractions of a cent plus a small x402 fee per request.`,
                      `Optional: ~$0.50 of Base ETH enables the usage-based 'upto' scheme (one-time approval).`,
                      `Hot wallet - keep only what you are willing to spend.`,
                    ].join("\n")

                  if (action === "config") {
                    const seed = loadSeedFile()
                    return [
                      "Wallet management (secrets never pass through chat):",
                      `- Reveal seed phrase:      opencode-x402 reveal        (terminal; asks passphrase)`,
                      `- Change/set passphrase:   opencode-x402 passphrase    (terminal)`,
                      `- Regenerate wallet:       opencode auth login -> "${preset.name}" -> Create new wallet (previous backup is kept as ${seedFilePath()}.bak-*)`,
                      `- Import seed/private key: opencode auth login -> "${preset.name}" -> Import`,
                      `- Upgrade to usage-based settlement: /wallet approve-upto`,
                      `- Options file: ${optionsFilePath()} - wallet-level { "maxPerRequestUsd": ${budget.maxPerRequestUsd}, "maxPerDayUsd": ${budget.maxPerDayUsd} }` +
                        (marketplace
                          ? `; marketplace (under "${preset.id}") { "minDiscount": ${minDiscount}, "sellers": [...], "modelSellers": { "<model>": [...] }, "maxPricePer1M": <usd> }`
                          : ""),
                      ...(marketplace ? [`- Pin sellers per request: model id suffix "<model>@<seller>" (see /wallet market <model>)`] : []),
                      `- Ledger: ${dataDir()}/ledger.jsonl`,
                      `- Backup state: ${seed ? (seed.protected ? "passphrase-protected" : "UNPROTECTED (empty passphrase)") : "no seed backup (raw key import)"}`,
                    ].join("\n")
                  }

                  // approve-upto
                  if (!account)
                    return `Wallet key not loaded in this session yet. Send one message using a ${preset.id} model first (or re-run \`opencode auth login\`), then retry.`
                  const [eth, current] = await Promise.all([
                    publicClient.getBalance({ address: account.address }),
                    publicClient.readContract({
                      address: BASE_USDC,
                      abi: erc20Abi,
                      functionName: "allowance",
                      args: [account.address, PERMIT2_ADDRESS],
                    }),
                  ])
                  if (current > 0n) return "Permit2 allowance is already set - 'upto' is active. Nothing to do."
                  if (eth === 0n) return `No Base ETH for gas on ${account.address}. Send ~$0.50 of ETH on Base, then retry.`
                  const tx = createPermit2ApprovalTx(BASE_USDC)
                  const walletClient = createWalletClient({ account, chain: base, transport: http(rpcUrl) })
                  const hash = await walletClient.sendTransaction({ to: tx.to, data: tx.data })
                  const receipt = await publicClient.waitForTransactionReceipt({ hash })
                  return receipt.status === "success"
                    ? `Approved. Permit2 allowance set (tx ${hash}). Future payments use 'upto' and settle only actual usage.`
                    : `Approval transaction reverted (tx ${hash}). Check the wallet on basescan and retry.`
                },
              }),
            },
          }
        : {}),
    }
  }
}

/** The bundled default: Surplus Intelligence marketplace preset. */
export const X402WalletPlugin: Plugin = (input, options) => makeX402Plugin(SI)(input, options)
