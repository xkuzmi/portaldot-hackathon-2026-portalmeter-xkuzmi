// Minimal ABI used by the SDK; kept in sync with contracts/PortalMeterChannels.sol.
export const portalMeterAbi = [
  {
    type: "function",
    name: "open",
    stateMutability: "payable",
    inputs: [{ name: "payee", type: "address" }],
    outputs: [{ name: "channelId", type: "bytes32" }],
  },
  {
    type: "function",
    name: "topUp",
    stateMutability: "payable",
    inputs: [{ name: "channelId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "redeem",
    stateMutability: "nonpayable",
    inputs: [
      { name: "channelId", type: "bytes32" },
      { name: "cumulativeAmount", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "requestClose",
    stateMutability: "nonpayable",
    inputs: [{ name: "channelId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [{ name: "channelId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "channels",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [
      { name: "payer", type: "address" },
      { name: "payee", type: "address" },
      { name: "deposit", type: "uint128" },
      { name: "claimed", type: "uint128" },
      { name: "closesAt", type: "uint64" },
    ],
  },
  {
    type: "event",
    name: "ChannelOpened",
    inputs: [
      { name: "channelId", type: "bytes32", indexed: true },
      { name: "payer", type: "address", indexed: true },
      { name: "payee", type: "address", indexed: true },
      { name: "deposit", type: "uint256", indexed: false },
    ],
  },
];
