/**
 * Seller side of Mimir's paid resources — x402 v2 over `@x402/next`.
 *
 * The facilitator does verification and settlement; Mimir only declares what a
 * route costs and who gets paid. There is no on-chain transaction inspection,
 * no freshness window and no app-level replay set here: `PAYMENT-SIGNATURE`
 * authorizations are single-use at the facilitator, and the payment ledger's
 * unique index is the durable idempotency guard.
 *
 * Usage in a route handler:
 *   export const GET = paidRoute("premiumPrice", handler);
 *
 * For routes whose recipient depends on the request (a council persona is paid
 * directly), pass a dynamic payTo:
 *   export const GET = paidRoute("councilVote", handler, { payTo: resolvePersona });
 */

import "server-only";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { withX402, x402ResourceServer } from "@x402/next";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { HTTPFacilitatorClient, decodePaymentSignatureHeader } from "@x402/core/http";
import type { DynamicPayTo, HTTPRequestContext } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/server";

import {
  PRICES,
  RESOURCE_META,
  X402_FACILITATOR_URL,
  X402_NETWORK,
  X402_SCHEME,
  sellerAddress,
  type PriceKey,
} from "./config";
import { recordPayment } from "../paid-revenue";
import { checkWriteAllowed } from "../ops/flags";

/**
 * A settled payment lands here exactly once per request. Awaited by the SDK, so
 * the serverless function stays alive until the ledger row is written — a
 * fire-and-forget insert would be dropped when the response returns.
 */
let _server: x402ResourceServer | null = null;

export function getResourceServer(): x402ResourceServer {
  if (_server) return _server;

  const facilitator = new HTTPFacilitatorClient({
    url: X402_FACILITATOR_URL,
    // Facilitator round trips gate the response; fail fast rather than 504.
    timeoutMs: Number(process.env.X402_FACILITATOR_TIMEOUT_MS ?? 20_000),
    ...(facilitatorAuthHeaders() ?? {}),
  });

  _server = new x402ResourceServer(facilitator)
    .register(X402_NETWORK, new ExactEvmScheme())
    .onAfterSettle(async ({ result, requirements, paymentPayload, transportContext }) => {
      if (!result.success) return;
      await recordPayment({
        resource: settledResource(transportContext, paymentPayload.resource?.url),
        scheme: requirements.scheme,
        network: result.network,
        assetAddress: requirements.asset,
        // `upto` settles a different amount than it authorized; `exact` does not.
        amountAtomic: BigInt(result.amount ?? requirements.amount),
        payer: result.payer ?? payerFromPayload(paymentPayload.payload),
        seller: requirements.payTo,
        transactionHash: result.transaction || null,
        paymentIdentifier: settlementIdentifier(result.transaction, paymentPayload.payload),
        facilitator: X402_FACILITATOR_URL,
        settledAt: Date.now(),
      });
    });

  return _server;
}

/** Which endpoint earned this payment — the request path, e.g. /api/oracle. */
function settledResource(transportContext: unknown, resourceUrl?: string): string {
  const path = (transportContext as { request?: { path?: string } } | undefined)?.request?.path;
  if (path) return path;
  if (!resourceUrl) return "";
  try {
    return new URL(resourceUrl).pathname;
  } catch {
    return resourceUrl;
  }
}

/** EIP-3009 authorizations carry the payer as the authorization's `from`. */
function payerFromPayload(payload: Readonly<Record<string, unknown>>): string | null {
  const authorization = (payload as { authorization?: { from?: string } }).authorization;
  const from = authorization?.from ?? (payload as { from?: string }).from;
  return from?.startsWith("0x") ? from : null;
}

/**
 * CDP (or any authenticated facilitator) credentials. Server-side only — these
 * must never reach the browser bundle.
 */
