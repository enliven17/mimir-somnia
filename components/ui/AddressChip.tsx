"use client";

/**
 * A wallet address you can actually do something with.
 *
 * A shortened address is unusable on its own: you cannot verify it, paste it, or
 * look it up. Two affordances, both one click — copy the full address, or open it
 * on the explorer.
 *
 * The explorer link is a real anchor rather than a scripted window.open, so
 * middle-click and "open in new tab" behave the way the rest of the web does.
 */

import { Check, Copy, ExternalLink } from "lucide-react";
import { useState } from "react";

import { Link } from "@/i18n/navigation";

import { getExplorerAddressUrl } from "@/lib/chain";
import { shortenAddress } from "@/lib/constants";

export function AddressChip({
  address,
  className = "",
  label,
  linkToProfile = true,
}: {
  address: string;
  className?: string;
  /** Screen-reader context, e.g. "creator". */
  label?: string;
  /**
   * The address itself links to its Mimir profile. The explorer stays as a second
   * icon: "what has this wallet done here" is the question a market page raises,
   * and a list of raw transactions is a poor answer to it.
   *
   * Off on the profile page itself, where the link would point at the page you
   * are already reading.
   */
  linkToProfile?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard blocked (insecure context, permissions): the explorer link still
      // gets the user to the address, so this stays silent rather than alarming.
      setCopied(false);
    }
  }

  return (
    <span className={`inline-flex items-center gap-1 font-mono text-[11px] text-pv-muted ${className}`}>
      {linkToProfile ? (
        <Link
          href={`/profile/${address}`}
          title={`View ${label ? `${label} ` : ""}profile`}
          className="transition-colors hover:text-pv-emerald focus-ring"
        >
          {shortenAddress(address)}
        </Link>
      ) : (
        <span title={address}>{shortenAddress(address)}</span>
      )}
      <button
        type="button"
        onClick={copy}
        title={address}
        aria-label={copied ? "Address copied" : `Copy ${label ? `${label} ` : ""}address ${address}`}
        className="inline-flex items-center transition-colors hover:text-pv-text focus-ring"
      >
        {copied
          ? <Check className="h-3 w-3 text-pv-emerald" aria-hidden />
          : <Copy className="h-3 w-3 opacity-60" aria-hidden />}
      </button>
      <a
        href={getExplorerAddressUrl(address)}
        target="_blank"
        rel="noreferrer"
        aria-label={`Open ${label ? `${label} ` : ""}address on the explorer`}
        className="transition-colors hover:text-pv-emerald focus-ring"
      >
        <ExternalLink className="h-3 w-3" aria-hidden />
      </a>
    </span>
  );
}

/**
 * Just the address, linking to its Mimir profile.
 *
 * For dense rows where the copy and explorer icons would crowd the cell. The
 * profile resolves what the address actually is — an agent, an agent's owner, or
 * a person — so one link answers all three cases and the caller does not need a
 * directory lookup to decide where to point.
 */
export function ProfileLink({
  address, className = "", children,
}: {
  address: string;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <Link
      href={`/profile/${address}`}
      title={`View profile ${address}`}
      className={`transition-colors hover:text-pv-emerald hover:underline focus-ring ${className}`}
    >
      {children ?? shortenAddress(address)}
    </Link>
  );
}
