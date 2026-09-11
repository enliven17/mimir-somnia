/**
 * Mimir's own x402 facilitator.
 *
 * A facilitator is the party that checks a payment authorization and then moves
 * the tokens. The public one at x402.org does not know this chain — it answers
 * `Facilitator does not support scheme "exact" on network "eip155:50312"`, which
 * failed every paid route at initialisation and is why x402 revenue was
 * structurally zero rather than merely unused.
 *
 * So Mimir runs one. It serves the three endpoints an x402 client calls:
 *
 *   POST /api/x402/facilitator/verify     is this authorization good?
 *   POST /api/x402/facilitator/settle     move the tokens, return the tx
 *   GET  /api/x402/facilitator/supported  what can you settle?
 *
 * Settlement submits the buyer's signed EIP-3009 authorization on chain, so this
 * wallet pays the gas and the buyer never sends a transaction — which is the
 * point of an agent paying a fraction of a cent for a read.
 *
 * Being both seller and facilitator is a real caveat, not a detail: nothing here
 * is trust-minimised against Mimir itself. It is defensible on a testnet whose
 * paid resources are Mimir's own, and the moment a third party sells through
 * this network it should point at a facilitator neither party runs.
 */

import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { createWalletClient, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { toFacilitatorEvmSigner } from "@x402/evm";

import { getSomniaRpcUrl, somniaShannon } from "@/lib/chain";
import { X402_NETWORK } from "@/lib/x402/config";

/** Long enough for a settlement to mine; the caller gates its response on us. */
export const maxDuration = 60;

/**
 * The wallet that submits settlements, and therefore pays their gas.
 *
 * Deliberately its own variable rather than reusing a worker key: this one signs
 * nothing but other people's authorizations, so its blast radius is the gas it
 * holds. It falls back to the oracle only so a deployment that has not set it
 * still works on testnet.
 */
function facilitatorKey(): `0x${string}` | null {
  for (const name of ["X402_FACILITATOR_PRIVATE_KEY", "ORACLE_PRIVATE_KEY"]) {
    const key = process.env[name]?.trim();
    if (key && /^0x[0-9a-fA-F]{64}$/.test(key)) return key as `0x${string}`;
  }
  return null;
}

let cached: x402Facilitator | null = null;

function facilitator(): x402Facilitator {
  if (cached) return cached;

  const key = facilitatorKey();
  if (!key) {
    throw new Error(
      "No facilitator key: set X402_FACILITATOR_PRIVATE_KEY to a funded wallet",
    );
  }

  const account = privateKeyToAccount(key);
  const client = createWalletClient({
    account,
    chain: somniaShannon,
    transport: http(getSomniaRpcUrl()),
    // Verification reads chain state (balances, used nonces) through the same
    // client that settles, so it needs the public actions too.
  }).extend(publicActions);

  cached = new x402Facilitator().register(
    X402_NETWORK,
    new ExactEvmScheme(
      // The adapter wants a flat `address`; viem keeps it on `account`. Without
      // it the signer list comes back as [null], and a client rejects the whole
      // /supported document as malformed rather than reporting a missing
      // signer — which reads as "this facilitator supports nothing".
      toFacilitatorEvmSigner(Object.assign(client, { address: account.address }) as never),
    ),
  );
  return cached;
}

function failure(action: string, error: unknown): NextResponse {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[x402:facilitator] ${action} failed:`, message);
  // Shape matters: an x402 client reads `isValid`/`success` and would treat a
  // bare error body as a malformed facilitator rather than a refused payment.
  const body = action === "verify"
    ? { isValid: false, invalidReason: "unexpected_verify_error", errorMessage: message }
    : { success: false, errorReason: "unexpected_settle_error", errorMessage: message };
  return NextResponse.json(body, { status: 200 });
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ action: string }> },
): Promise<NextResponse> {
  const { action } = await context.params;
  if (action !== "verify" && action !== "settle") {
    return NextResponse.json({ error: `unknown action '${action}'` }, { status: 404 });
  }

  let payload: { paymentPayload?: unknown; paymentRequirements?: unknown };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  if (!payload?.paymentPayload || !payload?.paymentRequirements) {
    return NextResponse.json(
      { error: "paymentPayload and paymentRequirements are required" },
      { status: 400 },
    );
  }

  try {
    const instance = facilitator();
    const result = action === "verify"
      ? await instance.verify(payload.paymentPayload as never, payload.paymentRequirements as never)
      : await instance.settle(payload.paymentPayload as never, payload.paymentRequirements as never);
    return NextResponse.json(result);
  } catch (error) {
    return failure(action, error);
  }
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ action: string }> },
): Promise<NextResponse> {
  const { action } = await context.params;
  if (action !== "supported") {
    return NextResponse.json({ error: `unknown action '${action}'` }, { status: 404 });
  }
  try {
    return NextResponse.json(facilitator().getSupported());
  } catch (error) {
    // An unconfigured facilitator supports nothing; say so in the shape the
    // client expects instead of failing its discovery call.
    console.error("[x402:facilitator] supported failed:", error instanceof Error ? error.message : error);
    return NextResponse.json({ kinds: [] });
  }
}
