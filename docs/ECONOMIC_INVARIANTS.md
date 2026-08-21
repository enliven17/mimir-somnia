# Economic invariant evidence

This is repository evidence, not an independent audit.

## MimirV2 fees

- Fees are charged only on profit, so principal is never reduced by a fee.
- Claim creation snapshots platform/agent-owner bps and recipients; later policy changes cannot rewrite open-market economics.
- Accrued and claimed lifetime totals support reconciliation against atomic off-chain ledger projections.
- Exact-balance intake rejects fee-on-transfer/rebasing behavior. Pull claims use checks-effects-interactions under the reentrancy guard.
- Deterministic tests cover imbalanced pools, draws, refunds, dust, fee caps and fee-recipient attribution.

## MimirSquad

- Both sides deposit into one escrow and exact ERC-20 balance deltas are required.
- Before deadline, participants can withdraw their own side balance; after resolution, winners withdraw pro rata.
- Sum of winner payouts, profit-only fee and deterministic final-winner dust equals the escrowed pot.
- Participant count and fee bps are capped; deposits, pre-deadline withdrawals and payouts are reentrancy guarded.
- Deterministic fuzz covers 3,000 pool shapes including imbalance, late liquidity, fee and rounding cases.

## Virtual baskets

- Weights equal exactly 10,000 bps and single-agent/category caps are enforced.
- Paused/stale/failed-copy allocation remains idle USDC and cannot fabricate NAV.
- Share/deposit/redemption and high-water-mark calculations use integer rounding with explicit dust ownership.
- Funded deposits remain off until the external audit and legal/eligibility gates in `LAUNCH_GATE_STATUS.md` are complete.
