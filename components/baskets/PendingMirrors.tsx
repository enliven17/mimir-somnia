"use client";

/**
 * Positions from baskets you follow that you have not copied yet.
 *
 * One click each, signed by the follower. Mimir cannot place these for them: the
 * contract takes the stake from `msg.sender`, and Mimir holds no key for anyone
 * else. Doing it any other way would mean custody, which is exactly what following
 * a basket is designed to avoid.
 *
 * So the queue is the product, not a workaround — and it is the same input a
 * delegated executor would consume once sub-account signing is configured.
 */

import { useCallback, useEffect, useState } from "react";

import { encodeFunctionData } from "viem";

import { useWallet } from "@/lib/wallet";
import { challengeClaim, CONTRACT_ADDRESS } from "@/lib/contract";
import { MIMIR_ABI } from "@/lib/mimir-abi";
import { ERC20_ABI, USDC_ADDRESS, usdcToUnits } from "@/lib/usdc";
import {
  enableOneTapMirroring, readSubAccount, sendFromSubAccount, type SubAccountState,
} from "@/lib/chain-subaccount";

interface Mirror {
  basketId: string;
  basketName: string;
  claimId: number;
  question: string;
  agentId: string;
  agentName: string;
  memberStakeUsdc: number;
  mirrorUsdc: number;
  weightBps: number;
  deadline: number;
}

export function PendingMirrors() {
  const { address, isConnected } = useWallet();
  const [mirrors, setMirrors] = useState<Mirror[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Record<number, string>>({});
  const [subAccount, setSubAccount] = useState<SubAccountState | null>(null);
  const [enabling, setEnabling] = useState(false);

  useEffect(() => { setSubAccount(readSubAccount()); }, []);

  const load = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    try {
      const response = await fetch(`/api/baskets/mirrors?subscriber=${address}`);
      const payload = await response.json();
      setMirrors(Array.isArray(payload.mirrors) ? payload.mirrors : []);
    } catch {
      setMirrors([]);
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => { void load(); }, [load]);

  async function enable() {
    setEnabling(true);
    setError(null);
    try {
      setSubAccount(await enableOneTapMirroring());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(/user rejected|denied/i.test(message) ? "Setup cancelled in your wallet." : message);
    } finally {
      setEnabling(false);
    }
  }

  async function mirror(item: Mirror) {
    setBusyId(item.claimId);
    setError(null);
    try {
      let reference: string;
      if (subAccount) {
        // Approve then stake in one batch. Two separate confirmations is what the
        // sub account exists to avoid, and an approve without its stake leaves an
        // allowance nobody asked for.
        const units = usdcToUnits(item.mirrorUsdc);
        reference = await sendFromSubAccount([
          {
            to: USDC_ADDRESS,
            data: encodeFunctionData({
              abi: ERC20_ABI, functionName: "approve", args: [CONTRACT_ADDRESS, units],
            }),
          },
          {
            to: CONTRACT_ADDRESS,
            data: encodeFunctionData({
              abi: MIMIR_ABI, functionName: "challengeClaim",
              args: [BigInt(item.claimId), units, ""],
            }),
          },
        ]);
      } else {
        const result = await challengeClaim(address!, item.claimId, item.mirrorUsdc);
        reference = result.txHash ?? "sent";
      }
      setDone((current) => ({ ...current, [item.claimId]: reference }));
      // Refresh rather than splice: the queue is derived from chain state, and the
      // authoritative answer to "is it still pending" is the server's.
      void load();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(/user rejected|denied/i.test(message) ? "Transaction rejected in your wallet." : message);
    } finally {
      setBusyId(null);
    }
  }

  if (!isConnected) return null;
  if (!loading && mirrors.length === 0) return null;

  return (
    <section className="border border-pv-emerald/35 bg-pv-emerald/[0.05] p-4">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-mono text-[10px] uppercase tracking-wider text-pv-emerald">
            Waiting to mirror
          </h3>
          <p className="text-[11px] text-pv-muted">
            {subAccount
              ? "One tap each — your sub account signs, and it stays yours."
              : "Baskets you follow took these positions. Each one is a stake you sign — no funds are held on your behalf."}
          </p>
        </div>
        {!subAccount && (
          <button
            type="button"
            onClick={enable}
            disabled={enabling}
            className="shrink-0 border border-pv-emerald/45 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-pv-emerald transition-colors hover:bg-pv-emerald/[0.1] disabled:opacity-40"
          >
            {enabling ? "Setting up…" : "Skip the popups"}
          </button>
        )}
      </div>

      {loading && mirrors.length === 0 && (
        <p className="py-3 text-[12px] text-pv-muted">Checking…</p>
      )}

      <ul className="space-y-2">
        {mirrors.map((item) => (
          <li key={`${item.basketId}-${item.claimId}`}
            className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border border-pv-ink/[0.1] bg-pv-surface/50 px-3 py-2">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] text-pv-text">
                #{item.claimId} {item.question}
              </span>
              <span className="block font-mono text-[10px] text-pv-muted">
                {item.basketName} · {item.agentName} staked {item.memberStakeUsdc.toFixed(2)} · your weight {(item.weightBps / 100).toFixed(0)}%
              </span>
            </span>
            {done[item.claimId] ? (
              <span className="font-mono text-[11px] text-pv-emerald">mirrored ✓</span>
            ) : (
              <button
                type="button"
                onClick={() => mirror(item)}
                disabled={busyId !== null}
                className="btn-compact-primary shrink-0 px-3 py-1.5 text-[12px] disabled:opacity-40"
              >
                {busyId === item.claimId ? "Confirm in wallet…" : `Mirror ${item.mirrorUsdc.toFixed(2)} USDC`}
              </button>
            )}
          </li>
        ))}
      </ul>

      {error && <p className="mt-2 text-[12px] text-pv-danger">{error}</p>}

      <p className="mt-3 text-[11px] text-pv-muted">
        {subAccount
          ? "Delegated accounts are disabled on this network. Mirror orders are signed by your connected wallet."
          : "Enable one-tap signing to skip a wallet prompt per mirror. The key stays in this browser; it is never sent to Mimir."}
      </p>
    </section>
  );
}
