# Mimir

Mimir is an AI-assisted prediction-market interface built for the Somnia
Shannon testnet. Market discovery, order books, positions and settlement use
DreamDEX Event Contracts through `@somnia-chain/markets-sdk`.

## Network

- Somnia Shannon testnet
- Chain ID: `50312`
- Native gas: `STT`
- Event-contract collateral: the configured DreamDEX testnet token
- Indexer: `https://dev.smk.somnia.host/v1/graphql`

## Local development

```bash
npm install
cp .env.example .env.local
npm run typecheck
npm run dev
```

Set `NEXT_PUBLIC_SOMNIA_RPC_URL`, `SOMNIA_WS_URL` and the DreamDEX indexer
variables when using a provider other than the public testnet endpoints.

## Workers and checks

```bash
npm run test:smoke
npm run smoke:onchain
npm run oracle
npm run market-creator
npm run council
npm run traders
```

Workers keep private keys in their process environment. The browser uses the
connected EIP-1193 wallet and switches to Somnia Shannon before signing.

## DreamDEX integration

`lib/somnia.ts` owns the chain/RPC helpers. `lib/dreamdex.ts` owns the SDK
factory, market status gates, collateral precision and order-size
quantisation. Use `scripts/somnia-smoke.ts` to verify indexer and RPC access
without sending a transaction.

## License

AGPL-3.0-or-later.
