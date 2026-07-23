/** Dev check: on-chain USDC/ETH balance of the configured wallet address. */
import { createPublicClient, erc20Abi, formatEther, formatUnits, http } from "viem"
import { base } from "viem/chains"
import { PERMIT2_ADDRESS } from "@x402/evm"
import { rememberedAddress } from "../src/wallet.ts"
import { BASE_USDC } from "../src/si.ts"

const address = rememberedAddress()
if (!address) {
  console.error("no wallet address on disk")
  process.exit(1)
}
const client = createPublicClient({ chain: base, transport: http("https://mainnet.base.org") })
const [usdc, eth, allowance] = await Promise.all([
  client.readContract({ address: BASE_USDC, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
  client.getBalance({ address }),
  client.readContract({ address: BASE_USDC, abi: erc20Abi, functionName: "allowance", args: [address, PERMIT2_ADDRESS] }),
])
console.log(`address: ${address}`)
console.log(`USDC: ${formatUnits(usdc, 6)}`)
console.log(`ETH: ${formatEther(eth)}`)
console.log(`permit2 allowance: ${allowance > 0n ? "set (upto ready)" : "none (exact scheme)"}`)
