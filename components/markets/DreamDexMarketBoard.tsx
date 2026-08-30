"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWalletClient } from "wagmi";
import { createExchange } from "@/lib/dreamdex";
import type { SomniaMarkets } from "@somnia-chain/markets-sdk";
import type { DreamDexMarket, DreamDexOrderBook, DreamDexPortfolio } from "@/lib/dreamdex-market";
import { useWallet } from "@/lib/wallet";

type OrderSide = "buy" | "sell";
type Action = "order" | "mint" | "burn" | "redeem";

function formatTime(seconds: number) {
  if (!seconds) return "—";
  return new Date(seconds * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatProbability(value: number | null | undefined) {
  return value === null || value === undefined ? "—" : `${(value * 100).toFixed(2)}%`;
}

function actionHash(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const hash = (value as { hash?: unknown }).hash;
  return typeof hash === "string" ? hash : null;
}

export default function DreamDexMarketBoard() {
  const { address, isConnected, connect } = useWallet();
  const { data: walletClient } = useWalletClient();
  const exchangeRef = useRef<SomniaMarkets | null>(null);
  const [markets, setMarkets] = useState<DreamDexMarket[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [outcome, setOutcome] = useState<"YES" | "NO">("YES");
  const [book, setBook] = useState<DreamDexOrderBook | null>(null);
  const [portfolio, setPortfolio] = useState<DreamDexPortfolio | null>(null);
  const [side, setSide] = useState<OrderSide>("buy");
  const [type, setType] = useState<"limit" | "market">("limit");
  const [amount, setAmount] = useState("1");
  const [price, setPrice] = useState("0.5");
  const [busy, setBusy] = useState<Action | "book" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const selected = useMemo(
    () => markets.find((market) => market.id === selectedId) ?? null,
    [markets, selectedId],
  );

  const loadMarkets = useCallback(async () => {
    const response = await fetch("/api/markets?limit=100", { cache: "no-store" });
    if (!response.ok) throw new Error("Market list unavailable");
    const payload = await response.json() as { items?: DreamDexMarket[] };
    const items = payload.items ?? [];
    setMarkets(items);
    setSelectedId((current) => current || items[0]?.id || "");
  }, []);

  const loadBook = useCallback(async (marketId: string, selectedOutcome: "YES" | "NO") => {
    if (!marketId) return;
    setBusy("book");
    try {
      const response = await fetch(
        `/api/markets/${encodeURIComponent(marketId)}?outcome=${selectedOutcome}&depth=20`,
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error("Order book unavailable");
      const payload = await response.json() as { orderBook?: DreamDexOrderBook | null };
      setBook(payload.orderBook ?? null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Order book unavailable");
    } finally {
      setBusy(null);
    }
  }, []);

  const loadPortfolio = useCallback(async (walletAddress: string) => {
    const response = await fetch(`/api/portfolio/${walletAddress}`, { cache: "no-store" });
    if (!response.ok) throw new Error("Portfolio unavailable");
    const payload = await response.json() as { item?: DreamDexPortfolio };
    setPortfolio(payload.item ?? null);
  }, []);

  useEffect(() => {
    void loadMarkets().catch((error) => setNotice(error instanceof Error ? error.message : "Market list unavailable"));
  }, [loadMarkets]);

  useEffect(() => {
    void loadBook(selectedId, outcome);
  }, [loadBook, selectedId, outcome]);

  useEffect(() => {
    if (!address) {
      setPortfolio(null);
      return;
    }
    void loadPortfolio(address).catch(() => setPortfolio(null));
  }, [address, loadPortfolio]);

  useEffect(() => {
    if (!exchangeRef.current) exchangeRef.current = createExchange();
    if (walletClient) {
      exchangeRef.current.setSigner({ walletClient });
    } else {
      exchangeRef.current.setSigner({});
    }
    return () => undefined;
  }, [walletClient]);

  useEffect(() => () => {
    void exchangeRef.current?.close();
  }, []);

  async function runAction(action: Action) {
    if (!selected) return;
    if (!isConnected || !walletClient) {
      await connect();
      setNotice("Wallet connected. Confirm the action again.");
      return;
    }

    const quantity = Number(amount);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setNotice("Amount must be greater than zero.");
      return;
    }

    setBusy(action);
    setNotice(null);
    try {
      const exchange = exchangeRef.current ?? createExchange();
      exchangeRef.current = exchange;
      exchange.setSigner({ walletClient });
      await exchange.loadMarkets();
      const unified = Object.values(exchange.markets).find((item) => item.info.id.toLowerCase() === selected.id.toLowerCase());
      if (!unified) throw new Error("Selected market is no longer indexed");

      let result: unknown;
      if (action === "order") {
        const symbol = outcome === "YES"
          ? selected.yesSymbol
          : selected.noSymbol;
        const numericPrice = Number(price);
        if (type === "limit" && (!Number.isFinite(numericPrice) || numericPrice <= 0 || numericPrice >= 1)) {
          throw new Error("Limit price must be between 0 and 1");
        }
        result = await exchange.createOrder(symbol, type, side, quantity, type === "limit" ? numericPrice : undefined);
      } else if (action === "mint") {
        result = await exchange.mintSet(unified.symbol, quantity);
      } else if (action === "burn") {
        result = await exchange.burnSet(unified.symbol, quantity);
      } else {
        result = await exchange.redeem(unified.symbol, quantity);
      }

      const hash = actionHash(result);
      setNotice(hash ? `Confirmed: ${hash}` : "Transaction confirmed.");
      await loadBook(selected.id, outcome);
      if (address) await loadPortfolio(address);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Transaction failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-[1240px] space-y-5 px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div>
          <p className="font-mono text-[11px] font-bold uppercase tracking-[0.2em] text-pv-emerald">DreamDEX markets</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight text-pv-text">Trade live event contracts</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-pv-muted">Discover indexed binary markets, inspect the YES/NO book, and execute with your connected wallet.</p>
        </div>
        <button type="button" onClick={() => void loadMarkets()} className="btn-compact-secondary self-start sm:self-auto">Refresh markets</button>
      </div>

      {notice ? <div className="rounded-xl border border-pv-emerald/30 bg-pv-emerald/[0.08] px-4 py-3 text-xs text-pv-text break-all">{notice}</div> : null}

      <div className="grid gap-5 lg:grid-cols-[minmax(260px,0.8fr)_minmax(0,1.4fr)]">
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-lg font-bold text-pv-text">Available markets</h2>
            <span className="font-mono text-[11px] text-pv-muted">{markets.length} indexed</span>
          </div>
          <div className="max-h-[650px] space-y-2 overflow-y-auto pr-1">
            {markets.map((market) => (
              <button
                key={market.id}
                type="button"
                onClick={() => setSelectedId(market.id)}
                className={`w-full rounded-2xl border p-4 text-left transition-colors ${selectedId === market.id ? "border-pv-emerald/60 bg-pv-emerald/[0.08]" : "border-pv-border/40 bg-pv-surface/50 hover:border-pv-emerald/30"}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="text-sm font-semibold leading-5 text-pv-text">{market.question || market.symbol}</span>
                  <span className="shrink-0 rounded-full border border-pv-border/50 px-2 py-0.5 font-mono text-[10px] uppercase text-pv-muted">{market.status}</span>
                </div>
                <div className="mt-3 flex items-center justify-between font-mono text-[11px] text-pv-muted">
                  <span>{market.asset} · {formatProbability(market.lastPrice)}</span>
                  <span>ends {formatTime(market.expiry)}</span>
                </div>
              </button>
            ))}
            {!markets.length ? <div className="rounded-2xl border border-dashed border-pv-border/50 p-6 text-sm text-pv-muted">No active markets returned by the indexer.</div> : null}
          </div>
        </section>

        <section className="space-y-5">
          {selected ? (
            <>
              <div className="rounded-2xl border border-pv-border/40 bg-pv-surface/60 p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-pv-muted">{selected.symbol} · {selected.asset}</p>
                    <h2 className="mt-2 text-xl font-bold leading-7 text-pv-text">{selected.question}</h2>
                  </div>
                  <span className="rounded-full border border-pv-emerald/30 bg-pv-emerald/[0.08] px-2.5 py-1 font-mono text-[10px] uppercase text-pv-emerald">{selected.status}</span>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
                  <div><span className="block text-pv-muted">YES mark</span><span className="font-mono text-pv-text">{formatProbability(selected.lastPrice)}</span></div>
                  <div><span className="block text-pv-muted">Volume</span><span className="font-mono text-pv-text">{selected.volume.toFixed(3)}</span></div>
                  <div><span className="block text-pv-muted">Opens</span><span className="font-mono text-pv-text">{formatTime(selected.tradingStart)}</span></div>
                  <div><span className="block text-pv-muted">Expires</span><span className="font-mono text-pv-text">{formatTime(selected.expiry)}</span></div>
                </div>
              </div>

              <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(280px,0.8fr)]">
                <div className="rounded-2xl border border-pv-border/40 bg-pv-surface/60 p-5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex gap-1 rounded-xl border border-pv-border/40 p-1">
                      {(["YES", "NO"] as const).map((value) => <button key={value} type="button" onClick={() => setOutcome(value)} className={`rounded-lg px-3 py-1.5 font-mono text-[11px] ${outcome === value ? "bg-pv-emerald text-white" : "text-pv-muted"}`}>{value}</button>)}
                    </div>
                    <button type="button" onClick={() => void loadBook(selected.id, outcome)} className="font-mono text-[11px] text-pv-muted hover:text-pv-text">{busy === "book" ? "loading…" : "refresh book"}</button>
                  </div>
                  <div className="mt-5 grid grid-cols-2 gap-4 font-mono text-xs">
                    <div><p className="mb-2 text-pv-muted">Bids</p>{book?.bids.slice(0, 10).map(([levelPrice, levelAmount], index) => <div key={`${levelPrice}-${index}`} className="flex justify-between border-b border-pv-border/20 py-1.5 text-pv-text"><span className="text-pv-emerald">{levelPrice.toFixed(4)}</span><span>{levelAmount.toFixed(4)}</span></div>)}</div>
                    <div><p className="mb-2 text-pv-muted">Asks</p>{book?.asks.slice(0, 10).map(([levelPrice, levelAmount], index) => <div key={`${levelPrice}-${index}`} className="flex justify-between border-b border-pv-border/20 py-1.5 text-pv-text"><span className="text-rose-400">{levelPrice.toFixed(4)}</span><span>{levelAmount.toFixed(4)}</span></div>)}</div>
                  </div>
                </div>

                <div className="space-y-3 rounded-2xl border border-pv-border/40 bg-pv-surface/60 p-5">
                  <div className="flex items-center justify-between"><h3 className="font-display text-lg font-bold text-pv-text">Execution</h3><span className="font-mono text-[10px] text-pv-muted">{address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "wallet required"}</span></div>
                  <div className="grid grid-cols-2 gap-2">
                    <select value={side} onChange={(event) => setSide(event.target.value as OrderSide)} className="select-field-pv"><option value="buy">Buy</option><option value="sell">Sell</option></select>
                    <select value={type} onChange={(event) => setType(event.target.value as "limit" | "market")} className="select-field-pv"><option value="limit">Limit</option><option value="market">Market</option></select>
                  </div>
                  <label className="block text-xs text-pv-muted">Outcome<input value={outcome} readOnly className="input mt-1 w-full" /></label>
                  <label className="block text-xs text-pv-muted">Amount<input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} className="input mt-1 w-full" /></label>
                  {type === "limit" ? <label className="block text-xs text-pv-muted">Price<input inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)} className="input mt-1 w-full" /></label> : null}
                  <button type="button" disabled={busy !== null} onClick={() => void runAction("order")} className="btn-compact-primary w-full disabled:opacity-50">{busy === "order" ? "Confirming…" : isConnected ? "Place order" : "Connect wallet"}</button>
                  <div className="grid grid-cols-3 gap-2 border-t border-pv-border/30 pt-3">
                    <button type="button" disabled={busy !== null} onClick={() => void runAction("mint")} className="btn-compact-secondary text-[11px] disabled:opacity-50">Mint set</button>
                    <button type="button" disabled={busy !== null} onClick={() => void runAction("burn")} className="btn-compact-secondary text-[11px] disabled:opacity-50">Burn set</button>
                    <button type="button" disabled={busy !== null || selected.winningOutcome === null} onClick={() => void runAction("redeem")} className="btn-compact-secondary text-[11px] disabled:opacity-50">Redeem</button>
                  </div>
                </div>
              </div>
            </>
          ) : <div className="rounded-2xl border border-dashed border-pv-border/50 p-8 text-sm text-pv-muted">Select a market to inspect its book.</div>}
        </section>
      </div>

      {address ? (
        <section className="rounded-2xl border border-pv-border/40 bg-pv-surface/60 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><h2 className="font-display text-lg font-bold text-pv-text">Your DreamDEX portfolio</h2><p className="mt-1 font-mono text-[11px] text-pv-muted">{portfolio?.address ?? address}</p></div>
            <button type="button" onClick={() => void loadPortfolio(address)} className="btn-compact-secondary text-[11px]">Refresh portfolio</button>
          </div>
          <div className="mt-4 grid gap-4 lg:grid-cols-[0.8fr_1.2fr]">
            <div><p className="mb-2 text-xs text-pv-muted">Balances</p><div className="flex flex-wrap gap-2">{portfolio?.balances.filter((balance) => balance.total > 0).slice(0, 12).map((balance) => <span key={balance.code} className="rounded-lg border border-pv-border/30 px-2.5 py-1.5 font-mono text-[11px] text-pv-text">{balance.code}: {balance.total.toFixed(4)}</span>)}{!portfolio?.balances.some((balance) => balance.total > 0) ? <span className="text-xs text-pv-muted">No indexed balances yet.</span> : null}</div></div>
            <div><p className="mb-2 text-xs text-pv-muted">Recent orders</p><div className="space-y-1.5">{portfolio?.orders.slice(0, 5).map((order) => <div key={`${order.id}-${order.timestamp ?? 0}`} className="flex flex-wrap justify-between gap-2 rounded-lg border border-pv-border/20 px-3 py-2 font-mono text-[11px] text-pv-text"><span>{order.side} {order.outcome ?? "—"} · {order.market}</span><span className="text-pv-muted">{order.status} · {order.amount.toFixed(4)}</span></div>)}{!portfolio?.orders.length ? <span className="text-xs text-pv-muted">No orders indexed yet.</span> : null}</div></div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
