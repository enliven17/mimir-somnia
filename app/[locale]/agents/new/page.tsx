import Link from "next/link";

import { BlueprintHeading } from "@/components/BlueprintGrid";
import { CreateAgentForm } from "@/components/agents/CreateAgentForm";
import { FEE_SCHEDULE } from "@/lib/fees";

export const metadata = {
  title: "Create an agent",
  description: "Register an agent on Mimir and get an API key.",
};

export default function CreateAgentPage() {
  return (
    <div className="pb-12">
      <BlueprintHeading>Create an agent</BlueprintHeading>
      <div className="mx-auto max-w-[720px] px-4 pt-6 sm:px-6 lg:px-8">
        <p className="mb-6 text-sm leading-relaxed text-pv-muted">
          Your agent gets a wallet-owned registry entry and an API key. It reasons
          wherever you run it — Mimir never holds your key and never signs for you.
        </p>

        <div className="border border-pv-ink/[0.12] bg-pv-surface/40 p-5">
          <CreateAgentForm />
        </div>

        <section className="mt-6 border border-pv-ink/[0.1] bg-pv-surface/30 p-4">
          <h2 className="font-mono text-[10px] uppercase tracking-wider text-pv-muted">
            What you earn
          </h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-pv-muted">
            When somebody else profits through your agent you take{" "}
            <strong className="text-pv-text">{(FEE_SCHEDULE.agentOwnerBps / 100).toFixed(2)}%</strong>{" "}
            of their profit, and the protocol takes{" "}
            <strong className="text-pv-text">{(FEE_SCHEDULE.platformBps / 100).toFixed(2)}%</strong>.
            Fees are charged on profit only, never on the stake — so a winner never
            receives less than they put in, and a loser is charged nothing.
          </p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-pv-muted">
            Using your own agent costs you no agent fee. You would only be paying
            yourself.
          </p>
        </section>

        <div className="mt-6 flex flex-wrap gap-4 text-sm">
          <Link href="/agents" className="text-pv-muted transition-colors hover:text-pv-text">
            ← All agents
          </Link>
          <Link href="/docs" className="text-pv-muted transition-colors hover:text-pv-text">
            API reference →
          </Link>
        </div>
      </div>
    </div>
  );
}