function facilitatorAuthHeaders() {
  const keyId = process.env.CDP_API_KEY_ID?.trim();
  const keySecret = process.env.CDP_API_KEY_SECRET?.trim();
  if (!keyId || !keySecret) return null;

  const auth = { Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}` };
  return {
    createAuthHeaders: async () => ({ verify: auth, settle: auth, supported: auth, bazaar: auth }),
  };
}

/**
 * Stable per-payment id for the ledger's unique index. The settlement tx hash is
 * the natural key; when a facilitator settles off-chain and returns none, fall
 * back to the authorization nonce, which is single-use by construction.
 */
function settlementIdentifier(
  transaction: string,
  payload: Readonly<Record<string, unknown>>,
): string {
  if (transaction) return transaction.toLowerCase();
  const authorization = (payload as { authorization?: { nonce?: string } }).authorization;
  const nonce = authorization?.nonce;
  if (typeof nonce === "string" && nonce.length > 0) return nonce.toLowerCase();
  throw new Error("x402 settlement returned neither a transaction hash nor an authorization nonce");
}

/**
 * The buyer's address, read from the `PAYMENT-SIGNATURE` the paywall already
 * verified. Null on a request that reached the handler without paying (a council
 * pass). For `exact` on EVM the payer is the EIP-3009 authorization's `from`.
 */
export function paymentPayer(req: NextRequest): `0x${string}` | null {
  const header = req.headers.get("payment-signature");
  if (!header) return null;
  try {
    const payload = decodePaymentSignatureHeader(header);
    const authorization = (payload.payload as { authorization?: { from?: string } }).authorization;
    const from = authorization?.from ?? (payload.payload as { from?: string }).from;
    return from?.startsWith("0x") ? (from.toLowerCase() as `0x${string}`) : null;
  } catch {
    return null;
  }
}

export interface PaidRouteOptions {
  /**
   * Per-request recipient — council personas are paid into their own wallets.
   * Receives the x402 HTTP request context; read query params via
   * `ctx.adapter.getQueryParam(name)`.
   */
  payTo?: DynamicPayTo;
  /** Skip the paywall entirely (e.g. a valid council pass). */
  skipPayment?: (req: NextRequest) => Promise<boolean> | boolean;
}

/**
 * Read a single query param from an x402 request context. getQueryParam is
 * optional on the adapter interface, so fall back to parsing the URL.
 */
export function queryParam(ctx: HTTPRequestContext, name: string): string {
  const raw = ctx.adapter.getQueryParam?.(name);
  if (raw !== undefined) return (Array.isArray(raw) ? raw[0] : raw).toString();
  try {
    return new URL(ctx.adapter.getUrl()).searchParams.get(name) ?? "";
  } catch {
    return "";
  }
}

/**
 * Wrap a route handler in the x402 paywall. Unpaid requests get a
 * `PAYMENT-REQUIRED` 402; a valid `PAYMENT-SIGNATURE` retry runs the handler and
 * the response carries `PAYMENT-RESPONSE` settlement metadata.
 */
export function paidRoute<T>(
  priceKey: PriceKey,
  handler: (req: NextRequest) => Promise<NextResponse<T>>,
  opts: PaidRouteOptions = {},
): (req: NextRequest) => Promise<NextResponse<T>> {
  const meta = RESOURCE_META[priceKey];

  const guarded = withX402(
    handler,
    {
      accepts: {
        scheme: X402_SCHEME,
        network: X402_NETWORK,
        price: PRICES[priceKey],
        // Always a function: resolving SELLER_ADDRESS at module scope would make
        // the route fail to even load (and `next build` fail to collect page
        // data) in any environment where the var isn't set yet.
        payTo: async (ctx: HTTPRequestContext) =>
          sellerAddress(opts.payTo ? await opts.payTo(ctx) : undefined),
      },
      description: meta.description,
      mimeType: meta.mimeType,
      serviceName: meta.serviceName,
      tags: meta.tags,
      // Bazaar discovery: agents can enumerate these services and their shapes.
      extensions: declareDiscoveryExtension(
        priceKey === "premiumPrice" || priceKey === "councilReasoning" || priceKey === "councilVote"
          ? { input: (meta.example?.input ?? {}) as Record<string, unknown>, output: { example: meta.example?.output } }
          : { bodyType: "json", input: (meta.example?.input ?? {}) as Record<string, unknown>, output: { example: meta.example?.output } },
      ),
    } as never,
    getResourceServer(),
  );

  // x402 selling pauses independently of the rest of the app: if the facilitator
  // is degraded we stop selling while settlement and withdrawal keep working.
  const withKillSwitch = async (req: NextRequest): Promise<NextResponse<T>> => {
    const gate = checkWriteAllowed({ capability: "x402_selling" });
    if (!gate.allowed) {
      return NextResponse.json(
        { error: "paid endpoints are temporarily unavailable", detail: gate.detail },
        { status: 503, headers: { "retry-after": "60" } },
      ) as NextResponse<T>;
    }
    return guarded(req);
  };

  if (!opts.skipPayment) return withKillSwitch;

  return async (req: NextRequest) =>
    (await opts.skipPayment!(req)) ? handler(req) : withKillSwitch(req);
}
