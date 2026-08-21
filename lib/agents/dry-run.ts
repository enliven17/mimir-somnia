import { splitFees, snapshotFeePolicy, type SettlementOutcome } from "@/lib/fees";
import { unitsToUsdc, usdcToUnits } from "@/lib/usdc";
import type { ActionVerdict } from "./registry";

export function buildAgentDryRun(args: {
  principalUsdc: number;
  grossPayoutUsdc: number;
  outcome: SettlementOutcome;
  allowanceAtomic: bigint;
  requiredAtomic: bigint;
  platformFeeBps: number;
  agentOwnerFeeBps: number;
  platformRecipient: string;
  ownerRecipient: string;
  policy: ActionVerdict;
}) {
  const fees = splitFees({
    principalUnits: usdcToUnits(args.principalUsdc),
    grossPayoutUnits: usdcToUnits(args.grossPayoutUsdc),
    outcome: args.outcome,
    snapshot: snapshotFeePolicy({
      platformFeeBps: args.platformFeeBps,
      agentOwnerFeeBps: args.agentOwnerFeeBps,
      platformRecipient: args.platformRecipient,
      agentOwnerRecipient: args.ownerRecipient,
    }),
  });
  return {
    allowed: args.policy.allowed && args.allowanceAtomic >= args.requiredAtomic,
    policy: args.policy,
    allowance: {
      currentAtomic: args.allowanceAtomic.toString(),
      requiredAtomic: args.requiredAtomic.toString(),
      sufficient: args.allowanceAtomic >= args.requiredAtomic,
    },
    payout: {
      principalUsdc: unitsToUsdc(fees.principalUnits),
      grossProfitUsdc: unitsToUsdc(fees.grossProfitUnits),
      platformFeeUsdc: unitsToUsdc(fees.platformFeeUnits),
      agentOwnerFeeUsdc: unitsToUsdc(fees.agentOwnerFeeUnits),
      totalReturnUsdc: unitsToUsdc(fees.payoutUnits),
    },
  };
}
