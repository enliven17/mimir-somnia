/**
 * Connector list shaping for the connect modal — ordering, dedupe and labels.
 *
 * Pure and separate from the React tree so the rules that decide what a user sees
 * first can be tested without a browser or an injected provider.
 *
 * Matching is on id/name substrings rather than exact connector ids: those ids are
 * wagmi/SDK implementation details (`coinbaseWalletSDK`, `io.metamask`, an EIP-6963
 * rdns) and they change between versions, while a wrong match here silently demotes
 * the wallet we most want people to use.
 */

export interface ConnectorInput {
  id: string;
  name: string;
  /** wagmi/EIP-6963 supplies a data-URI brand mark for most wallets. */
  icon?: string;
  type?: string;
}

export type ConnectorKind = "walletConnect" | "injected" | "sdk";

export interface ShapedConnector extends ConnectorInput {
  kind: ConnectorKind;
  /** The wallet is installed in this browser and can connect without a QR. */
  detected: boolean;
  /** Last wallet this browser connected with. */
  recent: boolean;
  /** Monogram shown when the connector ships no icon. */
  monogram: string;
}

function haystack(c: ConnectorInput): string {
  return `${c.id} ${c.name}`.toLowerCase();
}

export function kindOf(c: ConnectorInput): ConnectorKind {
  const h = haystack(c);
  if (h.includes("walletconnect")) return "walletConnect";
  if (c.type === "injected") return "injected";
  return "sdk";
}

/** A wallet actually present in this browser, as opposed to a QR or SDK fallback. */
export function isDetected(c: ConnectorInput): boolean {
  // The generic `injected()` entry is a catch-all with no discovered provider
  // behind it; every other injected connector came from EIP-6963 discovery,
  // which only reports wallets that are installed.
  return c.type === "injected" && c.id !== "injected";
}

function monogramFor(name: string): string {
  const letter = name.trim().replace(/^the\s+/i, "").charAt(0);
  return (letter || "?").toUpperCase();
}

/** Sort weight: standard wallet, then the wallet you used last, then the rest, QR last. */
function rank(c: ShapedConnector): number {
  if (c.recent) return 0;
  if (c.kind === "walletConnect") return 3;
  if (c.detected) return 1;
  return 2;
}

/**
 * Shape the raw wagmi connector list for display.
 *
 * Dedupes by wallet name: `metaMask()` and the EIP-6963 discovery of the same
 * extension both appear in wagmi's list, and two MetaMask rows make the modal look
 * broken. The detected one wins, since it connects without an SDK round-trip.
 */
export function shapeConnectors(
  connectors: readonly ConnectorInput[],
  opts: { recentId?: string | null } = {},
): ShapedConnector[] {
  const byName = new Map<string, ShapedConnector>();

  for (const c of connectors) {
    const shaped: ShapedConnector = {
      ...c,
      kind: kindOf(c),
      detected: isDetected(c),
      recent: Boolean(opts.recentId) && c.id === opts.recentId,
      monogram: monogramFor(c.name),
    };
    const key = shaped.name.trim().toLowerCase();
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, shaped);
      continue;
    }
    // Keep whichever row can connect directly, and never lose a `recent` flag or
    // an icon just because the duplicate happened to arrive second.
    const winner = shaped.detected && !existing.detected ? shaped : existing;
    byName.set(key, {
      ...winner,
      recent: existing.recent || shaped.recent,
      icon: winner.icon ?? existing.icon ?? shaped.icon,
    });
  }

  return [...byName.values()].sort((a, b) => rank(a) - rank(b));
}

/** Row label for the QR entry: it is a gateway to many wallets, not one wallet. */
export function labelFor(c: ShapedConnector): string {
  return c.kind === "walletConnect" ? "Scan QR" : c.name;
}

export function subtitleFor(c: ShapedConnector): string | null {
  if (c.kind === "walletConnect") return "380+ mobile wallets";
  return null;
}
