/**
 * Canonical market classification — the single policy source for create UI,
 * detail UI, market-creator, read-index and tests.
 *
 * The on-chain contract only stores two loose strings (`marketType`, `oddsMode`).
 * Those conflate three independent axes, so new game modes must NOT be modelled
 * by inventing more string values. The axes are:
 *
 *   subjectType      what is being asked          binary | moneyline | spread | total | prop | custom
 *   settlementMode   how money moves              pool | duel | fixed_odds | squad_pool
 *   productModifiers discovery / scoring overlays underdog_boost | streak | rematch_ladder | conviction
 *
 * `settlementMode` is the only axis the escrow cares about. Modifiers never move
 * money — they are read-index and UI overlays, so adding one never needs a
 * contract change.
 */

// ── Versions ──────────────────────────────────────────────────────────────────
// Bumped when the meaning of stored market rules changes, so a read-index built
// under older rules is identifiable rather than silently reinterpreted.
export const RULES_VERSION = 1;
/** Deployed Mimir.sol generation. squad_pool needs 2. */
export const CONTRACT_VERSION = 1;
export const CONTEXT_SCHEMA_VERSION = 1;

// ── Axes ──────────────────────────────────────────────────────────────────────
export const SUBJECT_TYPES = [
  "binary",
  "moneyline",
  "spread",
  "total",
  "prop",
  "custom",
] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];

export const SETTLEMENT_MODES = ["pool", "duel", "fixed_odds", "squad_pool"] as const;
export type SettlementMode = (typeof SETTLEMENT_MODES)[number];

export const PRODUCT_MODIFIERS = [
  "underdog_boost",
  "streak",
  "rematch_ladder",
  "conviction",
] as const;
export type ProductModifier = (typeof PRODUCT_MODIFIERS)[number];

export interface CanonicalMode {
  subjectType: SubjectType;
  settlementMode: SettlementMode;
  productModifiers: ProductModifier[];
  /**
   * Set when the on-chain strings could not be mapped. Such a claim is surfaced
   * as unsupported rather than silently coerced to `pool` — a mis-read
   * settlement mode would show the wrong payout math for real money.
   */
  unsupported?: { marketType: string; oddsMode: string };
}

// ── Settlement-mode policy ────────────────────────────────────────────────────
export interface SettlementModePolicy {
  mode: SettlementMode;
  label: string;
  /** null = the contract's MAX_CHALLENGERS ceiling applies. */
  maxChallengers: number | null;
  /** How a challenger's stake relates to the creator's. */
  stakeMatching: "free" | "equal_to_creator" | "bounded_by_liquidity";
  oddsPolicy: "proportional_pool" | "winner_takes_pot" | "creator_backed_multiple";
  /** Challenger-side call to action. */
  cta: string;
  creatorRole: string;
  challengerRole: string;
  supportsRematch: boolean;
  /** Minimum contract generation that can escrow this mode. */
  requiresContractVersion: number;
  /** False until the contract can actually hold both sides — see TODO §6.8. */
  selectableOnCreate: boolean;
  description: string;
}

export const SETTLEMENT_MODE_POLICY: Record<SettlementMode, SettlementModePolicy> = {
  pool: {
    mode: "pool",
    label: "Pool Market",
    maxChallengers: null,
    stakeMatching: "free",
    oddsPolicy: "proportional_pool",
    cta: "Join & Stake",
    creatorRole: "Creator",
    challengerRole: "Challenger",
    supportsRematch: true,
    requiresContractVersion: 1,
    selectableOnCreate: true,
    description:
      "Many challengers share the creator's stake in proportion to their own. Profit comes from the losing side, not from Mimir.",
  },
  duel: {
    mode: "duel",
    label: "Duel",
    maxChallengers: 1,
    stakeMatching: "equal_to_creator",
    oddsPolicy: "winner_takes_pot",
    cta: "Accept Duel",
    creatorRole: "Creator",
    challengerRole: "Rival",
    supportsRematch: true,
    requiresContractVersion: 1,
    selectableOnCreate: true,
    description:
      "One rival, equal stakes, winner takes the two-person pot. A draw or unresolvable outcome refunds both sides in full.",
  },
  fixed_odds: {
    mode: "fixed_odds",
    label: "Fixed Odds",
    maxChallengers: null,
    stakeMatching: "bounded_by_liquidity",
    oddsPolicy: "creator_backed_multiple",
    cta: "Take the Odds",
    creatorRole: "Creator (liquidity)",
    challengerRole: "Challenger",
    supportsRematch: true,
    requiresContractVersion: 1,
    selectableOnCreate: true,
    description:
      "The creator guarantees a total-return multiple, backed by their own stake. Capacity is bounded by unreserved creator liquidity.",
  },
  squad_pool: {
    mode: "squad_pool",
    label: "Squad vs Squad",
    maxChallengers: null,
    stakeMatching: "free",
    oddsPolicy: "proportional_pool",
    cta: "Back this side",
    creatorRole: "Side A captain",
    challengerRole: "Side B",
    supportsRematch: false,
    // Real two-sided deposits need contract v2; v1 has a single creator escrow.
    requiresContractVersion: 2,
    selectableOnCreate: false,
    description:
      "Multiple depositors on both sides with proportional payout. Requires the v2 contract — not selectable yet.",
  },
};

