# Contracts

## MimirV2.sol

The VS venue: user-opened claims with a creator side and a challenger side,
settled by the oracle worker. Stakes are held in the collateral token (6
decimals); gas is native STT.

Deployed on **Somnia Shannon (50312)** at
[`0xe4669525f67472173e3b9d1a4d349559b87dcde6`](https://shannon-explorer.somnia.network/address/0xe4669525f67472173e3b9d1a4d349559b87dcde6).

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

### Known gap

The app's ABI carries `createRematch`, and `/vs/create` offers a rematch, but
that function is **not** in the deployed bytecode — it belongs to v1
(`Mimir.sol`, which lives in the mimir-base repository and is not deployed
here). A rematch on this deployment reverts.
