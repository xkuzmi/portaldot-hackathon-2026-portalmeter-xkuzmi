import { existsSync, readFileSync } from "node:fs";

export const DEPLOYMENT_FILE = new URL(`../deployments/${process.env.DEPLOYMENT_NAME ?? "portaldot-testnet"}.json`, import.meta.url);

export function loadDeployment() {
  if (process.env.PORTALMETER_CONTRACT) return { address: process.env.PORTALMETER_CONTRACT };
  if (!existsSync(DEPLOYMENT_FILE)) throw new Error("No deployment found: run `npm run deploy` or set PORTALMETER_CONTRACT.");
  return JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8"));
}

export function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} (see .env.example).`);
  return value;
}
