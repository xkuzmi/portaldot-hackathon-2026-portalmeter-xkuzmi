import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { network } from "hardhat";
import { parseEther } from "viem";
import { createPayingFetch } from "../sdk/client.js";
import { createMeter, FileStore } from "../sdk/server.js";
import { decodeHeader, encodeHeader, signVoucher } from "../sdk/voucher.js";

const PRICE = parseEther("0.01");

describe("PortalMeter SDK end to end", () => {
  let ctx: any;

  before(async () => {
    const { viem } = await network.create();
    const [payer, payee, stranger] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    const contract = await viem.deployContract("PortalMeterChannels", [3600n]);
    const meter = await createMeter({ publicClient, walletClient: payee, contract: contract.address, store: new FileStore(null) }).init();

    const server = createServer(
      meter.paid(PRICE, (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const url = `http://127.0.0.1:${(server.address() as any).port}/data`;
    ctx = { viem, payer, payee, stranger, publicClient, contract, meter, server, url };
  });

  after(() => ctx.server.close());

  it("answers an unpaid request with 402 and machine-readable terms", async () => {
    const res = await fetch(ctx.url);
    assert.equal(res.status, 402);
    const terms = decodeHeader(res.headers.get("x-payment-required")!);
    assert.equal(terms.scheme, "portalmeter-channel-v1");
    assert.equal(BigInt(terms.price), PRICE);
    assert.equal(terms.payee.toLowerCase(), ctx.payee.account.address.toLowerCase());
  });

  it("pays for many requests with one channel and settles them in one redemption", async () => {
    const events: any[] = [];
    const payingFetch = createPayingFetch({
      publicClient: ctx.publicClient,
      walletClient: ctx.payer,
      deposit: parseEther("0.05"),
      onEvent: (e: any) => events.push(e),
    });

    // Seven calls overflow the 0.05 deposit once, which must trigger an automatic top-up.
    const results = await Promise.all(Array.from({ length: 7 }, () => payingFetch(ctx.url)));
    assert.deepEqual(results.map((r) => r.status), Array(7).fill(200));
    assert.equal(events.filter((e) => e.type === "channel-opened").length, 1);
    assert.equal(events.filter((e) => e.type === "channel-topped-up").length, 1);

    const before = await ctx.publicClient.getBalance({ address: ctx.payee.account.address });
    const [settlement] = await ctx.meter.settle();
    assert.equal(BigInt(settlement.amount), PRICE * 7n);
    const receipt = await ctx.publicClient.getTransactionReceipt({ hash: settlement.txHash });
    const after = await ctx.publicClient.getBalance({ address: ctx.payee.account.address });
    assert.equal(after - before + receipt.gasUsed * receipt.effectiveGasPrice, PRICE * 7n);

    // Nothing new to settle.
    assert.deepEqual(await ctx.meter.settle(), []);
  });

  it("rejects a replayed voucher and a voucher from someone other than the payer", async () => {
    const payingFetch = createPayingFetch({ publicClient: ctx.publicClient, walletClient: ctx.payer, deposit: parseEther("0.05") });
    const first = await payingFetch(ctx.url);
    const { channelId, cumulativeAmount } = decodeHeader(first.headers.get("x-payment-receipt")!);
    const chainId = await ctx.publicClient.getChainId();

    const replay = encodeHeader({
      channelId,
      cumulativeAmount,
      signature: await signVoucher(ctx.payer, { chainId, contract: ctx.contract.address, channelId, cumulativeAmount }),
    });
    const replayed = await fetch(ctx.url, { headers: { "x-payment": replay } });
    assert.equal(replayed.status, 402);
    assert.equal((await replayed.json()).reason, "voucher-too-small");

    const bigger = BigInt(cumulativeAmount) + PRICE;
    const forged = encodeHeader({
      channelId,
      cumulativeAmount: bigger,
      signature: await signVoucher(ctx.stranger, { chainId, contract: ctx.contract.address, channelId, cumulativeAmount: bigger }),
    });
    const rejected = await fetch(ctx.url, { headers: { "x-payment": forged } });
    assert.equal(rejected.status, 402);
    assert.equal((await rejected.json()).reason, "invalid-signature");
  });

  it("refuses a malformed payment header without crashing", async () => {
    const res = await fetch(ctx.url, { headers: { "x-payment": "not-base64-json" } });
    assert.equal(res.status, 402);
    assert.equal((await res.json()).reason, "malformed-payment-header");
  });
});
