"use client";

/**
 * /revenue — live payment earnings dashboard.
 *
 * Shows USDC flowing into Mimir's paid endpoints in real time: total calls,
 * total earned, unique paying agents, per-endpoint breakdown, recent payments.
 *
 * Reads the durable Neon ledger via /api/payments/revenue (falls back to
 * in-memory when no DB is configured). Every payment links to its x402
 * settlement on the Somnia explorer — the chain is the ultimate source of truth.
 */

import { useEffect, useState } from "react";
import { BlueprintHeading } from "@/components/BlueprintGrid";
import { shortenAddress } from "@/lib/constants";
import { getExplorerTxUrl } from "@/lib/chain";

interface PaymentEvent {
  resource: string;
  network: string;
  assetSymbol: string;
  amountUsdc: number;
  payer: string | null;
  seller: string | null;
  transactionHash: string | null;
  at: number;
}

interface RevenueSummary {
  totalCalls: number;
  baselineCalls: number;
  totalUsdc: number;
  baselineUsdc: number;
  uniquePayers: number;
  uniqueSellers: number;
  byResource: Array<{ resource: string; calls: number; usdc: number }>;
  bySeller: Array<{ seller: string; calls: number; usdc: number }>;
  recent: PaymentEvent[];
  market: {
    settledMarkets: number;
    grossVolumeUsdc: number;
    payoutUsdc: number;
    platformFeeUsdc: number;
    agentOwnerFeeUsdc: number;
    dustUsdc: number;
    unclaimedUsdc: number;
  };
}

function short(addr: string | null): string {
  return addr ? shortenAddress(addr) : "—";
}

function isTxHash(id: string | null): id is string {
  return !!id && /^0x[0-9a-fA-F]{64}$/.test(id);
}

function ReceiptLink({ txHash }: { txHash: string | null }) {
  if (isTxHash(txHash)) {
    return (
      <a
        href={getExplorerTxUrl(txHash)}
        target="_blank"
        rel="noopener noreferrer"
        className="text-pv-emerald underline-offset-2 hover:underline"
        title={txHash}
      >
        {short(txHash)} ↗
      </a>
    );
  }
  return <span className="text-pv-muted/60">—</span>;
}

