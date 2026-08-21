/**
 * wagmi config for Mimir on Somnia Shannon testnet
 *
 * Supports: standard wallet, MetaMask, Coinbase Wallet, Rainbow, Phantom, Trust,
 * Brave, any EIP-6963 injected wallet, and WalletConnect QR (380+ mobile
 * wallets). Connect UX is a lightweight picker in lib/wallet.tsx (wagmi v3).
 *
 * Only chain: Somnia Shannon testnet (50312). Gas in STT, stakes in USDC.
 */
import { createConfig, http } from "wagmi";
// Import from wagmi's own re-export so connector types match createConfig (wagmi v3).
import { coinbaseWallet } from "wagmi/connectors/coinbaseWallet";
import { injected } from "wagmi/connectors/injected";
import { metaMask } from "wagmi/connectors/metaMask";
import { walletConnect } from "wagmi/connectors/walletConnect";
import { somniaShannon, getSomniaRpcUrl } from "./chain";

// WalletConnect Cloud project id — get one free at https://cloud.walletconnect.com.
// When the var is missing we skip the walletconnect connector so local dev still
// works; the connect modal just won't show the QR option until it's set.
const WC_PROJECT_ID = process.env.NEXT_PUBLIC_WC_PROJECT_ID?.trim();

const APP_METADATA = {
  name:        "Mimir",
  description: "AI-settled event markets on Somnia",
  url:         "https://mimir.app",
  icons:       ["https://mimir.app/logo.png"],
};

export const wagmiConfig = createConfig({
  chains: [somniaShannon],
  connectors: [
    metaMask(),
    coinbaseWallet({
      appName:    APP_METADATA.name,
      appLogoUrl: APP_METADATA.icons[0],
    }),
    // EIP-6963 discovery picks up Phantom, Rainbow, Trust, Brave, OKX, etc.
    // automatically — no per-wallet config needed.
    injected({ shimDisconnect: true }),
    ...(WC_PROJECT_ID
      ? [walletConnect({
          projectId:    WC_PROJECT_ID,
          metadata:     APP_METADATA,
          showQrModal:  true,
        })]
      : []),
  ],
  // JSON-RPC batching + retry keeps the browser from getting throttled
  // (HTTP 429) when wagmi's react-query layer fans out useReadContract calls
  // — every claim card on the feed page would otherwise issue its own POST.
  transports: {
    [somniaShannon.id]: http(getSomniaRpcUrl(), {
      batch: { batchSize: 200, wait: 16 },
      retryCount: 3,
      retryDelay: 300,
      timeout: 20_000,
    }),
  },
  ssr: true,
});
