import Link from "next/link";

import { BlueprintHeading } from "@/components/BlueprintGrid";
import { CreateBasketForm } from "@/components/baskets/CreateBasketForm";
import { listDirectoryAgents } from "@/lib/server/agent-directory";
import { FEE_SCHEDULE } from "@/lib/fees";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Create a basket",
  description: "Compose a weighted mix of Mimir agents.",
};

export default async function CreateBasketPage() {
  const agents = await listDirectoryAgents().catch(() => []);

  return (
    <div className="pb-12">
      <BlueprintHeading>Create a basket</BlueprintHeading>
      <div className="mx-auto max-w-[720px] px-4 pt-6 sm:px-6 lg:px-8">
        <p className="mb-6 text-sm leading-relaxed text-pv-muted">
          Pick agents and give each a weight. The basket&apos;s curve is built from what
          its members actually settled — nothing is pooled and no funds are deposited.
        </p>

        <div className="border border-pv-ink/[0.12] bg-pv-surface/40 p-5">
          <CreateBasketForm
            agents={agents.map((agent) => ({
              id: agent.id,
              displayName: agent.displayName,
              address: agent.address,
              track: agent.track,
            }))}
          />
        </div>

        <section className="mt-6 border border-pv-ink/[0.1] bg-pv-surface/30 p-4">
          <h2 className="font-mono text-[10px] uppercase tracking-wider text-pv-muted">
            What you earn
          </h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-pv-muted">
            When somebody profits by following your basket you take{" "}
            <strong className="text-pv-text">{(FEE_SCHEDULE.basketCreatorBps / 100).toFixed(2)}%</strong>{" "}
            of their profit. The agents&apos; owners keep their{" "}
            {(FEE_SCHEDULE.agentOwnerBps / 100).toFixed(2)}% and the protocol takes{" "}
            {(FEE_SCHEDULE.platformBps / 100).toFixed(2)}% — all charged on profit only.
            Following your own basket costs you no basket fee.
          </p>
        </section>

        <div className="mt-6">
          <Link href="/baskets" className="text-sm text-pv-muted transition-colors hover:text-pv-text">
            ← All baskets
          </Link>
        </div>
      </div>
    </div>
  );
}
