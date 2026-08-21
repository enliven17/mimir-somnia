import assert from "node:assert/strict";
import test from "node:test";

import { buildSquadView, squadEscrowAvailable, type SquadInput } from "../../lib/squad-view";

const CREATOR = "0xAAA0000000000000000000000000000000000001";

function input(overrides: Partial<SquadInput> = {}): SquadInput {
  return {
    creator: CREATOR,
    creatorStakeUnits: 10_000_000n,
    challengerStakeUnits: 30_000_000n,
    challengerAddresses: ["0xb1", "0xb2", "0xb3"],
    challengerCount: 3,
    joinable: true,
    ...overrides,
  };
}

test("the framing never claims to be a real two-sided escrow", () => {
  // The whole point of V0: it reads as a team game but is not one.
  const view = buildSquadView(input());
  assert.equal(view.isRealTwoSidedEscrow, false);
  assert.equal(view.disclosureKey, "squadV0Disclosure");
  assert.equal(view.captainPrivilegeKey, "squadCaptainPrivilege");
});

test("side A does not pool and cannot be joined", () => {
  // Nobody can deposit alongside the creator in the deployed escrow.
  const [sideA] = buildSquadView(input()).sides;
  assert.equal(sideA.pools, false);
  assert.equal(sideA.open, false);
  assert.equal(sideA.participantCount, 1);
});

test("side B pools and stays open while the market is joinable", () => {
  const [, sideB] = buildSquadView(input()).sides;
  assert.equal(sideB.pools, true);
  assert.equal(sideB.open, true);
});

test("side B closes when the market is no longer joinable", () => {
  const [, sideB] = buildSquadView(input({ joinable: false })).sides;
  assert.equal(sideB.open, false);
});

test("the split percentage comes from atomic units, not a float", () => {
  const view = buildSquadView(input({ creatorStakeUnits: 25_000_000n, challengerStakeUnits: 75_000_000n }));
  assert.equal(view.sideAPercent, 25);
});

test("an empty market splits to zero rather than dividing by zero", () => {
  const view = buildSquadView(
    input({ creatorStakeUnits: 0n, challengerStakeUnits: 0n, challengerAddresses: [], challengerCount: 0 }),
  );
  assert.equal(view.sideAPercent, 0);
  assert.equal(view.sides[0].participantCount, 0);
});

test("a negative stake is clamped rather than inverting the split", () => {
  // Should never happen; a negative would render a bar pointing the wrong way.
  const view = buildSquadView(input({ creatorStakeUnits: -5n }));
  assert.equal(view.sides[0].stakeUnits, 0n);
  assert.equal(view.sideAPercent, 0);
});

test("a repeated challenger address stacks one avatar, not two", () => {
  const view = buildSquadView(
    input({ challengerAddresses: ["0xb1", "0xB1", "0xb2"], challengerCount: 2 }),
  );
  assert.deepEqual(view.sides[1].avatars, ["0xb1", "0xb2"]);
  assert.equal(view.sides[1].participantCount, 2);
});

test("avatars are capped by the display budget without losing the count", () => {
  const view = buildSquadView(
    input({
      challengerAddresses: ["0xb1", "0xb2", "0xb3", "0xb4", "0xb5", "0xb6"],
      challengerCount: 6,
      avatarBudget: 2,
    }),
  );
  assert.equal(view.sides[1].avatars.length, 2);
  assert.equal(view.sides[1].participantCount, 6);
});

test("the on-chain count wins when the address list is truncated", () => {
  // The read-index may hold fewer addresses than the contract has challengers.
  const view = buildSquadView(input({ challengerAddresses: ["0xb1"], challengerCount: 9 }));
  assert.equal(view.sides[1].participantCount, 9);
});

test("a longer address list than the reported count is still counted in full", () => {
  const view = buildSquadView(
    input({ challengerAddresses: ["0xb1", "0xb2", "0xb3"], challengerCount: 1 }),
  );
  assert.equal(view.sides[1].participantCount, 3);
});

test("blank addresses are dropped", () => {
  const view = buildSquadView(input({ challengerAddresses: ["", "  ", "0xb1"], challengerCount: 1 }));
  assert.deepEqual(view.sides[1].avatars, ["0xb1"]);
});

test("the real escrow is gated on the contract version", () => {
  assert.equal(squadEscrowAvailable(1), false);
  assert.equal(squadEscrowAvailable(2), true);
});

test("the deployed contract does not yet offer the real escrow", () => {
  // Guards against enabling squad mode by editing the UI and forgetting the chain.
  assert.equal(squadEscrowAvailable(), false);
});
