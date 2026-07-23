import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

export type Budget = {
  /** Max authorized amount per single request, USD. */
  maxPerRequestUsd: number
  /** Max total authorized per UTC day, USD. */
  maxPerDayUsd: number
}

export type LedgerEntry = {
  ts: string
  provider: string
  model?: string
  scheme: string
  network: string
  /** Authorized max in USD (upto settles <= this; exact settles exactly this). */
  maxUsd: number
  txHash?: string
  payer?: string
}

/** Append-only JSONL spend ledger. Amounts are authorization maxima, i.e. a conservative upper bound on spend. */
export class Ledger {
  private readonly file: string

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true })
    this.file = join(dir, "ledger.jsonl")
  }

  append(entry: LedgerEntry): void {
    appendFileSync(this.file, JSON.stringify(entry) + "\n")
  }

  private entries(): LedgerEntry[] {
    if (!existsSync(this.file)) return []
    const out: LedgerEntry[] = []
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line) continue
      try {
        out.push(JSON.parse(line) as LedgerEntry)
      } catch {
        // skip corrupt line
      }
    }
    return out
  }

  todayTotalUsd(): number {
    const today = new Date().toISOString().slice(0, 10)
    let total = 0
    for (const e of this.entries()) if (e.ts.startsWith(today)) total += e.maxUsd
    return total
  }

  tail(n: number): LedgerEntry[] {
    return this.entries().slice(-n)
  }
}

export class BudgetExceededError extends Error {
  constructor(kind: "request" | "day", amountUsd: number, limitUsd: number) {
    super(
      kind === "request"
        ? `x402: payment of $${amountUsd.toFixed(6)} exceeds the per-request cap of $${limitUsd.toFixed(2)}. ` +
          `Raise it via plugin options: { "plugin": [["opencode-x402", { "maxPerRequestUsd": ... }]] } — or lower max_tokens.`
        : `x402: today's authorized spend plus $${amountUsd.toFixed(6)} exceeds the daily cap of $${limitUsd.toFixed(2)}. ` +
          `Raise it via plugin options: { "plugin": [["opencode-x402", { "maxPerDayUsd": ... }]] }.`,
    )
    this.name = "BudgetExceededError"
  }
}

export function checkBudget(budget: Budget, ledger: Ledger, amountUsd: number): void {
  if (amountUsd > budget.maxPerRequestUsd) throw new BudgetExceededError("request", amountUsd, budget.maxPerRequestUsd)
  const today = ledger.todayTotalUsd()
  if (today + amountUsd > budget.maxPerDayUsd) throw new BudgetExceededError("day", amountUsd, budget.maxPerDayUsd)
}
