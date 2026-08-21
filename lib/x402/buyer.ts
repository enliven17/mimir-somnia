/**
 * Buyer side of Mimir's paid resources — x402 v2 over `@x402/fetch`.
 *
 * The `exact` scheme on USDC uses EIP-3009 `transferWithAuthorization`: the agent
 * only SIGNS, the facilitator submits and pays the settlement gas. So buying data
 * needs neither a USDC approval nor ETH in the agent's wallet — ETH is only
 * needed for the agents' own contract writes (create/challenge/resolve).
 *
 * Two layers, mirroring how the agents think:
 *   1. createPayingFetch()  — a fetch that auto-pays any 402 it hits.
 *   2. fetchWithBudget()    — the agentic layer: refuse to sign at all when the
 *      quote exceeds the cap, so the agent walks away instead of overpaying.
 */

import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { decodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentPolicy } from "@x402/core/client";
import type { PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";

import { createSomniaPublicClient } from "../chain";
import { X402_NETWORK } from "./config";
import type { AgentWallet } from "../agent-wallets";

export function assertX402BuyingEnabled(address: string, env: Record<string, string | undefined> = process.env): void {
  const paused = new Set((env.MIMIR_PAUSED_X402_BUYERS ?? "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean));
  if (env.MIMIR_PAUSE_X402_BUYING === "1" || paused.has(address.trim().toLowerCase())) throw new Error("x402 buying paused");
}

export interface PayingWallet {
  /** The agent's on-chain address (payer). */
  address: `0x${string}`;
  /**
   * Builds an x402 client that signs `exact`/USDC authorizations for this wallet.
   * A factory rather than one shared client: registerPolicy mutates the client,
   * and budget caps are per-purchase.
   */
  newClient: (policy?: PaymentPolicy) => x402Client;
}

/** Wrap an agent wallet as an x402 buyer. */
export function payingWalletFor(wallet: AgentWallet): PayingWallet {
  const signer = toClientEvmSigner(wallet.account, createSomniaPublicClient() as never);
  return {
    address: wallet.address,
    newClient: (policy) => {
      const client = new x402Client().register(X402_NETWORK, new ExactEvmScheme(signer));
      return policy ? client.registerPolicy(policy) : client;
    },
  };
}

export interface PaidFetchResult {
  response: Response;
  /** Null when the resource was free (no 402). */
  payment: {
    /** Settled amount in USDC atomic units. */
    priceUnits: bigint;
    txHash: `0x${string}`;
  } | null;
}

export class PaymentBudgetExceeded extends Error {
  constructor(
    readonly priceUnits: bigint,
    readonly capUnits: bigint,
  ) {
    super(`payment price ${priceUnits} USDC atomic units exceeds budget cap ${capUnits}`);
    this.name = "PaymentBudgetExceeded";
  }
}

/** Reject any quote on the wrong network, or above the cap, before signing. */
function budgetPolicy(capUnits: bigint): PaymentPolicy {
  return (_version: number, accepts: PaymentRequirements[]): PaymentRequirements[] => {
    const onNetwork = accepts.filter((r) => r.network === X402_NETWORK);
    if (onNetwork.length === 0) {
      throw new Error(
        `402 quote targets unsupported network(s) ${accepts.map((r) => r.network).join(", ")}`,
      );
    }
    const affordable = onNetwork.filter((r) => BigInt(r.amount) <= capUnits);
    if (affordable.length === 0) {
      // The agentic decision point: cheapest quote still too expensive, walk away
      // WITHOUT producing a signature.
      const cheapest = onNetwork.reduce(
        (min, r) => (BigInt(r.amount) < min ? BigInt(r.amount) : min),
        BigInt(onNetwork[0].amount),
      );
      throw new PaymentBudgetExceeded(cheapest, capUnits);
    }
    return affordable;
  };
}

/** Settlement metadata the seller returns on a paid 200. */
function readSettlement(response: Response) {
  const header = response.headers.get("payment-response");
  if (!header) return null;
  try {
    const settled = decodePaymentResponseHeader(header);
    if (!settled.success) return null;
    return {
      priceUnits: BigInt(settled.amount ?? "0"),
      txHash: (settled.transaction || "0x") as `0x${string}`,
    };
  } catch {
    return null;
  }
}

/**
 * A fetch that automatically pays any 402 it encounters. No budget guard — use
 * fetchWithBudget for the agentic, capped path.
 */
export function createPayingFetch(wallet: PayingWallet): typeof globalThis.fetch {
  assertX402BuyingEnabled(wallet.address);
  return wrapFetchWithPayment(fetch, wallet.newClient()) as typeof globalThis.fetch;
}

/**
 * Agentic pay-per-request: the cap is enforced inside the requirements policy, so
 * an over-budget quote never gets signed.
 *
 * @param url        resource to fetch
 * @param wallet     paying agent wallet
 * @param capUnits   hard budget cap in USDC atomic units (1 USDC = 1_000_000).
 *                   Throws PaymentBudgetExceeded when the quote is higher.
 * @param init       passthrough fetch init
 */
export async function fetchWithBudget(
  url: string,
  wallet: PayingWallet,
  capUnits: bigint,
  init?: RequestInit,
): Promise<PaidFetchResult> {
  assertX402BuyingEnabled(wallet.address);
  const payingFetch = wrapFetchWithPayment(fetch, wallet.newClient(budgetPolicy(capUnits)));
  const response = await payingFetch(url, init);
  return { response, payment: readSettlement(response) };
}
