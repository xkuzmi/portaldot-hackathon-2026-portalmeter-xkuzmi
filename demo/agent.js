// A data-hungry "agent" that buys Portaldot chain data per request. It only knows the
// API URL and its spending limits; channel opening, vouchers and top-ups are automatic.
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, formatEther, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createPayingFetch } from "../sdk/client.js";
import { portaldotTestnet } from "../sdk/portaldot.js";
import { requireEnv } from "./config.js";

const API = process.env.API_URL ?? "http://localhost:8402";
const ROUNDS = Number(process.argv[2] ?? 5);

const account = privateKeyToAccount(requireEnv("PAYER_KEY"));
const publicClient = createPublicClient({ chain: portaldotTestnet, transport: http() });
const walletClient = createWalletClient({ account, chain: portaldotTestnet, transport: http() });

let spent = 0n;
const payingFetch = createPayingFetch({
  publicClient,
  walletClient,
  deposit: parseEther(process.env.CHANNEL_DEPOSIT_TPOT ?? "0.2"),
  maxPricePerRequest: parseEther("0.01"),
  statePath: fileURLToPath(new URL("../agent-state.local.json", import.meta.url)),
  onEvent(e) {
    if (e.type === "channel-opened") console.log(`opened channel ${e.channelId} with ${formatEther(BigInt(e.deposit))} tPOT (tx ${e.openTx})`);
    if (e.type === "channel-topped-up") console.log(`topped up channel to ${formatEther(BigInt(e.deposit))} tPOT (tx ${e.txHash})`);
    if (e.type === "paid") spent += BigInt(e.charged);
    if (e.type === "payment-rejected") console.log(`payment rejected: ${e.reason}`);
  },
});

const manifest = await (await fetch(`${API}/.well-known/portalmeter`)).json();
console.log(`API sells ${manifest.endpoints.length} endpoints on chain ${manifest.chainId}:`);
for (const e of manifest.endpoints) console.log(`  ${e.path.padEnd(22)} ${e.priceTpot} tPOT`);

for (let round = 1; round <= ROUNDS; round++) {
  const started = performance.now();
  const head = await (await payingFetch(`${API}/api/chain/head`)).json();
  const me = await (await payingFetch(`${API}/api/account?address=${account.address}`)).json();
  const blocks = await (await payingFetch(`${API}/api/blocks/recent?n=5`)).json();
  const ms = Math.round(performance.now() - started);
  console.log(
    `round ${round}: EVM block ${head.evm.number}, native finalized ${head.native.finalizedNumber}, ` +
      `my balance ${me.evm.balanceTpot} tPOT, last ${blocks.blocks.length} blocks fetched — 3 paid calls in ${ms} ms, ` +
      `channel left ${formatEther(BigInt(blocks.paid.remaining))} tPOT`,
  );
}
console.log(`spent ${formatEther(spent)} tPOT on ${ROUNDS * 3} paid requests without a single per-request transaction`);
