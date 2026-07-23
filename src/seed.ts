import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { generateMnemonic, validateMnemonic } from "@scure/bip39"
import { wordlist } from "@scure/bip39/wordlists/english.js"
import { mnemonicToAccount } from "viem/accounts"
import { toHex } from "viem"
import { dataDir, type Hex } from "./wallet.ts"

/**
 * Encrypted seed backup: BIP-39 mnemonic under scrypt (N=2^15, r=8, p=1) + AES-256-GCM.
 * An empty passphrase still produces the same file format but is flagged `protected: false`.
 * The hot signing key (derived at m/44'/60'/0'/0/0) lives in opencode's auth store, NOT here —
 * this file is the recovery backup.
 */
export type SeedFile = {
  version: 1
  kdf: "scrypt"
  N: number
  r: number
  p: number
  salt: string
  iv: string
  tag: string
  ciphertext: string
  protected: boolean
  address: Hex
  words: number
  createdAt: string
}

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 } as const

export function seedFilePath(): string {
  return join(dataDir(), "seed.enc.json")
}

export function newMnemonic(words: 12 | 24): string {
  return generateMnemonic(wordlist, words === 24 ? 256 : 128)
}

export function isValidMnemonic(mnemonic: string): boolean {
  return validateMnemonic(mnemonic.trim().toLowerCase().replace(/\s+/g, " "), wordlist)
}

/** Derived private key for day-to-day signing (default Ethereum path, account 0). */
export function hotKeyFromMnemonic(mnemonic: string): { privateKey: Hex; address: Hex } {
  const account = mnemonicToAccount(mnemonic.trim().toLowerCase().replace(/\s+/g, " "))
  const privateKeyBytes = account.getHdKey().privateKey
  if (!privateKeyBytes) throw new Error("BIP-32 derivation produced no private key")
  return { privateKey: toHex(privateKeyBytes) as Hex, address: account.address }
}

export function saveSeedEncrypted(mnemonic: string, passphrase: string): SeedFile {
  const normalized = mnemonic.trim().toLowerCase().replace(/\s+/g, " ")
  if (!validateMnemonic(normalized, wordlist)) throw new Error("invalid BIP-39 mnemonic")
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = scryptSync(passphrase, salt, 32, SCRYPT)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const ciphertext = Buffer.concat([cipher.update(normalized, "utf8"), cipher.final()])
  const file: SeedFile = {
    version: 1,
    kdf: "scrypt",
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    ciphertext: ciphertext.toString("hex"),
    protected: passphrase.length > 0,
    address: mnemonicToAccount(normalized).address,
    words: normalized.split(" ").length,
    createdAt: new Date().toISOString(),
  }
  mkdirSync(dataDir(), { recursive: true })
  const path = seedFilePath()
  // Never destroy a previous backup: a re-created wallet may still hold funds recoverable only via the old seed.
  if (existsSync(path)) renameSync(path, `${path}.bak-${Date.now()}`)
  writeFileSync(path, JSON.stringify(file, null, 2), { mode: 0o600 })
  chmodSync(path, 0o600)
  return file
}

export function loadSeedFile(): SeedFile | undefined {
  const path = seedFilePath()
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SeedFile
    return parsed.version === 1 && parsed.kdf === "scrypt" ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Throws on wrong passphrase or tampered file (GCM auth failure). */
export function decryptSeed(file: SeedFile, passphrase: string): string {
  const key = scryptSync(passphrase, Buffer.from(file.salt, "hex"), 32, {
    N: file.N,
    r: file.r,
    p: file.p,
    maxmem: 128 * 1024 * 1024,
  })
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(file.iv, "hex"))
  decipher.setAuthTag(Buffer.from(file.tag, "hex"))
  try {
    return Buffer.concat([decipher.update(Buffer.from(file.ciphertext, "hex")), decipher.final()]).toString("utf8")
  } catch {
    throw new Error("wrong passphrase (or corrupted seed file)")
  }
}
