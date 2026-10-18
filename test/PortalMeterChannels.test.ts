import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { decodeEventLog, parseEther } from "viem";
import { signVoucher } from "../sdk/voucher.js";

const CLOSE_DELAY = 3600n;

async function setup() {
  const { viem, networkHelpers } = await network.create();
  const [payer, payee, stranger] = await viem.getWalletClients();
  const meter = await viem.deployContract("PortalMeterChannels", [CLOSE_DELAY]);
  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();

  async function openChannel(deposit = parseEther("1")) {
    const hash = await meter.write.open([payee.account.address], { value: deposit, account: payer.account });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const log = receipt.logs.find((l) => l.address.toLowerCase() === meter.address.toLowerCase())!;
    const event = decodeEventLog({ abi: meter.abi, ...log });
    return (event.args as { channelId: `0x${string}` }).channelId;
  }

  const voucher = (signer: typeof payer, channelId: `0x${string}`, cumulativeAmount: bigint) =>
    signVoucher(signer, { chainId, contract: meter.address, channelId, cumulativeAmount });

  return { viem, networkHelpers, meter, publicClient, payer, payee, stranger, openChannel, voucher };
}

describe("PortalMeterChannels", () => {
  it("opens a channel holding the deposit", async () => {
    const { meter, payer, payee, openChannel } = await setup();
    const id = await openChannel(parseEther("2"));
    const [chPayer, chPayee, deposit, claimed, closesAt] = await meter.read.channels([id]);
    assert.equal(chPayer.toLowerCase(), payer.account.address.toLowerCase());
    assert.equal(chPayee.toLowerCase(), payee.account.address.toLowerCase());
    assert.equal(deposit, parseEther("2"));
    assert.equal(claimed, 0n);
    assert.equal(closesAt, 0n);
  });

  it("gives every channel from the same payer a distinct id", async () => {
    const { openChannel } = await setup();
    assert.notEqual(await openChannel(), await openChannel());
  });

  it("rejects an empty deposit and a self-payee", async () => {
    const { viem, meter, payer, payee } = await setup();
    await viem.assertions.revertWithCustomError(
      meter.write.open([payee.account.address], { value: 0n, account: payer.account }),
      meter,
      "ZeroValue",
    );
    await viem.assertions.revertWithCustomError(
      meter.write.open([payer.account.address], { value: 1n, account: payer.account }),
      meter,
      "InvalidPayee",
    );
  });

  it("pays the payee incrementally for growing vouchers", async () => {
    const { meter, publicClient, payer, payee, openChannel, voucher } = await setup();
    const id = await openChannel();
    const before = await publicClient.getBalance({ address: payee.account.address });

    const first = await voucher(payer, id, parseEther("0.1"));
    let hash = await meter.write.redeem([id, parseEther("0.1"), first], { account: payee.account });
    let receipt = await publicClient.waitForTransactionReceipt({ hash });
    let gas = receipt.gasUsed * receipt.effectiveGasPrice;

    const second = await voucher(payer, id, parseEther("0.35"));
    hash = await meter.write.redeem([id, parseEther("0.35"), second], { account: payee.account });
    receipt = await publicClient.waitForTransactionReceipt({ hash });
    gas += receipt.gasUsed * receipt.effectiveGasPrice;

    const after = await publicClient.getBalance({ address: payee.account.address });
    assert.equal(after - before + gas, parseEther("0.35"));
    assert.equal(await meter.read.remaining([id]), parseEther("0.65"));
  });

  it("refuses replayed, oversized, foreign and third-party redemptions", async () => {
    const { viem, meter, payer, payee, stranger, openChannel, voucher } = await setup();
    const id = await openChannel(parseEther("1"));
    const sig = await voucher(payer, id, parseEther("0.2"));
    await meter.write.redeem([id, parseEther("0.2"), sig], { account: payee.account });

    await viem.assertions.revertWithCustomError(
      meter.write.redeem([id, parseEther("0.2"), sig], { account: payee.account }),
      meter,
      "NothingToRedeem",
    );
    const tooMuch = await voucher(payer, id, parseEther("1.5"));
    await viem.assertions.revertWithCustomError(
      meter.write.redeem([id, parseEther("1.5"), tooMuch], { account: payee.account }),
      meter,
      "AmountExceedsDeposit",
    );
    const forged = await voucher(stranger, id, parseEther("0.5"));
    await viem.assertions.revertWithCustomError(
      meter.write.redeem([id, parseEther("0.5"), forged], { account: payee.account }),
      meter,
      "InvalidSignature",
    );
    const valid = await voucher(payer, id, parseEther("0.5"));
    await viem.assertions.revertWithCustomError(
      meter.write.redeem([id, parseEther("0.5"), valid], { account: stranger.account }),
      meter,
      "NotPayee",
    );
  });

  it("does not accept a voucher signed for another channel", async () => {
    const { viem, meter, payer, payee, openChannel, voucher } = await setup();
    const a = await openChannel();
    const b = await openChannel();
    const forA = await voucher(payer, a, parseEther("0.1"));
    await viem.assertions.revertWithCustomError(
      meter.write.redeem([b, parseEther("0.1"), forA], { account: payee.account }),
      meter,
      "InvalidSignature",
    );
  });

  it("lets the payee redeem during the close delay, then refunds the payer", async () => {
    const { viem, networkHelpers, meter, payer, payee, openChannel, voucher } = await setup();
    const id = await openChannel(parseEther("1"));
    await meter.write.requestClose([id], { account: payer.account });

    await viem.assertions.revertWithCustomError(
      meter.write.withdraw([id], { account: payer.account }),
      meter,
      "ChannelNotClosable",
    );
    const sig = await voucher(payer, id, parseEther("0.3"));
    await meter.write.redeem([id, parseEther("0.3"), sig], { account: payee.account });

    await networkHelpers.time.increase(Number(CLOSE_DELAY));
    const late = await voucher(payer, id, parseEther("0.4"));
    await viem.assertions.revertWithCustomError(
      meter.write.redeem([id, parseEther("0.4"), late], { account: payee.account }),
      meter,
      "ChannelClosing",
    );

    await viem.assertions.balancesHaveChanged(meter.write.withdraw([id], { account: payer.account }), [
      { address: meter.address, amount: -parseEther("0.7") },
    ]);
    await viem.assertions.revertWithCustomError(
      meter.write.withdraw([id], { account: payer.account }),
      meter,
      "NothingToWithdraw",
    );
  });

  it("allows an immediate refund once the payee releases the channel", async () => {
    const { viem, meter, payer, payee, stranger, openChannel } = await setup();
    const id = await openChannel(parseEther("1"));
    await viem.assertions.revertWithCustomError(
      meter.write.release([id], { account: stranger.account }),
      meter,
      "NotPayee",
    );
    await meter.write.release([id], { account: payee.account });
    await viem.assertions.balancesHaveChanged(meter.write.withdraw([id], { account: payer.account }), [
      { address: meter.address, amount: -parseEther("1") },
    ]);
  });

  it("accepts top-ups only while the channel is open", async () => {
    const { viem, meter, payer, openChannel } = await setup();
    const id = await openChannel(parseEther("1"));
    await meter.write.topUp([id], { value: parseEther("0.5"), account: payer.account });
    assert.equal(await meter.read.remaining([id]), parseEther("1.5"));

    await meter.write.requestClose([id], { account: payer.account });
    await viem.assertions.revertWithCustomError(
      meter.write.topUp([id], { value: 1n, account: payer.account }),
      meter,
      "ChannelClosing",
    );
    await viem.assertions.revertWithCustomError(
      meter.write.topUp(["0x" + "00".repeat(32) as `0x${string}`], { value: 1n, account: payer.account }),
      meter,
      "UnknownChannel",
    );
  });
});