// ── On-chain string ↔ canonical mapping ───────────────────────────────────────
// The contract keeps `oddsMode` as "pool" | "fixed"; `duel` is a v1 mode encoded
// as pool + maxChallengers 1 + equal stakes, enforced by the write guard.
const ODDS_MODE_TO_SETTLEMENT: Record<string, SettlementMode> = {
  pool: "pool",
  fixed: "fixed_odds",
  fixed_odds: "fixed_odds",
  duel: "duel",
  squad: "squad_pool",
  squad_pool: "squad_pool",
};

export function settlementModeToOddsMode(mode: SettlementMode): string {
  return mode === "fixed_odds" ? "fixed" : mode === "duel" ? "pool" : mode;
}

export function isSubjectType(value: string): value is SubjectType {
  return (SUBJECT_TYPES as readonly string[]).includes(value);
}

export function isSettlementMode(value: string): value is SettlementMode {
  return (SETTLEMENT_MODES as readonly string[]).includes(value);
}

export function isProductModifier(value: string): value is ProductModifier {
  return (PRODUCT_MODIFIERS as readonly string[]).includes(value);
}

/**
 * Map the on-chain market config onto the canonical model.
 *
 * `maxChallengers` disambiguates duel from pool: the contract cannot express
 * "duel" directly, so a single-slot pool market IS a duel. Unknown strings are
 * flagged unsupported instead of defaulting to pool.
 */
export function toCanonicalMode(input: {
  marketType: string;
  oddsMode: string;
  maxChallengers: number;
}): CanonicalMode {
  const rawSubject = (input.marketType || "").trim().toLowerCase();
  const rawOdds = (input.oddsMode || "").trim().toLowerCase();

  const subjectType: SubjectType = isSubjectType(rawSubject) ? rawSubject : "custom";
  const mapped = ODDS_MODE_TO_SETTLEMENT[rawOdds];

  if (!mapped) {
    return {
      subjectType,
      settlementMode: "pool",
      productModifiers: [],
      unsupported: { marketType: input.marketType, oddsMode: input.oddsMode },
    };
  }

  const settlementMode: SettlementMode =
    mapped === "pool" && input.maxChallengers === 1 ? "duel" : mapped;

  const productModifiers: ProductModifier[] = [];
  // A rematch is identifiable from the chain alone; the other modifiers are
  // derived later from pool shape (underdog) or off-chain projections
  // (streak, conviction), so they are not inferred here.
  return { subjectType, settlementMode, productModifiers };
}

/** True when the canonical mode came from strings we do not understand. */
export function isUnsupportedMode(mode: CanonicalMode): boolean {
  return mode.unsupported !== undefined;
}

// ── Validation ────────────────────────────────────────────────────────────────
export interface ModeValidationInput {
  subjectType: string;
  settlementMode: string;
  productModifiers?: string[];
  maxChallengers?: number;
  /** Display USDC. */
  creatorStake?: number;
  challengerStake?: number;
  /** Total-return basis points for fixed odds (20000 = 2x). */
  challengerPayoutBps?: number;
  parentId?: number;
  contractVersion?: number;
}

export interface ModeValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Reject impossible combinations before they reach the chain. This is the same
 * policy the UI, the market-creator and the write guard must all consult — a
 * check that lives only in the create form is not a check.
 */
