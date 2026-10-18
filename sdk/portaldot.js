// Portaldot V3 testnet: one runtime exposing both a Substrate (native) RPC and an
// Ethereum JSON-RPC. The helpers below read the same account from both sides.
import { defineChain } from "viem";
import { blake2AsU8a, encodeAddress, xxhashAsU8a } from "@polkadot/util-crypto";
import { hexToU8a, u8aConcat, u8aToHex } from "@polkadot/util";

export const PORTALDOT_EVM_RPC = process.env.PORTALDOT_EVM_RPC ?? "https://test-evm-rpc-v3.portaldot.dev";
export const PORTALDOT_NODE_WS = process.env.PORTALDOT_NODE_WS ?? "wss://test-node-v3.portaldot.dev";
export const NATIVE_DECIMALS = 14;

export const portaldotTestnet = defineChain({
  id: 420420777,
  name: "Portaldot V3 Testnet",
  // The EVM side reports balances with 18 decimals; the runtime stores 14.
  nativeCurrency: { name: "Test POT", symbol: "tPOT", decimals: 18 },
  rpcUrls: { default: { http: [PORTALDOT_EVM_RPC] } },
});

/** Native account that an unmapped EVM address controls (pallet-revive fallback mapping). */
export function nativeAccountOf(evmAddress) {
  const id = u8aConcat(hexToU8a(evmAddress), new Uint8Array(12).fill(0xee));
  return { accountId: u8aToHex(id), ss58: encodeAddress(id, 42) };
}

/** Minimal Substrate JSON-RPC client over the global WebSocket. */
export function connectNode(url = PORTALDOT_NODE_WS) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let nextId = 0;
  const ready = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error(`cannot connect to ${url}`));
  });
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    msg.error ? entry.reject(new Error(msg.error.message)) : entry.resolve(msg.result);
  };
  ws.onclose = () => {
    for (const entry of pending.values()) entry.reject(new Error("node connection closed"));
    pending.clear();
  };

  async function call(method, params = []) {
    await ready;
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  return {
    call,
    close: () => ws.close(),

    async head() {
      const [finalizedHash, runtime, health] = await Promise.all([
        call("chain_getFinalizedHead"),
        call("state_getRuntimeVersion"),
        call("system_health"),
      ]);
      const header = await call("chain_getHeader", [finalizedHash]);
      return {
        finalizedNumber: parseInt(header.number, 16),
        finalizedHash,
        runtime: `${runtime.specName}/${runtime.specVersion}`,
        peers: health.peers,
      };
    },

    /** Reads System.Account for a 32-byte account id; balances are in 14-decimal planck. */
    async account(accountIdHex) {
      const id = hexToU8a(accountIdHex);
      const key = u8aConcat(xxhashAsU8a("System", 128), xxhashAsU8a("Account", 128), blake2AsU8a(id, 128), id);
      const raw = await call("state_getStorage", [u8aToHex(key)]);
      if (!raw) return { exists: false, nonce: 0, free: 0n, reserved: 0n, frozen: 0n };
      const bytes = hexToU8a(raw);
      const view = new DataView(bytes.buffer, bytes.byteOffset);
      const u128 = (offset) => view.getBigUint64(offset, true) + (view.getBigUint64(offset + 8, true) << 64n);
      // AccountInfo: nonce, consumers, providers, sufficients (u32 each), then AccountData u128s.
      return { exists: true, nonce: view.getUint32(0, true), free: u128(16), reserved: u128(32), frozen: u128(48) };
    },
  };
}
