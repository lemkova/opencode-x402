/** Dev check: seed encrypt/decrypt round-trip in an isolated XDG_DATA_HOME. */
import { mkdtempSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  decryptSeed,
  hotKeyFromMnemonic,
  isValidMnemonic,
  loadSeedFile,
  newMnemonic,
  saveSeedEncrypted,
} from "../src/seed.ts"

// dataDir() reads XDG_DATA_HOME lazily, so setting it before any seed call isolates the test.
process.env["XDG_DATA_HOME"] = mkdtempSync(join(tmpdir(), "x402-seed-"))

let failures = 0
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}

const m12 = newMnemonic(12)
const m24 = newMnemonic(24)
check("12-word gen", m12.split(" ").length === 12 && isValidMnemonic(m12))
check("24-word gen", m24.split(" ").length === 24 && isValidMnemonic(m24))
check("invalid mnemonic rejected", !isValidMnemonic("foo bar baz"))

const saved = saveSeedEncrypted(m12, "hunter2 correct horse")
const loaded = loadSeedFile()
check("file round-trip", loaded !== undefined && loaded.protected && loaded.words === 12)
check("decrypt with right passphrase", loaded !== undefined && decryptSeed(loaded, "hunter2 correct horse") === m12)
try {
  if (loaded) decryptSeed(loaded, "wrong")
  check("wrong passphrase rejected", false)
} catch (error) {
  check("wrong passphrase rejected", String(error).includes("wrong passphrase"))
}

const hot = hotKeyFromMnemonic(m12)
check("hot key derives seed address", hot.address === saved.address && /^0x[0-9a-fA-F]{64}$/.test(hot.privateKey))

const mode = statSync(join(process.env["XDG_DATA_HOME"], "opencode", "x402", "seed.enc.json")).mode
check("file perms 0600", (mode & 0o777) === 0o600, `mode=${(mode & 0o777).toString(8)}`)

// Unprotected (empty passphrase) still decrypts and is flagged.
saveSeedEncrypted(m24, "")
const unprot = loadSeedFile()
check("empty passphrase flagged", unprot !== undefined && !unprot.protected && decryptSeed(unprot, "") === m24)

process.exit(failures === 0 ? 0 : 1)
