# Copy executor threat model

- Compromised executor key: it cannot raise signed limits, change token/spender,
  bypass on-chain allowance, or act after immediate revoke/global pause.
- Replay: permission/source-position uniqueness and execution IDs make a repeated
  signal a skip. Nonces protect signed API requests.
- Frontrun/race: the executor re-reads deadline, slots, liquidity, payout and
  allowance, then simulates at a recorded block immediately before submission.
- Stale odds: payout below the signed floor or an expired deadline is skipped.
- Copy loop: source depth is capped at one; self-copy and ancestry cycle checks
  reject A→B→A. Signal and execution agent IDs remain separate.
- Fee loop: one immutable `sourceAttributionId` follows the original signal.
  Downstream copies do not mint new fee ancestry, and recipient transfers are not
  interpreted as additional revenue.
- Upgradeable spender: v1 permissions allow only the configured deployed Mimir
  address. A proxy or changed target requires a new, visibly signed permission;
  UI/database allowlists alone are insufficient.

Every decision writes source position, permission, simulation block, attribution,
stake, fee lines, tx hash and status/skip reason to the audit ledger.
