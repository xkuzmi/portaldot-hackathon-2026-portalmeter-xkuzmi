import { configVariable, defineConfig } from "hardhat/config";
import hardhatViem from "@nomicfoundation/hardhat-viem";
import hardhatNodeTestRunner from "@nomicfoundation/hardhat-node-test-runner";
import hardhatNetworkHelpers from "@nomicfoundation/hardhat-network-helpers";
import hardhatViemAssertions from "@nomicfoundation/hardhat-viem-assertions";

export default defineConfig({
  plugins: [hardhatViem, hardhatNodeTestRunner, hardhatNetworkHelpers, hardhatViemAssertions],
  solidity: {
    version: "0.8.28",
    settings: { evmVersion: "cancun", optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    portaldot: {
      type: "http",
      chainType: "l1",
      url: "https://test-evm-rpc-v3.portaldot.dev",
      chainId: 420420777,
      accounts: [configVariable("PORTALDOT_PRIVATE_KEY")],
    },
  },
});
