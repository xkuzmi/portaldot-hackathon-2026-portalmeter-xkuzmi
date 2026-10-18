// Deploys PortalMeterChannels to the Portaldot V3 testnet from the compiled artifact.
// Usage: npm run compile && PAYEE_KEY=0x… node scripts/deploy.js
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { portaldotTestnet } from "../sdk/portaldot.js";
import { DEPLOYMENT_FILE, requireEnv } from "../demo/config.js";

const CLOSE_DELAY_SECONDS = BigInt(process.env.CLOSE_DELAY_SECONDS ?? 3600);
const artifact = JSON.parse(
  readFileSync(new URL("../artifacts/contracts/PortalMeterChannels.sol/PortalMeterChannels.json", import.meta.url), "utf8"),
);

const account = privateKeyToAccount(requireEnv(process.env.DEPLOYER_KEY ? "DEPLOYER_KEY" : "PAYEE_KEY"));
const publicClient = createPublicClient({ chain: portaldotTestnet, transport: http() });
const walletClient = createWalletClient({ account, chain: portaldotTestnet, transport: http() });

console.log(`deploying from ${account.address} (balance ${await publicClient.getBalance({ address: account.address })} wei)`);
const hash = await walletClient.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [CLOSE_DELAY_SECONDS] });
const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`deployment failed in ${hash}`);

const deployment = {
  network: portaldotTestnet.name,
  chainId: portaldotTestnet.id,
  address: receipt.contractAddress,
  txHash: hash,
  blockNumber: Number(receipt.blockNumber),
  deployer: account.address,
  closeDelaySeconds: Number(CLOSE_DELAY_SECONDS),
  deployedAt: new Date().toISOString(),
};
mkdirSync(new URL("../deployments/", import.meta.url), { recursive: true });
writeFileSync(DEPLOYMENT_FILE, JSON.stringify(deployment, null, 2) + "\n");
console.log(deployment);
