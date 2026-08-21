# Mimir on Somnia — roadmap

Mimir runs its prediction-market execution on **Somnia** (Shannon testnet, chain
id **50312**, CAIP-2 `eip155:50312`) by trading through **DreamDEX Event
Contracts** (`@somnia-chain/markets-sdk`). Mimir keeps the product layer — AI
oracle, council personas, market-creator, the feed/detail/create UX — and the
on-chain order books, escrow and settlement belong to the DreamDEX protocol.

## Why this shape

- The DreamDEX Event Contract family is an audited, live, oracle-settled
  binary market venue (`BinaryMarketsModule`, `MarketsCore`,
  `BinarySettlement`, `OutcomeToken6909`, `OracleHub`, `CollateralRouter` —
  identical addresses on testnet 50312 and mainnet 5031 via CREATE3).
- Settlement is permissionless and automatic: each window's question is
  scheduled on the OracleHub at creation; the hub posts the answer at expiry and
  the market flips to Resolved/Voided on its own. `pokeOracle` and
  `voidExpired` are permissionless backstops. Mimir no longer needs to run a
  resolution service or hold settlement keys.
- Redemption happens through the protocol's settlement rail with a 0 fee.
  Losing positions redeem to 0 (they do not revert); voided markets pay both
  sides 0.5.

## Concept mapping

| Mimir concept (previous)      | DreamDEX Event Contract equivalent                              |
| ----------------------------- | --------------------------------------------------------------- |
| Self-hosted claim contract    | DreamDEX binary markets (`markets(marketId)` per window)        |
| Create a claim + stake        | Mint a complete set, sell the side you do not want (`mintSet` → `createOrder(... #NO)`) |
| Challenge (opposite stake)    | Buy the opposite outcome (`createOrder(..., "buy", ...)` on `#YES`/`#NO`) |
| Deadline                      | Market window `expiry` (venues roll a successor automatically)  |
| Oracle settle `resolveClaim()`| Protocol OracleHub resolution (Resolved 4 / Voided 5). Mimir surfaces the question/answer deep link |
| Payout `withdraw`             | `redeem(marketId)` of the winning outcome token (1:1, 0 fee)    |
| Platform fee escrow           | Protocol maker/taker/settlement fees are all 0                   |
| USDC 6-dec market asset       | Collateral: testnet faucet USDC (6 dec) / mainnet USDso (18 dec) |
| Native gas (ETH)              | Native STT gas (18 dec), ~6 gwei base                           |
| EIP-3009/x402 USDC            | Same USDC EIP-3009 rails, against the Somnia collateral          |
| Paymaster / gas sponsorship   | Optional; SDK writes with fixed 60 gwei × 10M gas ceiling        |

## Repository changes

### New core modules (this branch)

- `lib/somnia.ts` — Somnia chain config (`somniaShannon` 50312 RPC + WS +
  explorer), env-driven RPC/WS/indexer, viem public client, STT helpers. This
  replaces the role the chain config module had before.
- `lib/dreamdex.ts` — the single DreamDEX factory: `somniaMarketsConfig()` +
  `createExchange()`, the built-in `SOMNIA_TESTNET_ADDRESSES`, collateral
  override, tick/lot quantization, status constants. This replaces the role
  the contract client + ABI modules had before.

### Files to retire / rewire

| File | Action |
| ---- | ------ |
| `lib/chain.ts` | Retire; code moves to `lib/somnia.ts` once imports are moved |
| `lib/usdc.ts` | Rewrite as generic collateral helpers (6-dec testnet / 18-dec mainnet via `NEXT_PUBLIC_COLLATERAL_ADDRESS`) |
| `lib/contract.ts` + `lib/mimir-abi.ts` + `lib/claim-codec.ts` | Retire once every caller reads markets through `lib/dreamdex.ts` / SDK |
| `contracts/*`, `deploy/*`, `scripts/verify-deployment.ts`, `scripts/onchain-smoke.ts`, `scripts/seed-*.ts` | Drop the deploy/verify workflow; rework into faucet + mint + order seeds against the market books |
| `lib/wagmi-config.ts`, `lib/wagmi-providers.tsx`, `lib/wallet-connectors.ts`, `lib/chain-subaccount.ts` | Drop the smart-wallet connector/sub-account path (not available on this chain); chains: `[somniaShannon]` |
| `lib/x402/config.ts` | `X402_NETWORK = eip155:50312`; asset = Somnia collateral; same facilitator flow |
| `agents/oracle`, `agents/market-creator`, `agents/council`, `agents/traders` | Market reads/writes through `lib/dreamdex.ts`; no more self-hosted ABI writes |
| `docs/AGENTS.md`, `docs/AGENT_PROMPT.md`, `README.md`, `TODO.md` | Rewrite the chain/payout wiring prose |

### Env (see `.env.example`)

`SOMNIA_RPC_URL` / `NEXT_PUBLIC_SOMNIA_RPC_URL`, `SOMNIA_WS_URL`,
`DREAMDEX_INDEXER_URL`, `NEXT_PUBLIC_COLLATERAL_ADDRESS` /
`COLLATERAL_ADDRESS`, `X402_NETWORK=eip155:50312`. The old chain-specific
environment keys are retired.
## Sequence

### P0 — Foundation (this branch)

- [x] Add `@somnia-chain/markets-sdk` (0.27.0) alongside viem
- [x] `lib/somnia.ts` (chain/RPC/WS/indexer/explorer, STT helpers)
- [x] `lib/dreamdex.ts` (config factory, addresses, quantization, statuses)
- [ ] `npm install` + typecheck of the two modules
- [ ] Smoke: an SDK market read and a redemption scan on the testnet venue

### P1 — UI on the SDK
- `lib/contract.ts` consumers (pages, `/api/vs`) switch to DreamDEX market reads
  (`loadMarkets`, `listBinaryMarkets`, `getMarketOnchain`, `getOutcomeBalance`)
- Collateral helpers render amounts from the venue collateral
- Feed/detail/create pages map claims onto binary markets
- wagmi → `[somniaShannon]`; remove the smart-wallet connector; Privy chain list

### P2 — Agents trading the market books
- oracle: drop `resolveClaim`; watch windows, redeem winners, publish verdicts
- council: `createOrder` (Up/Down) instead of challenge writes
- market-creator: pick venues + mint/liquidity; AI-driven listings
- traders: order-book strategies via `fetchOrderBook` + cancel/IOC discipline

### P3 — Payments
- x402 on `eip155:50312` with the Somnia collateral; paid endpoints send it
- `payments_v2.network` values stay CAIP-2 (`eip155:50312`)

### P4 — Ops & docs
- Guardrail scope updated (no forward legacy-chain mentions)
- Env docs, README tables, agent doc rewrite
- CI: `npm ci` + `typecheck` + (compile check replaced by SDK build) + build

## Rules of the road (git)

- Every commit message carries the word **somnia**; the previous network is
  never named in commits, PRs or chat.
- No empty churn: a commit only moves this chain's work forward (real code/env
  or doc changes).
- Pre-existing fixes ride the migration path only when they block it;
  unrelated fixes get their own commit (still somnia-titled).
