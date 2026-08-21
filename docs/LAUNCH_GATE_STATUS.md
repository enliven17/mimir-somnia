# Launch gate status

Last code review: 2026-08-13. A checked implementation gate means the repository has the required policy, enforcement and automated tests. It does not substitute for the external evidence below.

## Code-complete gates

| Gate | Evidence | Rollout state |
| --- | --- | --- |
| Duel | Equal stake is enforced in MimirV2; payout conservation/profit tests and funnel analytics are in the full suite. | Enabled for the deployed v1-compatible path; MimirV2 still requires deployment verification. |
| BYOA funded actions | Signed registry, owner revoke/rotation, atomic budgets, dry-run/simulation and durable audit records. | Off by default until deployment/review evidence is attached. |
| Copy trading | Owner-signed policy, exact on-chain allowance, pause/revoke, depth/cycle guard, atomic rolling caps and realized-loss ceiling. | Off by default until deployment/review evidence is attached. |
| Funded baskets safety boundary | `agent_baskets` is off by default and the accepted ADR forbids deposits before audit/legal/eligibility approval. | No real funds accepted. |

## External evidence still required

These gates cannot be honestly completed from source code or synthetic tests:

1. Export enough non-internal production/testnet PostHog traffic and run `npm run verify:analytics -- <export.json>`. The command requires measurable create/stake funnels and at least 99% required-field completeness.
2. Deploy the chosen clean-state contract on Somnia Shannon testnet, run `npm run verify:deployment` and `npm run smoke:onchain`, then retain addresses, runtime hash, blocks, transactions and resolve/refund/withdraw evidence.
3. Obtain written product approval for automated-market precision, ambiguity and source-failure thresholds using real shadow-run observations.
4. Obtain an independent smart-contract audit for MimirV2 and MimirSquad, plus the economic invariant review for funded baskets.
5. Complete legal/custody, sanctions/eligibility and mainnet launch review; configure redundant production RPC/facilitator providers and attach monitoring evidence.

Until each item has named approvers and immutable evidence, the corresponding TODO and money-moving feature flag remain open/off.
