export const SQUAD_FEE_DENOMINATOR = 10_000n;

export interface SquadPosition { address: string; stakeAtomic: bigint }
export interface SquadSettlement {
  payouts: Array<{ address: string; principalAtomic: bigint; grossAtomic: bigint; feeAtomic: bigint; netAtomic: bigint }>;
  totalDepositedAtomic: bigint;
  totalPaidAtomic: bigint;
  totalFeesAtomic: bigint;
  dustAtomic: bigint;
}

/** Mirrors MimirSquad: proportional atomic payouts, profit-only fees, final-winner dust. */
export function settleSquadPool(winners: SquadPosition[], losingPoolAtomic: bigint, feeBps: bigint): SquadSettlement {
  if (winners.length === 0) throw new Error("empty winning side");
  if (losingPoolAtomic < 0n || feeBps < 0n || feeBps > 1_000n) throw new Error("invalid settlement input");
  const winnerPool = winners.reduce((sum, item) => sum + item.stakeAtomic, 0n);
  if (winnerPool <= 0n || winners.some((item) => item.stakeAtomic <= 0n)) throw new Error("invalid winner stake");
  const total = winnerPool + losingPoolAtomic;
  let remaining = total;
  const payouts = winners.map((winner, index) => {
    const gross = index === winners.length - 1 ? remaining : (total * winner.stakeAtomic) / winnerPool;
    remaining -= gross;
    const profit = gross - winner.stakeAtomic;
    const fee = (profit * feeBps) / SQUAD_FEE_DENOMINATOR;
    return { address: winner.address, principalAtomic: winner.stakeAtomic, grossAtomic: gross, feeAtomic: fee, netAtomic: gross - fee };
  });
  const totalPaidAtomic = payouts.reduce((sum, item) => sum + item.netAtomic, 0n);
  const totalFeesAtomic = payouts.reduce((sum, item) => sum + item.feeAtomic, 0n);
  return { payouts, totalDepositedAtomic: total, totalPaidAtomic, totalFeesAtomic, dustAtomic: total - totalPaidAtomic - totalFeesAtomic };
}

export function refundSquadPool(positions: SquadPosition[]) {
  return positions.map((position) => ({ ...position, refundAtomic: position.stakeAtomic, feeAtomic: 0n }));
}
