import { getContractAddress, getExplorerAddressUrl } from "@/lib/chain";

export default function DocsPage() {
  const contract = getContractAddress();
  const contractConfigured = contract !== "0x0000000000000000000000000000000000000000";

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
            <div className="flex justify-between gap-4"><dt>Chain ID</dt><dd>50312</dd></div>
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
        <h2 className="font-display text-xl font-semibold">Explorer</h2>
        {contractConfigured ? (
          <a className="mt-3 inline-block text-pv-emerald underline" href={getExplorerAddressUrl(contract)}>
            View configured contract
          </a>
        ) : (
          <p className="mt-3 text-sm text-pv-muted">Set the contract address when a deployment is available.</p>
        )}
      </section>
    </main>
  );
}
