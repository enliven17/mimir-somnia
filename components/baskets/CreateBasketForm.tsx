"use client";

/**
 * Compose a basket from the agent directory.
 *
 * Weights are entered in whole percent and must total 100 — basis points are the
 * storage unit, not something to make a person type. The remaining allowance is
 * shown live, because "weights_must_total_10000_bps" after a submit is a puzzle.
 *
 * Signed by the creator: a basket earns its composer a fee, so who made it has to
 * be proven rather than claimed.
 */

import { useMemo, useState } from "react";
import { useSignMessage } from "wagmi";

import { AgentAvatar } from "@/components/agents/AgentAvatar";
import { FEE_SCHEDULE } from "@/lib/fees";
import { useWallet } from "@/lib/wallet";

export interface PickableAgent {
  id: string;
  displayName: string;
  address: string;
  track: string;
}

/** Mirrors the server's message exactly; a mismatch reads as a rejected signature. */
function basketMessage(args: {
  name: string; creator: string; members: Array<{ agentId: string; weightBps: number }>;
}): string {
  return [
    "Mimir basket",
    `name: ${args.name}`,
    `creator: ${args.creator.toLowerCase()}`,
    `members: ${args.members.map((m) => `${m.agentId}:${m.weightBps}`).join(",")}`,
  ].join("\n");
}

export function CreateBasketForm({ agents }: { agents: PickableAgent[] }) {
  const { address, isConnected, connect } = useWallet();
  const { signMessageAsync } = useSignMessage();

  const [name, setName] = useState("");
  const [thesis, setThesis] = useState("");
  const [search, setSearch] = useState("");
  const [weights, setWeights] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);

  const chosen = useMemo(
    () => Object.entries(weights).filter(([, percent]) => percent > 0),
    [weights],
  );
  const total = chosen.reduce((sum, [, percent]) => sum + percent, 0);
  // The policy caps a single agent at 40%; showing it here beats a server refusal.
  const overweight = chosen.filter(([, percent]) => percent > 40).map(([id]) => id);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return agents.slice(0, 40);
    return agents.filter((agent) =>
      agent.displayName.toLowerCase().includes(term) || agent.id.includes(term)).slice(0, 40);
  }, [agents, search]);

  function setWeight(id: string, percent: number) {
    setWeights((current) => ({ ...current, [id]: Math.max(0, Math.min(100, Math.round(percent))) }));
  }

  /** Spread evenly, giving the remainder to the first so the total is exactly 100. */
  function balance() {
    const ids = chosen.map(([id]) => id);
    if (ids.length === 0) return;
    const share = Math.floor(100 / ids.length);
    const next: Record<string, number> = {};
    ids.forEach((id, index) => { next[id] = share + (index === 0 ? 100 - share * ids.length : 0); });
    setWeights(next);
  }

  async function submit() {
    if (!address) return void connect();
    setBusy(true);
    setError(null);
    try {
      const members = chosen.map(([agentId, percent]) => ({ agentId, weightBps: percent * 100 }));
      const signature = await signMessageAsync({
        message: basketMessage({ name: name.trim(), creator: address, members }),
      });
      const response = await fetch("/api/baskets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), thesis: thesis.trim(), creator: address, members, signature }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? "could not create basket");
      setCreatedId(payload.basketId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(/user rejected|denied/i.test(message) ? "Signature rejected in your wallet." : message);
    } finally {
      setBusy(false);
    }
  }

  if (createdId) {
    return (
      <div className="space-y-3 border border-pv-emerald/40 bg-pv-emerald/[0.06] p-5">
        <h3 className="font-display text-lg font-bold text-pv-text">{name} is live</h3>
        <p className="text-sm text-pv-muted">
          Anyone can now follow it. You earn {(FEE_SCHEDULE.basketCreatorBps / 100).toFixed(2)}% of
          the profit made through it — except your own, which would just be paying yourself.
        </p>
        <a
          href={`/baskets/${createdId}`}
          className="inline-block border border-pv-emerald/45 bg-pv-emerald/[0.1] px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-pv-emerald"
        >
          Open basket →
        </a>
      </div>
    );
  }

  const field = "w-full border border-pv-ink/[0.14] bg-pv-surface2/60 px-3 py-2.5 text-sm text-pv-text outline-none transition-colors placeholder:text-pv-muted focus:border-pv-emerald/50";

  return (
    <div className="space-y-5">
      <label className="block">
        <span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-pv-muted">Name</span>
        <input value={name} onChange={(e) => setName(e.target.value.slice(0, 60))}
          placeholder="Contrarian Mix" className={field} />
      </label>

      <label className="block">
        <span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-pv-muted">
          Why these agents?
        </span>
        <textarea value={thesis} onChange={(e) => setThesis(e.target.value.slice(0, 300))} rows={2}
          placeholder="Frames that disagree with each other, so their errors do not line up."
          className={field} />
      </label>

      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-pv-muted">
            Members — {total}% of 100 allocated
          </span>
          <button type="button" onClick={balance} disabled={chosen.length === 0}
            className="border border-pv-ink/[0.14] px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-pv-muted transition-colors hover:text-pv-text disabled:opacity-40">
            Split evenly
          </button>
        </div>

        <input value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Search agents by name" className={`${field} mb-2`} />

        <div className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
          {filtered.map((agent) => (
            <div key={agent.id}
              className={`flex items-center gap-2.5 border px-3 py-2 ${
                (weights[agent.id] ?? 0) > 0 ? "border-pv-emerald/40 bg-pv-emerald/[0.06]" : "border-pv-ink/[0.1]"
              }`}>
              <AgentAvatar id={agent.id} address={agent.address} name={agent.displayName} size={26} />
              <span className="min-w-0 flex-1 truncate text-sm text-pv-text">{agent.displayName}</span>
              <span className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-pv-muted">
                {agent.track}
              </span>
              <input
                type="number" min={0} max={100} step={5}
                value={weights[agent.id] ?? 0}
                onChange={(e) => setWeight(agent.id, Number(e.target.value))}
                aria-label={`${agent.displayName} weight in percent`}
                className="w-16 shrink-0 border border-pv-ink/[0.14] bg-pv-bg px-2 py-1 text-right font-mono text-[12px] text-pv-text outline-none focus:border-pv-emerald/50"
              />
              <span className="shrink-0 font-mono text-[11px] text-pv-muted">%</span>
            </div>
          ))}
          {filtered.length === 0 && (
            <p className="px-1 py-3 text-[12px] text-pv-muted">No agent matches “{search}”.</p>
          )}
        </div>
      </div>

      {overweight.length > 0 && (
        <p className="text-[12px] text-pv-danger">
          No single agent may exceed 40%: {overweight.join(", ")}
        </p>
      )}
      {error && <p className="text-[12px] text-pv-danger">{error}</p>}

      <button type="button" disabled={busy || total !== 100 || !name.trim() || overweight.length > 0}
        onClick={submit}
        className="btn-compact-primary w-full px-4 py-2.5 text-[13px] disabled:opacity-40">
        {!isConnected ? "Connect wallet to create"
          : busy ? "Waiting for signature…"
          : total !== 100 ? `Allocate ${100 - total}% more`
          : "Create basket"}
      </button>
    </div>
  );
}
