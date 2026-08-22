import {
  encodeFunctionData,
  type Abi,
  type Hash,
  type WalletClient,
} from "viem";

/**
 * Optional ERC-7677 paymaster service for browser wallet writes.
 *
 * The URL is intentionally public: EIP-5792 wallets receive it as a
 * capability during the user's signing flow. No private signing material is
 * ever handled here. When it is absent, callers use the wallet's normal STT
 * transaction path.
 */
export const PAYMASTER_URL = process.env.NEXT_PUBLIC_PAYMASTER_URL?.trim() || undefined;

export function paymasterCapabilities() {
  return PAYMASTER_URL
    ? { paymasterService: { url: PAYMASTER_URL, optional: false as const } }
    : undefined;
}

function isUnsupportedCapabilityError(error: unknown): boolean {
  const candidate = error as { code?: number; message?: string; cause?: { code?: number; message?: string } };
  const code = candidate?.code ?? candidate?.cause?.code;
  const message = `${candidate?.message ?? ""} ${candidate?.cause?.message ?? ""}`.toLowerCase();
  return code === -32601
    || code === -32602
    || message.includes("method not found")
    || message.includes("wallet_sendcalls") && message.includes("not supported")
    || message.includes("unsupported capability")
    || message.includes("sendcalls is not supported");
}

type ContractWriteArgs = {
  address: `0x${string}`;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
  account?: unknown;
  chain?: unknown;
};

/**
 * Wrap a browser WalletClient so SDK writeContract calls first request an
 * ERC-5792 sponsored call. Wallets without sendCalls/paymaster support fall
 * back to the original writeContract implementation.
 */
export function withPaymasterWalletClient(walletClient: WalletClient): WalletClient {
  if (!PAYMASTER_URL) return walletClient;

  const originalWriteContract = walletClient.writeContract.bind(walletClient);
  const sponsoredWriteContract = async (rawArgs: unknown): Promise<Hash> => {
    const args = rawArgs as ContractWriteArgs;
    const capabilities = paymasterCapabilities();

    try {
      const result = await walletClient.sendCalls({
        account: args.account as never,
        chain: args.chain as never,
        calls: [
          {
            to: args.address,
            data: encodeFunctionData({
              abi: args.abi,
              functionName: args.functionName,
              args: args.args,
            }),
            value: args.value ?? 0n,
          },
        ],
        capabilities,
        forceAtomic: true,
      });

      const status = await walletClient.waitForCallsStatus({
        id: result.id,
        timeout: 120_000,
      });
      if (status.status !== "success") {
        throw new Error(`Sponsored ${args.functionName} failed (${status.status})`);
      }

      const receipt = status.receipts?.[status.receipts.length - 1];
      if (!receipt?.transactionHash) {
        throw new Error(`Sponsored ${args.functionName} returned no transaction hash`);
      }
      return receipt.transactionHash;
    } catch (error) {
      if (!isUnsupportedCapabilityError(error)) throw error;
      return originalWriteContract(rawArgs as never);
    }
  };

  return {
    ...walletClient,
    writeContract: sponsoredWriteContract as WalletClient["writeContract"],
  };
}
