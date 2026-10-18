// EIP-712 voucher format shared by the paying client, the metered server and the contract.
import { recoverTypedDataAddress } from "viem";

export const VOUCHER_TYPES = {
  Voucher: [
    { name: "channelId", type: "bytes32" },
    { name: "cumulativeAmount", type: "uint256" },
  ],
};

export function voucherDomain(chainId, contract) {
  return { name: "PortalMeter", version: "1", chainId, verifyingContract: contract };
}

/** @param {import("viem").WalletClient | import("viem").LocalAccount} signer */
export async function signVoucher(signer, { chainId, contract, channelId, cumulativeAmount }) {
  const args = {
    domain: voucherDomain(chainId, contract),
    types: VOUCHER_TYPES,
    primaryType: "Voucher",
    message: { channelId, cumulativeAmount: BigInt(cumulativeAmount) },
  };
  // A WalletClient needs the account passed explicitly; a LocalAccount signs directly.
  return "account" in signer ? signer.signTypedData({ account: signer.account, ...args }) : signer.signTypedData(args);
}

export function recoverVoucherSigner({ chainId, contract, channelId, cumulativeAmount, signature }) {
  return recoverTypedDataAddress({
    domain: voucherDomain(chainId, contract),
    types: VOUCHER_TYPES,
    primaryType: "Voucher",
    message: { channelId, cumulativeAmount: BigInt(cumulativeAmount) },
    signature,
  });
}

// HTTP header payloads are base64url JSON so they survive proxies untouched.
export function encodeHeader(value) {
  const json = JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v));
  return Buffer.from(json).toString("base64url");
}

export function decodeHeader(header) {
  return JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
}
