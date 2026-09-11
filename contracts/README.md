# Contracts

## MimirV2.sol

The VS venue: user-opened claims with a creator side and a challenger side,
settled by the oracle worker. Stakes are held in the collateral token (6
decimals); gas is native STT.

Deployed on **Somnia Shannon (50312)** at
[`0x6ac8622338a249a0870391678f4947d2bdf2d9bd`](https://shannon-explorer.somnia.network/address/0x6ac8622338a249a0870391678f4947d2bdf2d9bd)
(block 485413812). The previous deployment,
`0xe4669525f67472173e3b9d1a4d349559b87dcde6`, lacked `createRematch`; it held no
claims, so nothing was migrated.

### Verifying this source against the chain

The source here is byte-identical to what was deployed — do not reformat it, or
the metadata hash stops matching and the explorer can no longer verify it.

```
solc 0.8.28
optimizer: enabled, runs 200
viaIR: true            # the create flow exceeds stack depth without it
```

Compiled with those settings, the runtime bytecode matches the deployed contract
except for the `immutable usdc` address, which is written in at deploy time
(0x70a86D…5d8E on Shannon) and is zeroed in a local compile. That accounts for
every differing byte.

### Rematch

`createRematch` copies everything that describes the market from its parent —
the question, both positions, the resolution source, the settlement rule — so a
rematch cannot quietly restate the terms the parent was argued under. Only the
deadline, the stake and the invite key are the caller's, and `parentId` records
the lineage.

The fee snapshot is taken fresh rather than inherited: a rematch is a new market
whose participants commit under the policy in force now. Attribution does follow
the lineage, since a rematch of an agent's market is still that agent's market.

### Building and deploying

```
node scripts/compile-contract.mjs MimirV2
npx tsx --env-file-if-exists=.env.local scripts/deploy-contract.ts            # plan
DEPLOY_CONFIRM=1 npx tsx --env-file-if-exists=.env.local scripts/deploy-contract.ts
```

Constructor arguments default to what the currently configured contract
reports, so a redeploy continues the same oracle, collateral and fee policy
instead of silently changing one. The deployer becomes `owner`, so it uses
`CREATOR_PRIVATE_KEY` — the key that owns the existing deployment.

A fresh contract starts at `claimCount` 0. Claims are not migrated, so redeploy
only while the venue is empty, and update `NEXT_PUBLIC_CONTRACT_ADDRESS` and
`NEXT_PUBLIC_DEPLOY_BLOCK` everywhere afterwards.
