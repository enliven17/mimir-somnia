# ADR-0008: Non-custodial basket vault boundary

Status: accepted design; funded deposits remain disabled pending independent audit and legal/eligibility review.

## Decision

The first product is a read-only virtual basket. Idle capital is always represented as 6-decimal USDC atomic integers; there is no yield, RWA, credit or rebasing asset.

A later funded version may expose ERC-4626-compatible `deposit`, `mint`, `withdraw` and `redeem`, but the vault—not an agent—is the share and asset source of truth. Initial shares equal assets. Later conversion rounds down in favor of the vault and records residual dust. A minimum locked seed plus a minimum-deposit rule mitigates donation/inflation attacks; direct USDC donations increase share price and never mint shares to the donor.

The policy caps each agent and category, validates weights sum to 10,000 bps, and keeps allocations idle when an agent is paused, a signal is stale, or a copy fails. Rebalance changes future allocation only; it cannot rewrite realized PnL. Performance fees apply only to realized gains above an atomic high-water mark. Management fees are disabled in v1.

Emergency withdrawal is a direct user-to-vault call and cannot depend on an agent executor, research worker or oracle. It returns liquid USDC immediately. Funds in unresolved onchain markets cannot be fabricated as liquid; the user receives a transferable pro-rata withdrawal claim that becomes redeemable from deterministic settlement events. Create, rebalance and copy can pause independently while exit remains enabled.

## Launch boundary

`BASKET_DEPOSITS_ENABLED` remains false until contract audit, custody/legal analysis, sanctions and eligibility controls, Somnia Shannon testnet invariant/KPI evidence, address/bytecode verification and incident runbooks are signed off. No UI may call a funded deposit route while this flag is false.