export function validateMode(input: ModeValidationInput): ModeValidationResult {
  const errors: string[] = [];

  if (!isSubjectType(input.subjectType)) {
    errors.push(`unknown subjectType '${input.subjectType}'`);
  }
  if (!isSettlementMode(input.settlementMode)) {
    return { ok: false, errors: [...errors, `unknown settlementMode '${input.settlementMode}'`] };
  }

  const policy = SETTLEMENT_MODE_POLICY[input.settlementMode];
  const contractVersion = input.contractVersion ?? CONTRACT_VERSION;
  if (policy.requiresContractVersion > contractVersion) {
    errors.push(
      `${policy.label} needs contract v${policy.requiresContractVersion}, deployed is v${contractVersion}`,
    );
  }

  for (const modifier of input.productModifiers ?? []) {
    if (!isProductModifier(modifier)) errors.push(`unknown productModifier '${modifier}'`);
  }

  if (
    policy.maxChallengers !== null &&
    input.maxChallengers !== undefined &&
    input.maxChallengers > policy.maxChallengers
  ) {
    errors.push(
      `${policy.label} allows at most ${policy.maxChallengers} challenger(s), got ${input.maxChallengers}`,
    );
  }

  if (
    policy.stakeMatching === "equal_to_creator" &&
    input.creatorStake !== undefined &&
    input.challengerStake !== undefined &&
    input.challengerStake !== input.creatorStake
  ) {
    errors.push(
      `${policy.label} requires the challenger stake to equal the creator stake (${input.creatorStake})`,
    );
  }

  if (input.settlementMode === "fixed_odds") {
    const bps = input.challengerPayoutBps ?? 0;
    if (bps <= 10_000) {
      errors.push("fixed odds needs a total return above 1x (challengerPayoutBps > 10000)");
    } else if (
      input.creatorStake !== undefined &&
      input.challengerStake !== undefined &&
      input.challengerStake > 0
    ) {
      // The creator must cover the challenger's PROFIT, not the gross payout.
      const profit = (input.challengerStake * (bps - 10_000)) / 10_000;
      if (profit > input.creatorStake) {
        errors.push(
          `fixed odds is undercollateralised: challenger profit ${profit} exceeds creator liquidity ${input.creatorStake}`,
        );
      }
    }
  } else if ((input.challengerPayoutBps ?? 0) > 0) {
    errors.push(`${policy.label} does not use challengerPayoutBps`);
  }

  if (
    (input.productModifiers ?? []).includes("rematch_ladder") &&
    !(input.parentId && input.parentId > 0)
  ) {
    errors.push("rematch_ladder requires a settled parent claim");
  }

  return { ok: errors.length === 0, errors };
}

// ── Write guard ───────────────────────────────────────────────────────────────

export interface ChallengeGuardInput {
  settlementMode: SettlementMode;
  /** Display USDC. */
  creatorStake: number;
  challengerStake: number;
  /** Challengers already in, before this one. */
  existingChallengers: number;
  maxChallengers: number;
  challengerPayoutBps?: number;
  /** Unreserved creator liquidity, display USDC. Fixed odds only. */
  availableCreatorLiquidity?: number;
}

export interface GuardResult {
  ok: boolean;
  /** Machine-readable so the UI can localise instead of printing English. */
  code?:
    | "duel_taken"
    | "duel_stake_mismatch"
    | "market_full"
    | "insufficient_creator_liquidity"
    | "mode_unavailable";
  message?: string;
}

/**
 * Mode-aware guard that every challenge write must pass.
 *
 * This exists because the v1 contract cannot express Duel. It enforces
 * `maxChallengers` on-chain — so a second rival IS blocked by the escrow — but
 * `challengeClaim` accepts any stake above MIN_STAKE, so the equal-stake rule is
 * only enforceable off-chain in v1.
 *
 * Therefore this guard runs in the contract client, on the browser path AND the
 * agent path, rather than in the create form: a form-only check is not a check.
 * Moving equal-stake enforcement into the escrow is a v2 contract requirement.
 */
export function guardChallenge(input: ChallengeGuardInput): GuardResult {
  const policy = SETTLEMENT_MODE_POLICY[input.settlementMode];
  if (!policy) {
    return { ok: false, code: "mode_unavailable", message: "unknown settlement mode" };
  }

  const slots = policy.maxChallengers ?? input.maxChallengers;
  if (input.existingChallengers >= slots) {
    return {
      ok: false,
      code: input.settlementMode === "duel" ? "duel_taken" : "market_full",
      message:
        input.settlementMode === "duel"
          ? "this duel already has a rival"
          : `market is full (${slots} challengers)`,
    };
  }

  if (policy.stakeMatching === "equal_to_creator" && input.challengerStake !== input.creatorStake) {
    return {
      ok: false,
      code: "duel_stake_mismatch",
      message: `a duel requires an equal stake of ${input.creatorStake} USDC`,
    };
  }

  if (input.settlementMode === "fixed_odds") {
    const bps = input.challengerPayoutBps ?? 0;
    const profit = (input.challengerStake * Math.max(0, bps - 10_000)) / 10_000;
    const available = input.availableCreatorLiquidity ?? 0;
    if (bps <= 10_000 || profit > available) {
      return {
        ok: false,
        code: "insufficient_creator_liquidity",
        message: `stake needs ${profit} USDC of creator liquidity, ${available} available`,
      };
    }
  }

  return { ok: true };
}

/** Settlement modes a user may pick right now, in rollout order. */
export function selectableSettlementModes(
  contractVersion = CONTRACT_VERSION,
): SettlementModePolicy[] {
  return SETTLEMENT_MODES.map((mode) => SETTLEMENT_MODE_POLICY[mode]).filter(
    (policy) => policy.selectableOnCreate && policy.requiresContractVersion <= contractVersion,
  );
}
