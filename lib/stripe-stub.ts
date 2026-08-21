/**
 * Stub for `@stripe/stripe-js`.
 *
 * `@privy-io/react-auth` imports Stripe for its card-funding onramp — a feature
 * Mimir does not use: stakes are USDC the user already holds, and the only funding
 * path here is a testnet faucet. Turbopack resolves that import statically and
 * fails the build on the missing module, so it is aliased here (see next.config.js)
 * rather than installing a payments SDK to satisfy a code path that never runs.
 *
 * Anything that actually reaches this is a bug, so it throws loudly instead of
 * returning a null that would surface as a broken modal three screens later.
 */

function unsupported(): never {
  throw new Error(
    "Stripe funding is not enabled: Mimir stakes existing USDC on Somnia Shannon testnet.",
  );
}

export function loadStripe(): never {
  return unsupported();
}

export default loadStripe;
