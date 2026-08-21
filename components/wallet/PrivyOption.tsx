"use client";

/**
 * The Privy door in the connect modal.
 *
 * Its own component because `usePrivy` throws outside a PrivyProvider, and the
 * provider is conditional on an app id being configured. Hooks cannot be called
 * conditionally, so the condition lives at the component boundary instead: the
 * modal renders this only when Privy is configured, and this file is the only
 * place that touches Privy's hooks.
 */

import { usePrivy } from "@privy-io/react-auth";
import { Mail } from "lucide-react";

export function PrivyOption({ onOpened }: { onOpened?: () => void }) {
  const { ready, authenticated, login } = usePrivy();

  return (
    <button
      type="button"
      disabled={!ready}
      onClick={() => {
        login();
        // Close our modal as Privy's opens: two stacked dialogs is a trap for
        // anyone using Escape or a screen reader.
        onOpened?.();
      }}
      className="flex w-full items-center gap-3 border border-pv-emerald/45 bg-pv-emerald/[0.08] px-4 py-3 text-left transition-colors duration-150 hover:border-pv-emerald hover:bg-pv-emerald/[0.14] disabled:opacity-50"
    >
      <span
        aria-hidden
        className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-pv-emerald/40 bg-pv-emerald/[0.12]"
      >
        <Mail className="h-3.5 w-3.5 text-pv-emerald" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-pv-text">
            {authenticated ? "Continue with Privy" : "Email or social"}
          </span>
          <span className="shrink-0 border border-pv-emerald/40 px-1.5 py-px font-mono text-[9px] font-bold uppercase tracking-wider text-pv-emerald">
            no wallet needed
          </span>
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-pv-muted">
          {ready ? "Google, Farcaster or email — a wallet is created for you" : "Loading…"}
        </span>
      </span>
    </button>
  );
}
