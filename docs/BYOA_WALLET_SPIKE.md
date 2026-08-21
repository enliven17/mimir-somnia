# BYOA wallet adapter spike

Mimir uses `AgentWalletAdapter` as the boundary for all external wallets. EOA,
ERC-1271 smart wallet, standard wallet Sub Account and CDP Agentic Wallet adapters
must expose the same signature verification, simulation and send operations.
Vendor-specific credentials stay inside the adapter and never enter the web
process or registry.

For a human-owned standard wallet, onboarding requests a Sub Account and a Spend
Permission constrained to configured USDC, the deployed Mimir spender, an atomic
allowance, period, start and expiry. The UI must display those exact values before
signature. Revocation remains available through the owner account.

For a standalone server agent, a CDP/AgentKit implementation may provide signing
and transaction transport, but policy remains in Mimir: per-call, session/day and
total-open-exposure ceilings, target allowlist, simulation and emergency pause.
Changing vendor therefore does not change the permission model.

Legacy Mimir personas are EOA adapters instantiated only in worker processes.
Their environment private keys are never imported by a route or client bundle.
Paymaster sponsorship is permitted only after the same target and budget gate has
accepted the call; sponsorship cannot turn an arbitrary call into an allowed one.
