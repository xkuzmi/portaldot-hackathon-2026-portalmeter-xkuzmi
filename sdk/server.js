// Server side of PortalMeter: answers unpaid requests with HTTP 402, verifies vouchers
// off-chain in milliseconds and redeems the newest voucher per channel in batches.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getAddress } from "viem";
import { portalMeterAbi } from "./abi.js";
import { decodeHeader, encodeHeader, recoverVoucherSigner } from "./voucher.js";

export const SCHEME = "portalmeter-channel-v1";
// Stop accepting vouchers this long before a closing channel's deadline, so the
// final redemption still lands in time.
const CLOSE_MARGIN_SECONDS = 120n;

export class FileStore {
  constructor(path) {
    this.path = path;
    this.data = path && existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { channels: {}, settlements: [] };
  }
  channel(id) {
    return this.data.channels[id];
  }
  saveChannel(id, value) {
    this.data.channels[id] = value;
    this.flush();
  }
  addSettlement(entry) {
    this.data.settlements.unshift(entry);
    this.data.settlements = this.data.settlements.slice(0, 200);
    this.flush();
  }
  flush() {
    if (this.path) writeFileSync(this.path, JSON.stringify(this.data, null, 2));
  }
}

export function createMeter({ publicClient, walletClient, contract, store = new FileStore(null) }) {
  const payee = getAddress(walletClient.account.address);
  let chainId;
  const onChain = new Map();

  async function readChannel(channelId, fresh = false) {
    if (!fresh && onChain.has(channelId)) return onChain.get(channelId);
    const [payer, chPayee, deposit, claimed, closesAt] = await publicClient.readContract({
      address: contract,
      abi: portalMeterAbi,
      functionName: "channels",
      args: [channelId],
    });
    const value = { payer, payee: chPayee, deposit, claimed, closesAt };
    onChain.set(channelId, value);
    return value;
  }

  function reject(res, price, reason, status = 402, extra = {}) {
    const body = { scheme: SCHEME, chainId, contract, payee, price: price.toString(), reason, ...extra };
    res.writeHead(status, { "content-type": "application/json", "x-payment-required": encodeHeader(body) });
    res.end(JSON.stringify(body));
  }

  /** Verifies a voucher for `price` and records it; returns a receipt or an error reason. */
  async function charge(header, price) {
    let voucher;
    try {
      voucher = decodeHeader(header);
    } catch {
      return { error: "malformed-payment-header" };
    }
    const { channelId, cumulativeAmount, signature } = voucher;
    if (!/^0x[0-9a-fA-F]{64}$/.test(channelId ?? "")) return { error: "malformed-payment-header" };
    const amount = BigInt(cumulativeAmount);

    let ch = await readChannel(channelId);
    if (ch.payer === "0x0000000000000000000000000000000000000000") return { error: "unknown-channel" };
    if (getAddress(ch.payee) !== payee) return { error: "wrong-payee" };
    // The client may have topped up since we cached the channel.
    if (amount > ch.deposit) ch = await readChannel(channelId, true);
    if (amount > ch.deposit) return { error: "insufficient-deposit" };
    if (ch.closesAt !== 0n) {
      const now = BigInt(Math.floor(Date.now() / 1000));
      if (now + CLOSE_MARGIN_SECONDS >= ch.closesAt) return { error: "channel-closing" };
    }

    const signer = await recoverVoucherSigner({ chainId, contract, channelId, cumulativeAmount: amount, signature });
    if (getAddress(signer) !== getAddress(ch.payer)) return { error: "invalid-signature" };

    // Re-read after the awaits above so two concurrent requests cannot both spend
    // the same increment.
    const known = store.channel(channelId) ?? { payer: ch.payer, latest: "0", settled: "0", requests: 0 };
    const previous = BigInt(known.latest);
    if (amount - previous < price) return { error: "voucher-too-small", expected: (previous + price).toString() };

    store.saveChannel(channelId, {
      ...known,
      latest: amount.toString(),
      signature,
      requests: known.requests + 1,
      updatedAt: new Date().toISOString(),
    });
    return {
      receipt: { channelId, charged: (amount - previous).toString(), cumulativeAmount: amount.toString(), remaining: (ch.deposit - amount).toString() },
    };
  }

  return {
    payee,
    async init() {
      chainId = await publicClient.getChainId();
      return this;
    },

    /** Wraps a node:http handler so it runs only after a valid payment of `price` wei. */
    paid(price, handler) {
      price = BigInt(price);
      return async (req, res) => {
        const header = req.headers["x-payment"];
        if (!header) return reject(res, price, "payment-required");
        let result;
        try {
          result = await charge(header, price);
        } catch (err) {
          return reject(res, price, `verification-failed: ${err.shortMessage ?? err.message}`, 400);
        }
        if (result.error) return reject(res, price, result.error, 402, result.expected ? { expected: result.expected } : {});
        res.setHeader("x-payment-receipt", encodeHeader(result.receipt));
        return handler(req, res, result.receipt);
      };
    },

    /** Redeems the newest unsettled voucher of every channel worth at least `minAmount`. */
    async settle({ minAmount = 0n } = {}) {
      const results = [];
      for (const [channelId, known] of Object.entries(store.data.channels)) {
        const latest = BigInt(known.latest);
        const settled = BigInt(known.settled);
        if (latest <= settled || latest - settled < minAmount) continue;
        try {
          const hash = await walletClient.writeContract({
            address: contract,
            abi: portalMeterAbi,
            functionName: "redeem",
            args: [channelId, latest, known.signature],
          });
          const receipt = await publicClient.waitForTransactionReceipt({ hash });
          if (receipt.status !== "success") throw new Error(`redeem reverted in ${hash}`);
          store.saveChannel(channelId, { ...known, settled: latest.toString() });
          onChain.delete(channelId);
          const entry = { channelId, amount: (latest - settled).toString(), cumulativeAmount: latest.toString(), requests: known.requests, txHash: hash, at: new Date().toISOString() };
          store.addSettlement(entry);
          results.push(entry);
        } catch (err) {
          results.push({ channelId, error: err.shortMessage ?? err.message });
        }
      }
      return results;
    },

    stats() {
      const channels = Object.entries(store.data.channels).map(([id, c]) => ({
        channelId: id,
        payer: c.payer,
        requests: c.requests,
        latest: c.latest,
        settled: c.settled,
        unsettled: (BigInt(c.latest) - BigInt(c.settled)).toString(),
        updatedAt: c.updatedAt,
      }));
      return { scheme: SCHEME, chainId, contract, payee, channels, settlements: store.data.settlements };
    },
  };
}
