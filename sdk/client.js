// Client side of PortalMeter: a fetch() that pays for 402 responses by opening one
// channel per (contract, payee) and signing a bigger cumulative voucher per request.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { decodeEventLog, getAddress } from "viem";
import { portalMeterAbi } from "./abi.js";
import { decodeHeader, encodeHeader, signVoucher } from "./voucher.js";
import { SCHEME } from "./server.js";

export function createPayingFetch({ publicClient, walletClient, deposit, maxPricePerRequest, statePath, onEvent = () => {} }) {
  const account = walletClient.account;
  const state = statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { channels: {} };
  const save = () => statePath && writeFileSync(statePath, JSON.stringify(state, null, 2));
  // Vouchers on one channel must be signed strictly one after another.
  let queue = Promise.resolve();

  async function openChannel(req) {
    const hash = await walletClient.writeContract({
      address: req.contract,
      abi: portalMeterAbi,
      functionName: "open",
      args: [req.payee],
      value: deposit,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`open reverted in ${hash}`);
    const log = receipt.logs.find((l) => getAddress(l.address) === getAddress(req.contract));
    const { args } = decodeEventLog({ abi: portalMeterAbi, ...log });
    const ch = { channelId: args.channelId, contract: req.contract, payee: req.payee, deposit: deposit.toString(), cumulative: "0", openTx: hash };
    onEvent({ type: "channel-opened", ...ch });
    return ch;
  }

  async function topUp(ch) {
    const hash = await walletClient.writeContract({
      address: ch.contract,
      abi: portalMeterAbi,
      functionName: "topUp",
      args: [ch.channelId],
      value: deposit,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    ch.deposit = (BigInt(ch.deposit) + deposit).toString();
    onEvent({ type: "channel-topped-up", channelId: ch.channelId, deposit: ch.deposit, txHash: hash });
  }

  async function channelFor(req) {
    const key = `${getAddress(req.contract)}:${getAddress(req.payee)}`;
    return (state.channels[key] ??= await openChannel(req));
  }

  async function voucherHeader(req, ch) {
    const price = BigInt(req.price);
    const next = BigInt(ch.cumulative) + price;
    if (next > BigInt(ch.deposit)) await topUp(ch);
    const signature = await signVoucher(walletClient, {
      chainId: req.chainId,
      contract: req.contract,
      channelId: ch.channelId,
      cumulativeAmount: next,
    });
    ch.cumulative = next.toString();
    save();
    return encodeHeader({ channelId: ch.channelId, cumulativeAmount: next, signature });
  }

  async function sendPaid(url, init, req) {
    if (req.scheme !== SCHEME) throw new Error(`unsupported payment scheme ${req.scheme}`);
    if (maxPricePerRequest !== undefined && BigInt(req.price) > maxPricePerRequest) {
      throw new Error(`price ${req.price} exceeds the configured limit ${maxPricePerRequest}`);
    }
    const ch = await channelFor(req);
    for (let attempt = 0; ; attempt++) {
      const headers = new Headers(init.headers);
      headers.set("x-payment", await voucherHeader(req, ch));
      const paid = await fetch(url, { ...init, headers });
      const receipt = paid.headers.get("x-payment-receipt");
      if (receipt) {
        onEvent({ type: "paid", url: String(url), status: paid.status, ...decodeHeader(receipt) });
        return paid;
      }
      const terms = paid.headers.get("x-payment-required");
      const reason = terms && decodeHeader(terms).reason;
      // Our local counter fell behind the server's (e.g. lost state file): resync once.
      if (reason === "voucher-too-small" && attempt === 0) {
        const body = await paid.clone().json();
        ch.cumulative = (BigInt(body.expected) - BigInt(req.price)).toString();
        continue;
      }
      onEvent({ type: "payment-rejected", url: String(url), status: paid.status, reason });
      return paid;
    }
  }

  return async function payingFetch(url, init = {}) {
    const first = await fetch(url, init);
    if (first.status !== 402) return first;
    const header = first.headers.get("x-payment-required");
    if (!header) return first;
    const req = decodeHeader(header);
    // Cumulative vouchers must reach the server in signing order, so paid requests are
    // sent one at a time; the unpaid probe above still runs concurrently.
    const run = () => sendPaid(url, init, req);
    return (queue = queue.then(run, run));
  };
}
