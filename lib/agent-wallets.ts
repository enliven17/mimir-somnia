/**
 * Local private-key wallets for the Mimir worker agents (oracle, market-creator,
 * council personas).
 *
 * Each agent owns a plain EOA whose key lives only in the worker process env —
 * the web server never sees private keys, it only knows the public addresses
 * (COUNCIL_<SLUG>_ADDRESS etc.) for payment routing and display.
 *
 * Env contract (workers only):
 *   ORACLE_PRIVATE_KEY=0x...                  → oracle agent
 *   CREATOR_PRIVATE_KEY=0x...                 → market-creator agent
 *   COUNCIL_<SLUG>_PRIVATE_KEY=0x...          → each council persona
 *
 * Generate all twelve in one pass:  npm run agents:create-wallets
 * Fund them from one master key:    npm run agents:fund
 */

import { maxUint256, parseEther, verifyMessage, type WalletClient } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  createSomniaWalletClientWithKey,
  createSomniaPublicClient,
  getContractAddress,
  somniaShannon,
} from "./chain";
import { ERC20_ABI, USDC_ADDRESS, usdcToUnits } from "./usdc";
import type { AgentWalletAdapter } from "./agents/wallet-adapter";

export interface AgentWallet {
  account: PrivateKeyAccount;
  client: WalletClient;
  address: `0x${string}`;
}

function normalizeKey(raw: string | undefined, envVar: string): `0x${string}` {
  const key = raw?.trim();
  if (!key) throw new Error(`${envVar} env var is required`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(`${envVar} must be a 0x-prefixed 32-byte hex private key`);
  }
  return key as `0x${string}`;
}

/** Build a wallet from an explicit private key env var. */
export function loadAgentWallet(envVar: string): AgentWallet {
  const key = normalizeKey(process.env[envVar], envVar);
  const account = privateKeyToAccount(key);
  return {
    account,
    client: createSomniaWalletClientWithKey(key),
    address: account.address,
  };
}

export function getOracleWallet(): AgentWallet {
  return loadAgentWallet("ORACLE_PRIVATE_KEY");
}

export function getCreatorWallet(): AgentWallet {
  return loadAgentWallet("CREATOR_PRIVATE_KEY");
}

export function councilEnvSlug(slug: string): string {
  return slug.toUpperCase().replace(/-/g, "_");
}

export function councilPrivateKeyEnv(slug: string): string {
  return `COUNCIL_${councilEnvSlug(slug)}_PRIVATE_KEY`;
}

export function councilAddressEnv(slug: string): string {
  return `COUNCIL_${councilEnvSlug(slug)}_ADDRESS`;
}

export function getCouncilWallet(slug: string): AgentWallet {
  return loadAgentWallet(councilPrivateKeyEnv(slug));
}

/** Put legacy worker EOAs behind the same boundary used by BYOA wallets. */
export function legacyAgentWalletAdapter(wallet: AgentWallet): AgentWalletAdapter {
  return {
    kind: "eoa",
    address: wallet.address,
    verifySignature: ({ message, signature }) =>
      verifyMessage({ address: wallet.address, message, signature }),
    simulate: async (call) => {
      try {
        await createSomniaPublicClient().call({
          account: wallet.address,
          to: call.target,
          data: call.data,
          value: call.value ?? 0n,
        });
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : "simulation failed" };
      }
    },
    send: async (call) => wallet.client.sendTransaction({
      account: wallet.account,
      to: call.target,
      data: call.data,
      value: call.value ?? 0n,
      chain: somniaShannon,
    }),
  };
}

/** Public address of a persona without touching its key (web-server safe). */
export function getCouncilAddress(slug: string): `0x${string}` | undefined {
  const addr = process.env[councilAddressEnv(slug)]?.trim();
  return addr?.startsWith("0x") ? (addr as `0x${string}`) : undefined;
}

// ── On-chain writes ───────────────────────────────────────────────────────────

export interface AgentWriteArgs {
  wallet: AgentWallet;
  contractAddress: `0x${string}`;
  abi: readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
  /**
   * Decimal USDC stake that must be approved for the Mimir contract before the
   * write (createClaim / challengeClaim / createRematch). NOT native STT.
   */
  amountUsdc?: string;
}

async function ensureAgentUsdcAllowance(
  wallet: AgentWallet,
  spender: `0x${string}`,
  amountUnits: bigint
): Promise<void> {
  if (amountUnits <= 0n) return;
  const client = createSomniaPublicClient();
  const current = (await client.readContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [wallet.address, spender],
  })) as bigint;
  if (current >= amountUnits) return;

  const hash = await wallet.client.writeContract({
    account: wallet.account,
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [spender, maxUint256],
    chain: somniaShannon,
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status === "reverted") {
    throw new Error(`USDC approve reverted (tx ${hash})`);
  }
}

/**
 * Submit a contract write from an agent wallet and wait for the receipt.
 * When amountUsdc is set, ensures USDC allowance to the Mimir contract first.
 * Returns the tx hash; throws when the transaction reverts.
 */
export async function agentContractWrite(args: AgentWriteArgs): Promise<`0x${string}`> {
  if (args.amountUsdc) {
    const units = usdcToUnits(Number(args.amountUsdc));
    await ensureAgentUsdcAllowance(args.wallet, args.contractAddress, units);
  }

  const hash = await args.wallet.client.writeContract({
    account: args.wallet.account,
    address: args.contractAddress,
    abi: args.abi as never,
    functionName: args.functionName,
    args: (args.args ?? []) as never,
    chain: null,
  });
  const receipt = await createSomniaPublicClient().waitForTransactionReceipt({ hash });
  if (receipt.status === "reverted") {
    throw new Error(`${args.functionName} reverted on-chain (tx ${hash})`);
  }
  return hash;
}

/** Transfer ERC-20 USDC from an agent wallet. */
export async function transferUsdc(args: {
  wallet: AgentWallet;
  to: `0x${string}`;
  /** Decimal USDC amount, e.g. "5". */
  amountUsdc: string;
}): Promise<`0x${string}`> {
  const hash = await args.wallet.client.writeContract({
    account: args.wallet.account,
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [args.to, usdcToUnits(Number(args.amountUsdc))],
    chain: somniaShannon,
  });
  const receipt = await createSomniaPublicClient().waitForTransactionReceipt({ hash });
  if (receipt.status === "reverted") {
    throw new Error(`USDC transfer reverted on-chain (tx ${hash})`);
  }
  return hash;
}

/**
 * Transfer native STT from an agent wallet — gas top-ups only. Agent bonuses and
 * every other value transfer go through transferUsdc.
 */
export async function transferEth(args: {
  wallet: AgentWallet;
  to: `0x${string}`;
  /** Decimal ETH amount, e.g. "0.001". */
  amountEth: string;
}): Promise<`0x${string}`> {
  const hash = await args.wallet.client.sendTransaction({
    account: args.wallet.account,
    to: args.to,
    value: parseEther(args.amountEth),
    chain: somniaShannon,
  });
  const receipt = await createSomniaPublicClient().waitForTransactionReceipt({ hash });
  if (receipt.status === "reverted") {
    throw new Error(`STT transfer reverted on-chain (tx ${hash})`);
  }
  return hash;
}