export default function RevenuePage() {
  const [data, setData] = useState<RevenueSummary | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/payments/revenue");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as RevenueSummary;
        if (alive) setData(json);
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : "failed to load");
      }
    };
    load();
    const t = setInterval(load, 5_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-24 pt-10">
      <BlueprintHeading>Agent revenue</BlueprintHeading>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-pv-muted">
        A reconciled view of market settlement fees and x402 service revenue.
        The ledgers remain separate by source and use atomic USDC accounting.
      </p>

      {err && (
        <p className="mt-6 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          Failed to load revenue: {err}
        </p>
      )}

      {!data && !err && <RevenueSkeleton />}


      {data && (
        <>
          <section className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Stat label="Gross market volume" value={`${data.market.grossVolumeUsdc.toFixed(6)} USDC`} />
            <Stat label="Market payouts" value={`${data.market.payoutUsdc.toFixed(6)} USDC`} />
            <Stat label="Platform fees" value={`${data.market.platformFeeUsdc.toFixed(6)} USDC`} accent />
            <Stat label="Agent-owner fees" value={`${data.market.agentOwnerFeeUsdc.toFixed(6)} USDC`} accent />
            <Stat label="x402 service revenue" value={`${data.totalUsdc.toFixed(6)} USDC`} accent />
            <Stat label="Unclaimed fees" value={`${data.market.unclaimedUsdc.toFixed(6)} USDC`} />
          </section>
          <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.12em] text-pv-muted">
            {data.market.settledMarkets} settled markets · {data.market.dustUsdc.toFixed(6)} USDC recorded dust · {data.totalCalls} paid calls · {data.uniquePayers} payers / {data.uniqueSellers} sellers
          </p>

          {/* A bare row of zeros reads as "broken", when in fact these are two
              different kinds of nothing: no fee policy is set, and nobody has paid
              for an x402 call yet. Say which. */}
          {(data.market.platformFeeUsdc === 0 && data.market.agentOwnerFeeUsdc === 0) && (
            <p className="mt-2 text-[12px] text-pv-muted">
              Fees read zero because the deployed fee policy is 0 bps on both legs — settlement
              pays winners in full. They start accruing here the moment a non-zero policy is
              queued and executed on chain.
            </p>
          )}
          {data.totalCalls === 0 && (
            <p className="mt-1.5 text-[12px] text-pv-muted">
              x402 service revenue is zero because no agent has paid for a priced endpoint yet
              (oracle verdicts, council reasoning, premium price). Market settlement above is
              independent of it.
            </p>
          )}
          {(data.baselineCalls > 0 || data.baselineUsdc > 0) && (
            <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.12em] text-pv-muted">
              includes {data.baselineCalls} calls / {data.baselineUsdc.toFixed(6)} USDC carried
              over from an earlier deployment
            </p>
          )}

          <section className="mt-10">
            <h2 className="label">By endpoint</h2>
            <div className="card mt-3 divide-y divide-pv-ink/[0.08]">
              {data.byResource.length === 0 && (
                <p className="px-4 py-4 text-sm text-pv-muted">No payments yet.</p>
              )}
              {data.byResource.map((r) => (
                <div key={r.resource} className="flex items-center justify-between px-4 py-3.5">
                  <code className="font-mono text-sm text-pv-text">{r.resource}</code>
                  <span className="font-mono text-sm text-pv-muted">
                    {r.calls} calls · {r.usdc.toFixed(6)} USDC
                  </span>
                </div>
              ))}
            </div>
          </section>

          <section className="mt-10">
            <h2 className="label">By seller wallet</h2>
            <div className="card mt-3 divide-y divide-pv-ink/[0.08]">
              {data.bySeller.length === 0 && (
                <p className="px-4 py-4 text-sm text-pv-muted">No sellers yet.</p>
              )}
              {data.bySeller.map((s) => (
                <div key={s.seller} className="flex items-center justify-between px-4 py-3.5">
                  <code className="font-mono text-sm text-pv-text">{short(s.seller)}</code>
                  <span className="font-mono text-sm text-pv-muted">
                    {s.calls} calls · {s.usdc.toFixed(6)} USDC
                  </span>
                </div>
              ))}
            </div>
          </section>

          <section className="mt-10">
            <h2 className="label">Recent payments</h2>
            <div className="card mt-3 divide-y divide-pv-ink/[0.06]">
              {data.recent.length === 0 && (
                <p className="px-4 py-4 text-sm text-pv-muted">
                  Nothing yet — payments appear the moment an agent buys a paid endpoint.
                </p>
              )}
              {data.recent.map((e, i) => (
                <PaymentCard key={`${e.transactionHash ?? e.at}-${i}`} event={e} />
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}


function PaymentCard({ event }: { event: PaymentEvent }) {
  return (
    <div className="px-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-pv-muted">
            {new Date(event.at).toLocaleTimeString()}
          </p>
          <code className="mt-1 block break-all font-mono text-sm text-pv-text">
            {event.resource}
          </code>
        </div>
        <span className="shrink-0 font-mono text-sm font-semibold text-pv-text">
          {event.amountUsdc.toFixed(6)} {event.assetSymbol || "USDC"}
        </span>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-1 font-mono text-xs text-pv-muted">
        <span className="min-w-0 truncate">payer {short(event.payer)}</span>
        <span className="min-w-0 truncate">seller {short(event.seller)}</span>
      </div>
      <div className="mt-3 flex items-center justify-end gap-3 font-mono text-xs">
        <ReceiptLink txHash={event.transactionHash} />
      </div>
    </div>
  );
}

function Bar({ className = "" }: { className?: string }) {
  return (
    <div
      className={`animate-shimmer bg-pv-surface2 ${className}`}
      style={{
        backgroundImage:
          "linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.05) 50%, transparent 100%)",
        backgroundSize: "200% 100%",
      }}
    />
  );
}

function RevenueSkeleton() {
  return (
    <div aria-busy className="mt-8" aria-label="Loading revenue">
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="card px-4 py-5">
            <Bar className="h-3 w-24" />
            <Bar className="mt-3 h-7 w-28" />
          </div>
        ))}
      </section>
      <section className="mt-10">
        <Bar className="h-3 w-24" />
        <div className="card mt-3 divide-y divide-pv-ink/[0.08]">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center justify-between px-4 py-3.5">
              <Bar className="h-4 w-40" />
              <Bar className="h-4 w-24" />
            </div>
          ))}
        </div>
      </section>
      <section className="mt-10">
        <Bar className="h-3 w-32" />
        <div className="card mt-3 divide-y divide-pv-ink/[0.06]">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center justify-between px-4 py-3">
              <Bar className="h-4 w-20" />
              <Bar className="h-4 w-32" />
              <Bar className="h-4 w-20" />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="card px-4 py-5">
      <div className="label mb-0">{label}</div>
      <div
        className={`mt-2 font-display text-2xl font-bold tracking-tight ${
          accent ? "text-pv-emerald" : "text-pv-text"
        }`}
      >
        {value}
      </div>
    </div>
  );
}
