import { createSomniaPublicClient } from "@/lib/chain";

export interface MessageVerifier {
  verifyMessage(args: { address: `0x${string}`; message: string; signature: `0x${string}` }): Promise<boolean>;
}

/** Universal EOA/ERC-1271 verification that fails closed for hostile wallet code. */
export async function verifyAgentSignature(
  args: { address: string; message: string; signature: `0x${string}` },
  verifier: MessageVerifier = createSomniaPublicClient(),
): Promise<boolean> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(args.address) || !/^0x[0-9a-fA-F]+$/.test(args.signature)) return false;
  try {
    return await verifier.verifyMessage({ address: args.address as `0x${string}`, message: args.message, signature: args.signature });
  } catch {
    return false;
  }
}
