#!/usr/bin/env bun
/**
 * opencode-x402 CLI — the out-of-band channel for wallet secrets.
 * Seed phrases and passphrases must never travel through the opencode chat
 * (chat context is sent to model providers and persisted in transcripts).
 *
 *   opencode-x402 reveal      decrypt and print the seed phrase (asks passphrase)
 *   opencode-x402 passphrase  change/set the backup passphrase
 *   opencode-x402 address     print the wallet address
 */
import { decryptSeed, loadSeedFile, saveSeedEncrypted, seedFilePath } from "./seed.ts"

function promptHidden(label: string): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>()
  process.stdout.write(label)
  const stdin = process.stdin
  if (!stdin.isTTY) {
    reject(new Error("stdin is not a TTY; run from an interactive terminal"))
    return promise
  }
  stdin.setRawMode(true)
  stdin.resume()
  let value = ""
  const cleanup = () => {
    stdin.setRawMode(false)
    stdin.pause()
    stdin.off("data", onData)
  }
  const onData = (chunk: Buffer) => {
    for (const byte of chunk) {
      if (byte === 0x03) {
        // Ctrl-C
        cleanup()
        process.stdout.write("\n")
        process.exit(130)
      } else if (byte === 0x0d || byte === 0x0a) {
        cleanup()
        process.stdout.write("\n")
        resolve(value)
        return
      } else if (byte === 0x7f || byte === 0x08) {
        value = value.slice(0, -1)
      } else if (byte >= 0x20) {
        value += String.fromCharCode(byte)
      }
    }
  }
  stdin.on("data", onData)
  return promise
}

const command = process.argv[2] ?? "help"
const file = loadSeedFile()

try {
  switch (command) {
    case "reveal": {
      if (!file) {
        console.error(`No seed backup at ${seedFilePath()}. Create a wallet first (opencode auth login).`)
        process.exit(1)
      }
      const passphrase = file.protected ? await promptHidden("Backup passphrase: ") : ""
      const mnemonic = decryptSeed(file, passphrase)
      console.log(`\nSeed phrase (${file.words} words, address ${file.address}):\n`)
      console.log(`  ${mnemonic}\n`)
      console.log("Write it down offline, then clear this terminal (e.g. `clear && history -c`).")
      break
    }
    case "passphrase": {
      if (!file) {
        console.error(`No seed backup at ${seedFilePath()}. Create a wallet first (opencode auth login).`)
        process.exit(1)
      }
      const oldPass = file.protected ? await promptHidden("Current passphrase: ") : ""
      const mnemonic = decryptSeed(file, oldPass)
      const next = await promptHidden("New passphrase (empty = unprotected): ")
      const confirm = await promptHidden("Repeat new passphrase: ")
      if (next !== confirm) {
        console.error("Passphrases do not match; nothing changed.")
        process.exit(1)
      }
      saveSeedEncrypted(mnemonic, next)
      console.log(next.length > 0 ? "Backup re-encrypted with the new passphrase." : "Warning: backup is now unprotected (empty passphrase).")
      break
    }
    case "address": {
      if (!file) {
        console.error("No seed backup found.")
        process.exit(1)
      }
      console.log(file.address)
      break
    }
    default:
      console.log("Usage: opencode-x402 <reveal|passphrase|address>")
      process.exit(command === "help" ? 0 : 1)
  }
} catch (error) {
  // Clean single-line errors (wrong passphrase, non-TTY stdin) - never a stack trace.
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
