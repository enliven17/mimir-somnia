import { getExplorerAddressUrl } from "@/lib/chain";
import { DREAMDEX_ADDRESSES, DREAMDEX_NETWORK } from "@/lib/dreamdex";

export default function DocsPage() {
  return (
    <main className="mx-auto max-w-4xl px-6 py-16 text-pv-text">
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-pv-emerald">MIMIR / DOCS</p>
      <h1 className="mt-3 font-display text-4xl font-bold">Event markets on Somnia</h1>
      <p className="mt-5 max-w-2xl text-pv-muted">
        Mimir reads and trades binary Event Contracts through DreamDEX on the
        Somnia Shannon testnet. Wallets sign directly; workers keep their own
        keys in process environment variables.
      </p>

      <section className="mt-10 grid gap-4 sm:grid-cols-2">
        <article className="border border-pv-border/40 bg-pv-surface p-5">
          <h2 className="font-display text-xl font-semibold">Network</h2>
          <dl className="mt-4 space-y-2 font-mono text-sm text-pv-muted">
            <div className="flex justify-between gap-4"><dt>Chain</dt><dd>Somnia Shannon</dd></div>
            <div className="flex justify-between gap-4"><dt>Chain ID</dt><dd>{DREAMDEX_NETWORK.replace("eip155:", "")}</dd></div>
            <div className="flex justify-between gap-4"><dt>Gas</dt><dd>STT</dd></div>
            <div className="flex justify-between gap-4"><dt>Venue</dt><dd>DreamDEX</dd></div>
          </dl>
        </article>
        <article className="border border-pv-border/40 bg-pv-surface p-5">
          <h2 className="font-display text-xl font-semibold">SDK surface</h2>
          <p className="mt-4 text-sm leading-6 text-pv-muted">
            Discover live markets, read order books, place IOC or resting
            orders, mint and merge complete sets, and redeem after settlement.
          </p>
        </article>
      </section>

      <section className="mt-10 border border-pv-border/40 bg-pv-surface p-5">
        <h2 className="font-display text-xl font-semibold">Configuration</h2>
        <pre className="mt-4 overflow-x-auto rounded bg-pv-bg p-4 font-mono text-xs text-pv-muted">{`NEXT_PUBLIC_SOMNIA_RPC_URL=https://dream-rpc.somnia.network
SOMNIA_WS_URL=wss://dream-rpc.somnia.network/ws
DREAMDEX_INDEXER_URL=https://dev.smk.somnia.host/v1/graphql
X402_NETWORK=eip155:50312`}</pre>
      </section>

      <section className="mt-10 border border-pv-border/40 bg-pv-surface p-5">
        <h2 className="font-display text-xl font-semibold">Protocol addresses</h2>
        <div className="mt-4 grid gap-3 text-xs sm:grid-cols-2">
          {Object.entries({
            Collateral: DREAMDEX_ADDRESSES.collateral,
            BinaryModule: DREAMDEX_ADDRESSES.binaryModule,
            MarketCreator: DREAMDEX_ADDRESSES.marketCreator,
          }).map(([label, address]) => (
            address ? (
              <a key={label} className="rounded border border-pv-border/30 p-3 text-pv-muted hover:border-pv-emerald/40" href={getExplorerAddressUrl(address)} target="_blank" rel="noreferrer">
                <span className="block font-semibold text-pv-text">{label}</span>
                <span className="mt-1 block break-all font-mono">{address}</span>
              </a>
            ) : null
          ))}
        </div>
        <a className="mt-5 inline-block btn-compact-primary px-4 py-2 text-sm" href="/markets">Open Markets</a>
      </section>
    </main>
  );
}
