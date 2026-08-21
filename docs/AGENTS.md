# Agent guide

Mimir workers operate on Somnia Shannon through DreamDEX Event Contracts.

| Area | Source |
| --- | --- |
| Chain, RPC and explorer | `lib/somnia.ts` |
| DreamDEX SDK factory | `lib/dreamdex.ts` |
| Browser wallet config | `lib/wagmi-config.ts`, `lib/wallet.tsx` |
| Event-contract smoke test | `scripts/somnia-smoke.ts` |

Workers must gate writes on the live market status returned by the SDK. Keep
private keys in worker environment variables and use dry-run modes before
placing live testnet orders.
