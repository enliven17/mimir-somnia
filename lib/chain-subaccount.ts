"use client";

/**
 * Somnia uses ordinary EIP-1193 wallets for browser writes.
 *
 * The old delegated-account flow is intentionally unavailable here: keeping a
 * serverless app from holding delegated signing keys is safer and matches the
 * wallet surface supported by the current deployment.
 */
export interface SubAccountState {
  address: `0x${string}`;
  ownerAddress?: `0x${string}`;
}

export function readSubAccount(): SubAccountState | null {
  return null;
}

export async function enableOneTapMirroring(): Promise<SubAccountState> {
  throw new Error("Delegated accounts are not enabled; sign mirror orders with your connected wallet.");
}

export async function sendFromSubAccount(_calls: unknown[]): Promise<string> {
  throw new Error("Delegated accounts are not enabled; sign mirror orders with your connected wallet.");
}
