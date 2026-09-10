"use client";

/**
 * Wallet context.
 *
 * Connecting is Privy's job, not ours. There used to be a hand-rolled picker
 * here — a "more wallets" disclosure over wagmi's connectors — and it failed in
 * the one way a connect dialog must not: the rows it listed as DETECTED
 * (SubWallet, Phantom, an injected provider that is not on Somnia) answered
 * `Could not connect. Try another wallet.` with no way forward. Privy already
 * ships the picker we were reimplementing, and it is the piece that knows how
 * to hand an EIP-1193 provider the Somnia Shannon chain, so `connect()` opens
 * Privy directly and there is no second dialog to keep in sync.
 *
 * Privy also carries the users who arrive without a wallet at all (email,
 * Google, Farcaster — an embedded wallet is created for them), which is why it
 * was already a dependency.
 *
 * Either way the app talks to the chain through wagmi: Privy drives wagmi via
 * its own WagmiProvider, so `useAccount` and friends work whichever door the
 * user came through.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  useAccount,
  useConnect,
  useDisconnect,
  useSwitchChain,
} from "wagmi";
import { usePrivy } from "@privy-io/react-auth";

import { somniaShannon } from "./chain";
import { isPrivyConfigured } from "./wagmi-providers";

interface WalletCtx {
  address: string | null;
  isConnected: boolean;
  isConnecting: boolean;
  isCorrectNetwork: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  switchNetwork: () => Promise<void>;
  error: string | null;
}

const Ctx = createContext<WalletCtx>({
  address: null,
  isConnected: false,
  isConnecting: false,
  isCorrectNetwork: true,
  connect: async () => {},
  disconnect: () => {},
  switchNetwork: async () => {},
  error: null,
});

/**
 * The wagmi half, shared by both providers below: address, network state and
 * the auto-switch to Somnia Shannon. `openConnect` and `closeSession` are what
 * differ between the Privy and no-Privy builds.
 */
function useWalletValue(
  openConnect: () => void,
  closeSession: () => void,
  connecting: boolean,
  error: string | null,
): WalletCtx {
  const { address, isConnected, chain } = useAccount();
  const { switchChain } = useSwitchChain();

  const isCorrectNetwork = !chain || chain.id === somniaShannon.id;

  // Auto-switch the wallet to Somnia Shannon on connect. Attempted once per
  // connection: retrying a switch the user just rejected only re-prompts them.
  const autoSwitchAttempted = useRef(false);
  useEffect(() => {
    if (!isConnected || !chain) {
      autoSwitchAttempted.current = false;
      return;
    }
    if (chain.id === somniaShannon.id) return;
    if (autoSwitchAttempted.current) return;
    autoSwitchAttempted.current = true;
    try {
      switchChain({ chainId: somniaShannon.id });
    } catch {
      /* user rejected */
    }
  }, [isConnected, chain, switchChain]);

  const connect = useCallback(async () => {
    openConnect();
  }, [openConnect]);

  const switchNetwork = useCallback(async () => {
    switchChain({ chainId: somniaShannon.id });
  }, [switchChain]);

  return useMemo(
    () => ({
      address: address ?? null,
      isConnected,
      isConnecting: connecting,
      isCorrectNetwork,
      connect,
      disconnect: closeSession,
      switchNetwork,
      error,
    }),
    [address, isConnected, connecting, isCorrectNetwork, connect, closeSession, switchNetwork, error],
  );
}

/** Privy build: `connect()` opens Privy's own dialog. */
function PrivyWalletProvider({ children }: { children: React.ReactNode }) {
  const { ready, authenticated, login, logout } = usePrivy();
  const { disconnect } = useDisconnect();
  const { isConnected } = useAccount();
  const [loggingIn, setLoggingIn] = useState(false);

  // Privy's dialog reports no "closed" event, so the pending flag is cleared by
  // the outcome instead: connected, or authenticated-without-a-wallet.
  useEffect(() => {
    if (isConnected || authenticated) setLoggingIn(false);
  }, [isConnected, authenticated]);

  const openConnect = useCallback(() => {
    if (!ready) return;
    setLoggingIn(true);
    login();
  }, [ready, login]);

  // Both halves, or the next connect finds a live Privy session and silently
  // reconnects the wallet the user just asked to leave.
  const closeSession = useCallback(() => {
    disconnect();
    if (authenticated) void logout();
  }, [disconnect, authenticated, logout]);

  const value = useWalletValue(openConnect, closeSession, loggingIn, null);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * No-Privy build (local checkouts and previews without an app id): connect the
 * one injected wallet through wagmi, since there is no dialog to open.
 */
function InjectedWalletProvider({ children }: { children: React.ReactNode }) {
  const { connect, connectors, isPending, error: connectError, reset } = useConnect();
  const { disconnect } = useDisconnect();

  const openConnect = useCallback(() => {
    reset();
    const injected = connectors.find((c) => c.type === "injected") ?? connectors[0];
    if (injected) connect({ connector: injected });
  }, [connect, connectors, reset]);

  const error = connectError
    ? connectError.message.toLowerCase().includes("reject")
      ? "rejected"
      : "error"
    : null;

  const value = useWalletValue(openConnect, disconnect, isPending, error);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  // `usePrivy` throws outside a PrivyProvider and the provider is conditional on
  // an app id, so the condition lives at the component boundary rather than
  // around a hook call. The app id is a build-time constant, so which branch
  // renders never changes between renders.
  return isPrivyConfigured() ? (
    <PrivyWalletProvider>{children}</PrivyWalletProvider>
  ) : (
    <InjectedWalletProvider>{children}</InjectedWalletProvider>
  );
}

export function useWallet() {
  return useContext(Ctx);
}
