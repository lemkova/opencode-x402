import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

export type Hex = `0x${string}`

/** Data dir for non-secret plugin state (address, ledger). The private key lives only in opencode's auth store. */
export function dataDir(): string {
  const base = process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share")
  return join(base, "opencode", "x402")
}

export function normalizePrivateKey(input: unknown): Hex | undefined {
  if (typeof input !== "string") return undefined
  const trimmed = input.trim()
  const hex = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`
  return /^0x[0-9a-fA-F]{64}$/.test(hex) ? (hex as Hex) : undefined
}

export function createWallet(): { privateKey: Hex; address: Hex } {
  const privateKey = generatePrivateKey()
  return { privateKey, address: privateKeyToAccount(privateKey).address }
}


/** Persist the public address (never the key) so wallet tools work without touching the auth store. */
export function rememberAddress(address: string): void {
  const dir = dataDir()
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "wallet.json"), JSON.stringify({ address, updatedAt: new Date().toISOString() }, null, 2))
}

export function rememberedAddress(): Hex | undefined {
  const file = join(dataDir(), "wallet.json")
  if (!existsSync(file)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { address?: string }
    return typeof parsed.address === "string" && /^0x[0-9a-fA-F]{40}$/.test(parsed.address)
      ? (parsed.address as Hex)
      : undefined
  } catch {
    return undefined
  }
}
