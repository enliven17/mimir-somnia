/**
 * Stub for `@x402/svm/exact/client`.
 *
 * `@somnia-chain/markets-sdk` pulls in `@coinbase/cdp-sdk`, which lazily imports the
 * Solana x402 scheme inside a Solana-only code path. Mimir is EVM-only, so that
 * path never executes — but Turbopack resolves the dynamic import statically and
 * fails the build on a missing module. Aliased here (see next.config.js) so we
 * don't install the entire Solana SDK to satisfy dead code.
 *
 * Anything that actually calls into this is a bug, so it throws loudly.
 */

function unsupported(): never {
  throw new Error(
    "Solana x402 is not supported: Mimir settles on Somnia Shannon testnet (eip155:50312) only.",
  );
}

export class ExactSvmScheme {
  constructor() {
    unsupported();
  }
}

export function registerExactSvmScheme(): never {
  return unsupported();
}
