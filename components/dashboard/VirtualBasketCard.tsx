import type { BasketAgentWeight, BasketSnapshot } from "@/lib/baskets";
import { basketExposure } from "@/lib/baskets";

export function VirtualBasketCard({ weights, snapshots }: { weights: BasketAgentWeight[]; snapshots: BasketSnapshot[] }) {
  const exposure = basketExposure(weights);
  const latest = snapshots.at(-1);
  const maxDrawdown = snapshots.reduce((max, point) => Math.max(max, point.drawdownBps), 0);
  return <section className="rounded-2xl border border-pv-ink/10 p-4" aria-label="Virtual agent basket">
    <div className="flex justify-between"><div><h3 className="font-semibold">Virtual agent basket</h3><p className="text-xs text-pv-ink/60">Simulation only — idle capital remains USDC; no yield or real funds.</p></div><div className="text-right"><div>{latest ? (Number(latest.navAtomic) / 1_000_000).toFixed(2) : "—"} USDC</div><div className="text-xs text-pv-ink/60">Max drawdown {(maxDrawdown / 100).toFixed(2)}%</div></div></div>
    <div className="mt-4 grid gap-3 sm:grid-cols-2"><div><h4 className="text-xs uppercase text-pv-ink/50">Agents</h4>{weights.map((item) => <div key={item.agentId} className="flex justify-between text-sm"><span>{item.agentId}{item.paused || item.stale ? " (idle)" : ""}</span><span>{(item.weightBps / 100).toFixed(2)}%</span></div>)}</div><div><h4 className="text-xs uppercase text-pv-ink/50">Category / mode exposure</h4>{Object.entries({ ...exposure.categories, ...Object.fromEntries(Object.entries(exposure.modes).map(([key, value]) => [`mode:${key}`, value])) }).map(([key, value]) => <div key={key} className="flex justify-between text-sm"><span>{key}</span><span>{(value / 100).toFixed(2)}%</span></div>)}</div></div>
  </section>;
}
