// Portaldot Chain Data API: a real paid API metered with PortalMeter.
// Every data endpoint costs a few thousandths of a tPOT, paid with off-chain vouchers;
// the server redeems them on Portaldot in batches.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, formatEther, http, isAddress, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createMeter, FileStore } from "../sdk/server.js";
import { connectNode, nativeAccountOf, NATIVE_DECIMALS, portaldotTestnet } from "../sdk/portaldot.js";
import { loadDeployment, requireEnv } from "./config.js";

const PORT = Number(process.env.PORT ?? 8402);
const SETTLE_EVERY_MS = Number(process.env.SETTLE_EVERY_MS ?? 60_000);
const SETTLE_MIN = parseEther(process.env.SETTLE_MIN_TPOT ?? "0.01");

const deployment = loadDeployment();
const account = privateKeyToAccount(requireEnv("PAYEE_KEY"));
const publicClient = createPublicClient({ chain: portaldotTestnet, transport: http() });
const walletClient = createWalletClient({ account, chain: portaldotTestnet, transport: http() });
const meter = await createMeter({
  publicClient,
  walletClient,
  contract: deployment.address,
  store: new FileStore(fileURLToPath(new URL("../meter-state.local.json", import.meta.url))),
}).init();
const node = connectNode();

const PRICES = {
  "/api/chain/head": parseEther("0.001"),
  "/api/account": parseEther("0.002"),
  "/api/blocks/recent": parseEther("0.005"),
};

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

const formatNative = (planck) => (Number(planck) / 10 ** NATIVE_DECIMALS).toString();

const routes = {
  "/api/chain/head": meter.paid(PRICES["/api/chain/head"], async (_req, res, receipt) => {
    const [evmBlock, gasPrice, native] = await Promise.all([publicClient.getBlock(), publicClient.getGasPrice(), node.head()]);
    json(res, 200, {
      evm: { number: evmBlock.number, hash: evmBlock.hash, timestamp: evmBlock.timestamp, gasPrice },
      native,
      paid: receipt,
    });
  }),

  "/api/account": meter.paid(PRICES["/api/account"], async (req, res, receipt) => {
    const address = new URL(req.url, "http://x").searchParams.get("address");
    if (!address || !isAddress(address)) return json(res, 400, { error: "pass ?address=0x…" });
    const nativeId = nativeAccountOf(address);
    const [balance, nonce, code, native] = await Promise.all([
      publicClient.getBalance({ address }),
      publicClient.getTransactionCount({ address }),
      publicClient.getCode({ address }),
      node.account(nativeId.accountId),
    ]);
    json(res, 200, {
      address,
      evm: { balanceTpot: formatEther(balance), nonce, isContract: Boolean(code && code !== "0x") },
      native: { ss58: nativeId.ss58, exists: native.exists, freeTpot: formatNative(native.free), reservedTpot: formatNative(native.reserved) },
      paid: receipt,
    });
  }),

  "/api/blocks/recent": meter.paid(PRICES["/api/blocks/recent"], async (req, res, receipt) => {
    const n = Math.min(Number(new URL(req.url, "http://x").searchParams.get("n") ?? 10) || 10, 25);
    const head = await publicClient.getBlockNumber();
    const blocks = await Promise.all(
      Array.from({ length: n }, (_, i) => head - BigInt(i)).filter((b) => b >= 0n).map((blockNumber) => publicClient.getBlock({ blockNumber })),
    );
    json(res, 200, {
      blocks: blocks.map((b) => ({ number: b.number, hash: b.hash, timestamp: b.timestamp, transactions: b.transactions.length, gasUsed: b.gasUsed })),
      paid: receipt,
    });
  }),

  "/.well-known/portalmeter": (_req, res) =>
    json(res, 200, {
      scheme: "portalmeter-channel-v1",
      chainId: portaldotTestnet.id,
      contract: deployment.address,
      payee: meter.payee,
      endpoints: Object.entries(PRICES).map(([path, price]) => ({ path, priceWei: price, priceTpot: formatEther(price) })),
    }),

  "/api/meter/stats": (_req, res) => json(res, 200, { ...meter.stats(), deployment }),

  "/": (_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(readFileSync(new URL("./dashboard.html", import.meta.url)));
  },
};

const server = createServer(async (req, res) => {
  const route = routes[new URL(req.url, "http://x").pathname];
  if (!route) return json(res, 404, { error: "not found", see: "/.well-known/portalmeter" });
  try {
    await route(req, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, 502, { error: err.shortMessage ?? err.message });
  }
});

setInterval(async () => {
  for (const r of await meter.settle({ minAmount: SETTLE_MIN })) {
    console.log(r.error ? `settle failed ${r.channelId}: ${r.error}` : `settled ${formatEther(BigInt(r.amount))} tPOT for ${r.requests} requests in ${r.txHash}`);
  }
}, SETTLE_EVERY_MS);

server.listen(PORT, () => {
  console.log(`Portaldot Chain Data API on http://localhost:${PORT}  (payee ${meter.payee}, contract ${deployment.address})`);
});
