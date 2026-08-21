/**
 * Squad vs Squad, V0 — a two-sided READING of a one-sided escrow.
 *
 * The roadmap's §6.8 asks for a visual prototype first: present the creator as
 * Side A's captain and the challengers as Side B, and say plainly that this is
 * not a real two-sided deposit. This module is that reading, and the honesty is
 * the point — the numbers below describe `Mimir.sol` as deployed, where:
 *
 *   - only ONE side pools freely. Challengers each deposit; Side A is the
 *     creator's single stake and nobody can join it.
 *   - the creator's stake is the counterparty to EVERY challenger, so their
 *     exposure is capped by what they put up, not by what Side B raises.
 *
 * Calling that "squad vs squad" without saying so would sell a user a team game
 * that does not exist. `isRealTwoSidedEscrow` is therefore always false here, and
 * the disclosure is not optional output — a caller cannot render the sides without
 * also having the sentence that explains them.
 *
 * V1 (real two-sided deposits, side shares, proportional payout) needs the v2
 * escrow and is gated behind it; see SETTLEMENT_MODE_POLICY.squad_pool.
 */

import { CONTRACT_VERSION } from "@/lib/market-modes";

export interface SquadSide {
  /** "A" is the creator's side, "B" the challengers'. */
  id: "A" | "B";
  label: string;
  /** Total committed to this side, in USDC units (6 decimals). */
  stakeUnits: bigint;
  participantCount: number;
  /** Addresses to stack as avatars, capped by the caller's display budget. */
  avatars: string[];
  /** True when more participants can still join this side. */
  open: boolean;
  /**
   * Whether this side pools from many depositors. False for Side A in V0 — the
   * single most misleading thing about the framing, so it is a field, not a note.
   */
  pools: boolean;
}

export interface SquadView {
  sides: [SquadSide, SquadSide];
  /** Always false until the v2 escrow ships. */
  isRealTwoSidedEscrow: boolean;
  /** Must be shown wherever the sides are. */
  disclosureKey: "squadV0Disclosure";
  /** Side A's economic privilege, stated rather than hidden. */
  captainPrivilegeKey: "squadCaptainPrivilege";
  /** 0..100 share of the total pot held by Side A, for a split bar. */
  sideAPercent: number;
}

export interface SquadInput {
  creator: string;
  creatorStakeUnits: bigint;
  challengerStakeUnits: bigint;
  challengerAddresses: string[];
  challengerCount: number;
  /** Still accepting challengers. */
  joinable: boolean;
  /** How many avatars the caller intends to stack. */
  avatarBudget?: number;
}

const DEFAULT_AVATAR_BUDGET = 5;

export function buildSquadView(input: SquadInput): SquadView {
  const budget = Math.max(0, input.avatarBudget ?? DEFAULT_AVATAR_BUDGET);
  const creatorStake = input.creatorStakeUnits < 0n ? 0n : input.creatorStakeUnits;
  const challengerStake = input.challengerStakeUnits < 0n ? 0n : input.challengerStakeUnits;
  const total = creatorStake + challengerStake;

  // Deduplicated and lower-cased: the same address arriving twice from two reads
  // would otherwise stack two avatars for one participant.
  const seen = new Set<string>();
  const avatars: string[] = [];
  for (const address of input.challengerAddresses) {
    const key = address.trim().toLowerCase();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    if (avatars.length < budget) avatars.push(key);
  }

  return {
    sides: [
      {
        id: "A",
        label: "squadSideA",
        stakeUnits: creatorStake,
        participantCount: creatorStake > 0n ? 1 : 0,
        avatars: input.creator ? [input.creator.trim().toLowerCase()] : [],
        // Nobody can join the creator's side in V0. Reporting it as open would be
        // the exact lie the disclosure exists to prevent.
        open: false,
        pools: false,
      },
      {
        id: "B",
        label: "squadSideB",
        stakeUnits: challengerStake,
        // The on-chain count is authoritative; the address list is a display
        // convenience and may be truncated by the read-index.
        participantCount: Math.max(input.challengerCount, seen.size),
        avatars,
        open: input.joinable,
        pools: true,
      },
    ],
    isRealTwoSidedEscrow: false,
    disclosureKey: "squadV0Disclosure",
    captainPrivilegeKey: "squadCaptainPrivilege",
    // Integer percent from atomic units — no float ever touches a money display.
    sideAPercent: total === 0n ? 0 : Number((creatorStake * 100n) / total),
  };
}

/**
 * Is the real, two-sided squad escrow available?
 *
 * A single place to ask, so the day the v2 contract is deployed there is one
 * constant to change rather than a search for hardcoded `false`s.
 */
export function squadEscrowAvailable(contractVersion = CONTRACT_VERSION): boolean {
  return contractVersion >= 2;
}
