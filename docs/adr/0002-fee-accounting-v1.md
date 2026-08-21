# ADR-0002: Fee accounting v1

- Status: Accepted
- Date: 2026-08-12
- Scope: MimirV2 market fees and x402 service revenue

## Decision

Mimir records two independent fee lines:

1. `platformFeeBps` is protocol revenue from a decisively resolved market.
2. `agentOwnerFeeBps` is revenue for the snapshotted owner of an agent-attributed
   create or copy action. Markets without valid attribution charge no owner fee.

Both market fees use **realized winner profit** (`gross payout - returned
principal`) as their base. Deposits are never charged. Drawn, cancelled and
unresolvable markets return principal without fees. An x402 fee is different: it
is recognized only after the service payment settles and its base is the settled
service amount.

The combined market fee rate is capped at 1,000 bps. Integer division rounds each
fee down in the participant's favour. Any remaining atomic units are explicit
settlement dust; they are not revenue. When platform and owner recipients are the
same address, the two economic lines remain distinct but the payout ledger merges
them into one recipient balance. Dashboards must not count the merged transfer as
a third fee.

Underdog discovery does not receive a fee discount in v1. A discount tied to the
current pool shape is cheap to sybil and can be manufactured by self-funding the
other side; it would also let the fee base change after a participant has seen the
terms. Any later discount requires a separate abuse analysis and a snapshotted,
identity-resistant policy.

## Policy lifecycle and payout safety

Fee terms and the attributed agent owner are snapshotted when a market is
created. Later policy or registry changes cannot affect that market. Policy
changes use a two-day timelock and cannot exceed the hard cap.

Settlement accrues fees to balances. Recipients pull them with `claimFees`; a
recipient failure cannot block market settlement. State is cleared before the
token transfer and the entry point is non-reentrant. Participant transfers that
fail are parked as pullable withdrawals.

## Asset and reconciliation rules

MimirV2 supports only its configured Circle USDC contract and exact atomic-unit
transfers. Stake intake verifies the contract balance increased by precisely the
requested amount, explicitly rejecting fee-on-transfer or rebasing behavior.

`payments_v2` and the market fee event projection are separate source ledgers.
The revenue API merges their summaries only at the presentation boundary. Event
rows are idempotent by transaction hash and log index, so a chain replay cannot
double-count. For every settled market:

`escrow inflow = participant payouts + platform fees + agent-owner fees + dust`

Principal is part of participant payouts, not an additional term on the right
hand side. All ledger arithmetic uses integer atomic USDC; decimals appear only
in the API/UI.
